use std::collections::{HashMap, HashSet};

use axum::http::StatusCode;
use rchat_perms::Mask;
use rchat_perms::eval::{self, Who};
use rchat_perms::members::{Hidden, Place, Seer, member_list};
use rchat_perms::rules::HOSTED;
use sqlx::Row;

use super::perms::{everyone_mask, member_who};
use super::{ResolvedChannel, ServerAccess, forbidden};
use crate::api::{ApiError, ServerSummaryLite, Settings, placeholders};
use crate::db::Db;

/// A server's member list for a viewer the member list rule lets see it, where they asked: only
/// `ServerAccess::member_list` and `ResolvedChannel::member_list` make one. What lists a
/// server's members, their presence or suggestions of them takes it.
pub struct MemberList<'a> {
    access: &'a ServerAccess,
}

impl<'a> MemberList<'a> {
    pub fn access(&self) -> &'a ServerAccess {
        self.access
    }

    pub fn server(&self) -> &'a str {
        self.access.name()
    }
}

/// The member list, or why the viewer doesn't get it.
pub enum Roster<'a> {
    Shown(MemberList<'a>),
    Hidden(Hidden),
}

pub const SITE_OFF: &str = "Member lists are turned off on this site";
pub const SERVER_HIDDEN: &str = "You can't view the members of this server";
pub const CHANNEL_HIDDEN: &str = "You can't view the members of this channel";

/// The refusal for a hidden member list, or `None` where the request answers an empty list
/// (a server that shows its members only to members, as before this rule).
pub fn refusal(why: Hidden, lite: &ServerSummaryLite) -> Option<ApiError> {
    match why {
        Hidden::Outside => None,
        Hidden::Site => Some(ApiError::off_site(
            StatusCode::FORBIDDEN,
            SITE_OFF,
            crate::api::features::Feature::MemberLists.item(),
        )),
        Hidden::Server if lite.hide_members => Some(ApiError::off_server(
            StatusCode::FORBIDDEN,
            SERVER_HIDDEN,
            "hide_members",
        )),
        Hidden::Server => Some(forbidden(SERVER_HIDDEN)),
        Hidden::Channel => Some(forbidden(CHANNEL_HIDDEN)),
    }
}

fn place(lite: &ServerSummaryLite, settings: &Settings) -> Place {
    Place {
        site: settings.member_lists,
        hide: lite.hide_members,
        outside: lite.members_visible,
    }
}

fn seer(who: Who, everyone: Mask, here: Option<Mask>) -> Seer {
    match who {
        Who::Staff => Seer::Staff,
        Who::Visitor {
            signed_in: _,
            caps: _,
        } => Seer::Visitor { everyone, here },
        Who::Owner | Who::Admin { mask: _, roles: _ } | Who::Member { roles: _ } => Seer::Member {
            server: eval::server_bits(&who, everyone, &HOSTED),
            here,
        },
    }
}

impl ServerAccess {
    async fn roster(
        &self,
        db: &Db,
        settings: &Settings,
        here: Option<Mask>,
    ) -> Result<Roster<'_>, ApiError> {
        let standing = self.standing(db).await?;
        let everyone = self.everyone(db).await?;
        let seer = seer(standing.who, everyone, here);
        Ok(match member_list(seer, place(self.lite(), settings)) {
            Ok(()) => Roster::Shown(MemberList { access: self }),
            Err(why) => Roster::Hidden(why),
        })
    }

    /// The server's member list as the viewer may see it anywhere in the server.
    pub async fn member_list(&self, db: &Db, settings: &Settings) -> Result<Roster<'_>, ApiError> {
        self.roster(db, settings, None).await
    }
}

impl ResolvedChannel {
    /// The server's member list as the viewer may see it in this channel.
    pub async fn member_list(&self, db: &Db, settings: &Settings) -> Result<Roster<'_>, ApiError> {
        let here = self.rights().mask as Mask;
        self.server().roster(db, settings, Some(here)).await
    }
}

/// Where a member list shows: anywhere in the server, or in one of its channels.
pub enum ListPlace {
    Server(Box<ServerAccess>),
    Channel(Box<ResolvedChannel>),
}

impl ListPlace {
    /// The server, or its channel `channel_id` when given: a channel of another server or one
    /// the viewer can't view gives the uniform 404.
    pub async fn open(
        access: ServerAccess,
        db: &Db,
        channel_id: Option<i64>,
    ) -> Result<ListPlace, ApiError> {
        Ok(match channel_id {
            Some(id) => ListPlace::Channel(Box::new(access.channel(db, id).await?)),
            None => ListPlace::Server(Box::new(access)),
        })
    }

