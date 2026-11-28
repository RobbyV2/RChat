use std::marker::PhantomData;

use super::ServerAccess;
use super::perms::Perm;
use crate::api::ApiError;
use crate::api::audit::Actor;
use crate::db::Db;

mod sealed {
    pub trait Sealed {}
}

/// A server permission as a type, so a write can say which grant it needs.
pub trait Bit: sealed::Sealed {
    const PERM: Perm;
}

macro_rules! bits {
    ($($name:ident),* $(,)?) => {
        $(
            pub enum $name {}
            impl sealed::Sealed for $name {}
            impl Bit for $name {
                const PERM: Perm = Perm::$name;
            }
        )*
    };
}

bits!(
    ManageChannels,
    DeleteMessages,
    Kick,
    DeleteServer,
    ManageAdmins,
    MentionEveryone,
    ViewAuditLog,
    TimeoutMembers,
    ManageWebhooks,
    ManageReports,
    ManageServer,
    ManageInvites,
    ManageRoles,
    AssignRoles,
    ManageProfiles,
    PinMessages,
    BypassSlowmode,
);

/// The decision that the viewer holds `B` in a server now, with who the audit log names for it.
/// Only `ServerAccess::grant` makes one.
pub struct Granted<'a, B: Bit> {
    access: &'a ServerAccess,
    actor: Actor,
    _bit: PhantomData<fn() -> B>,
}

/// The decision that the viewer may use `B` on the member `target`: a grant, and a rank above
/// them. Only `Granted::moderate` makes one.
pub struct Moderated<'a, B: Bit> {
    granted: &'a Granted<'a, B>,
    target: String,
    actor: Actor,
}

impl ServerAccess {
    /// Holding `B` here: the permission (a timeout takes it away) and the audit actor, who is
    /// the unnamed staff when only instance powers pass.
    pub async fn grant<B: Bit>(&self, db: &Db) -> Result<Granted<'_, B>, ApiError> {
        self.require_perm(db, B::PERM).await?;
        let actor = self.audit_actor(db, B::PERM).await?;
        Ok(Granted {
            access: self,
            actor,
            _bit: PhantomData,
        })
    }
}

impl<'a, B: Bit> Granted<'a, B> {
    pub fn access(&self) -> &'a ServerAccess {
        self.access
    }

    pub fn server(&self) -> &'a str {
        self.access.name()
    }

    pub fn actor(&self) -> &Actor {
        &self.actor
    }

    /// Using `B` on `target`, whom the viewer must rank above. Logged as staff when only
    /// instance powers rank above them.
    pub async fn moderate(&self, db: &Db, target: &str) -> Result<Moderated<'_, B>, ApiError> {
        self.access.require_moderate(db, target).await?;
        let bypassed = self
            .access
            .bypassed(|m| async move {
                m.require_perm(db, B::PERM).await?;
                m.require_moderate(db, target).await
            })
            .await;
        Ok(Moderated {
            granted: self,
            target: target.to_string(),
            actor: self.actor.clone().staff_if(bypassed),
        })
    }
}

impl<'a, B: Bit> Moderated<'a, B> {
    pub fn access(&self) -> &'a ServerAccess {
        self.granted.access
    }

    pub fn server(&self) -> &'a str {
        self.granted.server()
    }

    pub fn target(&self) -> &str {
        &self.target
    }

    pub fn actor(&self) -> &Actor {
        &self.actor
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::access::{Proof, resolve_server};
    use crate::api::test_util::{add_member, done, mem_user, temp_state};

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    #[tokio::test]
    async fn grants_follow_the_bit_the_timeout_and_instance_powers() {
        let (state, path) = temp_state("grants").await;
        let db = &state.db;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 0)").await;
        for name in ["alice", "bob", "carol", "dave", "root"] {
            crate::db::NewUser::plain(name).add(db).await;
        }
        add_member(db, "club", "alice", 1, 0, 0).await;
        for name in ["bob", "carol", "dave", "root"] {
            add_member(db, "club", name, 0, 0, 0).await;
        }
        exec(db, &format!("INSERT INTO roles(id, server, name, color, perms, position) VALUES(70, 'club', 'mods', '#ffffff', {}, 1)", Perm::Kick as i64)).await;
        exec(db, "INSERT INTO user_roles(server, username, role_id) VALUES('club', 'bob', 70), ('club', 'dave', 70)").await;
        exec(db, "INSERT INTO member_timeouts(server, username, until, set_by, created_at) VALUES('club', 'dave', 9999999999, 'alice', 0)").await;
        let kick = async |name: &str, admin: bool| {
            let user = mem_user(name, admin);
            let access = resolve_server(db, "club", Some(&user), &Proof::none())
                .await
                .expect("member");
            access
                .grant::<Kick>(db)
                .await
                .map(|g| g.actor().clone())
                .map_err(|e| e.1)
        };
        assert_eq!(kick("alice", false).await, Ok(Actor::User("alice".into())));
        assert_eq!(kick("bob", false).await, Ok(Actor::User("bob".into())));
        assert_eq!(kick("carol", false).await, Err("Missing permission".into()));
        assert_eq!(
            kick("dave", false).await,
            Err(crate::api::access::TIMED_OUT.into())
        );
        assert_eq!(kick("root", true).await, Ok(Actor::Staff));

        let alice = mem_user("alice", false);
        let access = resolve_server(db, "club", Some(&alice), &Proof::none())
            .await
            .expect("alice");
        let granted = access.grant::<Kick>(db).await.expect("alice kicks");
        let moderated = granted.moderate(db, "carol").await.expect("below alice");
        assert_eq!(
            (moderated.server(), moderated.target(), moderated.actor()),
            ("club", "carol", &Actor::User("alice".into()))
        );
        let bob = mem_user("bob", false);
        let access = resolve_server(db, "club", Some(&bob), &Proof::none())
            .await
            .expect("bob");
        let granted = access.grant::<Kick>(db).await.expect("bob kicks");
        assert!(granted.moderate(db, "alice").await.is_err(), "above bob");
        done(state, path).await;
    }
}