    pub fn access(&self) -> &ServerAccess {
        match self {
            ListPlace::Server(access) => access,
            ListPlace::Channel(channel) => channel.server(),
        }
    }

    pub async fn member_list(&self, db: &Db, settings: &Settings) -> Result<Roster<'_>, ApiError> {
        match self {
            ListPlace::Server(access) => access.member_list(db, settings).await,
            ListPlace::Channel(channel) => channel.member_list(db, settings).await,
        }
    }
}

/// Which of `names` (lowercase) wrote a message the viewer of `access` reads in its text
/// channels, under the `text_reading` rule: the authors whose looks a viewer without the member
/// list still sees next to their messages. Batched, one statement.
pub(crate) async fn seen_authors(
    db: &Db,
    access: &ServerAccess,
    names: &[String],
) -> Result<HashSet<String>, ApiError> {
    if names.is_empty() {
        return Ok(HashSet::new());
    }
    let reading = access.text_reading(names.len() + 2);
    let sql = format!(
        "WITH seen AS MATERIALIZED ({}) SELECT u.username FROM users u WHERE u.username IN ({}) AND EXISTS(SELECT 1 FROM seen s WHERE EXISTS(SELECT 1 FROM messages m WHERE m.channel_id = s.id AND m.author = u.username AND m.kind IN ('user', 'poll') AND m.webhook_id IS NULL AND (s.whole <> 0 OR (m.created_at >= s.since AND (m.thread_root_id IS NULL OR EXISTS(SELECT 1 FROM messages rt WHERE rt.id = m.thread_root_id AND rt.created_at >= s.since))))))",
        reading.sql,
        placeholders(2, names.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(access.name());
    for name in names {
        query = query.bind(name);
    }
    let rows = reading.bind(query).fetch_all(db).await?;
    rows.iter()
        .map(|r| r.try_get::<String, _>(0))
        .collect::<sqlx::Result<HashSet<String>>>()
        .map_err(ApiError::from)
}

/// Which of `servers` keep their member list from the connection of `user` (`None` for a
/// guest) at server level: every one while the site switch is off, else those the member list
/// rule hides. A site admin sees every member list. A server that shows its members only to
/// members is left to `ws_closed_servers`.
pub(crate) async fn ws_rosterless(
    _: &crate::ws::Layer,
    db: &Db,
    user: Option<&str>,
    site_admin: bool,
    servers: &[&str],
    site: bool,
) -> sqlx::Result<HashSet<String>> {
    if site_admin || servers.is_empty() {
        return Ok(HashSet::new());
    }
    if !site {
        return Ok(servers.iter().map(|s| s.to_string()).collect());
    }
    let list = placeholders(1, servers.len());
    let sql = format!(
        "SELECT name, hide_members, members_visible, everyone_perms FROM servers WHERE name IN ({list})"
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for s in servers {
        query = query.bind(*s);
    }
    let rows = query.fetch_all(db).await?;
    let mut held: HashMap<String, (bool, i64, i64)> = HashMap::new();
    if let Some(user) = user {
        let sql = format!(
            "SELECT m.server, m.is_admin, m.perms, r.perms FROM members m LEFT JOIN user_roles ur ON ur.server = m.server AND ur.username = m.username LEFT JOIN roles r ON r.id = ur.role_id WHERE m.username = $1 AND m.server IN ({})",
            placeholders(2, servers.len())
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(user);
        for s in servers {
            query = query.bind(*s);
        }
        for r in query.fetch_all(db).await? {
            let roles = r.try_get::<Option<i64>, _>(3)?.unwrap_or(0);
            let entry = held.entry(r.try_get(0)?).or_insert((
                r.try_get::<i64, _>(1)? != 0,
                r.try_get(2)?,
                0,
            ));
            entry.2 |= roles;
        }
    }
    let mut out = HashSet::new();
    for r in &rows {
        let name: String = r.try_get(0)?;
        let place = Place {
            site,
            hide: r.try_get::<i64, _>(1)? != 0,
            outside: r.try_get::<i64, _>(2)? != 0,
        };
        let everyone = everyone_mask(r.try_get(3)?);
        let who = match held.get(&name) {
            Some((is_admin, perms, roles)) => member_who(*is_admin, *perms, *roles),
            None => Who::Visitor {
                signed_in: user.is_some(),
                caps: 0,
            },
        };
        match member_list(seer(who, everyone, None), place) {
            Ok(()) | Err(Hidden::Outside) => {}
            Err(Hidden::Site | Hidden::Server | Hidden::Channel) => {
                out.insert(name);
            }
        }
    }
    Ok(out)
}
