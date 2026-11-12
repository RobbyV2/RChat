use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::perms::{held_roles, role_named};
use crate::api::reports::forms::{self, ReportForms};
use crate::api::{ApiError, SETTINGS_TTL, Settings};
use crate::db::{Db, User, pool_key};

/// Who may create servers with `POST /api/v1/servers`: `everyone`, `nobody`, or `some` (the
/// accounts and role holders the instance lists). `can_create_servers` in `GET /api/v1/me`
/// says what it means for the caller.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ServerCreation {
    #[default]
    Everyone,
    Nobody,
    Some,
}

impl ServerCreation {
    pub const KEY: &str = "server_creation";
    pub const ENV: &str = "SERVER_CREATION";
    pub const WORDS: [&str; 3] = ["everyone", "nobody", "some"];

    pub fn as_str(self) -> &'static str {
        match self {
            ServerCreation::Everyone => "everyone",
            ServerCreation::Nobody => "nobody",
            ServerCreation::Some => "some",
        }
    }

    pub fn parse(value: &str) -> Option<ServerCreation> {
        match value {
            "everyone" => Some(ServerCreation::Everyone),
            "nobody" => Some(ServerCreation::Nobody),
            "some" => Some(ServerCreation::Some),
            _ => None,
        }
    }
}

/// How people get into servers by themselves: `everyone` may join any server they can open,
/// `invites` needs a server password or a ticket (a server without a password can't be joined
/// or opened by its name alone), `nobody` turns joining off (only members open servers).
/// Members stay in their servers either way.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ServerJoining {
    #[default]
    Everyone,
    Invites,
    Nobody,
}

impl ServerJoining {
    pub const KEY: &str = "server_joining";
    pub const ENV: &str = "SERVER_JOINING";
    pub const WORDS: [&str; 3] = ["everyone", "invites", "nobody"];

    pub fn as_str(self) -> &'static str {
        match self {
            ServerJoining::Everyone => "everyone",
            ServerJoining::Invites => "invites",
            ServerJoining::Nobody => "nobody",
        }
    }

    pub fn parse(value: &str) -> Option<ServerJoining> {
        match value {
            "everyone" => Some(ServerJoining::Everyone),
            "invites" => Some(ServerJoining::Invites),
            "nobody" => Some(ServerJoining::Nobody),
            _ => None,
        }
    }
}

/// Who may start a direct conversation with `POST /api/v1/dms`: `everyone`, `friends` (only
/// with a friend) or `nobody`. Conversations that exist keep working, and so does the self DM.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum DmCreation {
    #[default]
    Everyone,
    Friends,
    Nobody,
}

impl DmCreation {
    pub const KEY: &str = "dm_creation";
    pub const ENV: &str = "DM_CREATION";
    pub const WORDS: [&str; 3] = ["everyone", "friends", "nobody"];

    pub fn as_str(self) -> &'static str {
        match self {
            DmCreation::Everyone => "everyone",
            DmCreation::Friends => "friends",
            DmCreation::Nobody => "nobody",
        }
    }

    pub fn parse(value: &str) -> Option<DmCreation> {
        match value {
            "everyone" => Some(DmCreation::Everyone),
            "friends" => Some(DmCreation::Friends),
            "nobody" => Some(DmCreation::Nobody),
            _ => None,
        }
    }
}

/// The switch for new friend requests.
pub const FRIEND_REQUESTS: &str = "friend_requests";

/// The switch for `GET /api/v1/server_search`.
pub const SERVER_SEARCH: &str = "server_search";

/// The control that lists who may create servers while `server_creation` is `some`.
pub const SERVER_CREATORS: &str = "server_creators";

/// One entry of `server_creators`: an account (its username in lowercase), or the holders of
/// a role of a server (the `server:Role` entry as written). An entry with a `:` is always a
/// role, never a username.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Creator {
    User(String),
    Role(String),
}

impl Creator {
    pub fn parse(entry: &str) -> Creator {
        let entry = entry.trim();
        match entry.contains(':') {
            true => Creator::Role(entry.to_string()),
            false => Creator::User(entry.to_lowercase()),
        }
    }

    /// Whether this entry names the role `role` of the server `server`.
    fn names_role(&self, server: &str, role: &str) -> bool {
        match self {
            Creator::User(_) => false,
            Creator::Role(entry) => readings(entry).any(|(s, r)| s == server && r == role),
        }
    }
}

/// Every way to read a role entry: the server (in lowercase) before one of its colons and the
/// role after it, as written. Server and role names may both hold a `:`, so no colon is the
/// only place to split.
fn readings(entry: &str) -> impl Iterator<Item = (String, &str)> {
    entry
        .match_indices(':')
        .map(|(at, _)| (entry[..at].to_lowercase(), &entry[at + 1..]))
}

/// The readings of `entry` that name another server than `server`.
fn other_readings(entry: &str, server: &str) -> Vec<(String, String)> {
    readings(entry)
        .filter(|(s, _)| s != server)
        .map(|(s, role)| (s, role.to_string()))
        .collect()
}

/// The list of server creators `list` without the account `username`, or `None` when the
/// account is not on it. Role entries stay.
pub(crate) fn without_creator(list: &str, username: &str) -> Option<String> {
    let gone = Creator::User(username.to_lowercase());
    let entries: Vec<&str> = list.split(',').filter(|e| !e.trim().is_empty()).collect();
    let kept: Vec<&str> = entries
        .iter()
        .copied()
        .filter(|entry| Creator::parse(entry) != gone)
        .collect();
    (kept.len() != entries.len()).then(|| kept.join(","))
}

async fn stored_creators(conn: &mut sqlx::AnyConnection) -> sqlx::Result<Option<String>> {
    sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(SERVER_CREATORS)
        .fetch_optional(&mut *conn)
        .await?
        .map(|r| r.try_get(0))
        .transpose()
}

async fn store_creators(conn: &mut sqlx::AnyConnection, list: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE settings SET value = $1 WHERE key = $2")
        .bind(list)
        .bind(SERVER_CREATORS)
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

/// Takes the deleted account `username` off the stored list of server creators, so whoever
/// registers the name next gets nothing from it.
pub(crate) async fn forget_creator(
    conn: &mut sqlx::AnyConnection,
    username: &str,
) -> sqlx::Result<()> {
    let Some(list) = stored_creators(conn).await? else {
        return Ok(());
    };
    match without_creator(&list, username) {
        Some(kept) => store_creators(conn, &kept).await,
        None => Ok(()),
    }
}

/// Keeps the stored list of server creators true to the server `key` when its name stops being
/// its own: its role entries follow it to `renamed`, or go when it is deleted, so whoever takes
/// the old name next gets nothing from them. An entry that also names a role of another server
/// stays as it is.
pub(crate) async fn move_creator_roles(
    conn: &mut sqlx::AnyConnection,
    key: &str,
    renamed: Option<&str>,
) -> sqlx::Result<()> {
    let Some(list) = stored_creators(conn).await? else {
        return Ok(());
    };
    let (mut kept, mut changed) = (Vec::new(), false);
    for entry in list.split(',').filter(|e| !e.trim().is_empty()) {
        let own = readings(entry)
            .find(|(server, _)| server == key)
            .map(|(_, role)| role.to_string());
        let mut elsewhere = false;
        if own.is_some() {
            for (server, role) in other_readings(entry, key) {
                elsewhere |= role_named(&mut *conn, &server, &role).await?;
            }
        }
        match (own, elsewhere, renamed) {
            (None, _, _) | (Some(_), true, _) => kept.push(entry.to_string()),
            (Some(role), false, Some(new)) => {
                kept.push(format!("{new}:{role}"));
                changed = true;
            }
            (Some(_), false, None) => changed = true,
        }
    }
    if !changed {
        return Ok(());
    }
    let list = kept.join(",");
    let list = crate::api::controls::Control::find(SERVER_CREATORS)
        .and_then(|control| control.parse(&list).ok())
        .unwrap_or(list);
    store_creators(conn, &list).await
}

/// The instance's lists and report forms, which `Settings` (a `Copy` value sent to every
/// client) leaves out.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    pub server_creators: Vec<Creator>,
    pub report_forms: ReportForms,
}

/// The lists of each database this process has open, with when they were read.
type PolicyCache = Mutex<HashMap<String, (Instant, Arc<Policy>)>>;

static POLICY_CACHE: LazyLock<PolicyCache> = LazyLock::new(Default::default);

impl Policy {
    /// Reads the lists. A read failure answers the last known ones, else empty ones.
    pub async fn load(db: &Db) -> Arc<Policy> {
        let rows = match sqlx::query("SELECT key, value FROM settings WHERE key IN ($1, $2)")
            .bind(SERVER_CREATORS)
            .bind(forms::KEY)
            .fetch_all(db)
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("settings could not be read, using the last known lists: {e}");
                return POLICY_CACHE
                    .lock()
                    .ok()
                    .and_then(|cache| cache.get(&pool_key(db)).map(|(_, policy)| policy.clone()))
                    .unwrap_or_default();
            }
        };
        let value = |key: &str| {
            rows.iter()
                .find(|r| r.try_get::<String, _>(0).is_ok_and(|k| k == key))
                .and_then(|r| r.try_get::<String, _>(1).ok())
        };
        let list = value(SERVER_CREATORS).unwrap_or_default();
        let report_forms = match value(forms::KEY) {
            Some(stored) => ReportForms::from_stored(&stored).unwrap_or_else(|| {
                tracing::warn!("the stored report forms can't be read, using the defaults");
                ReportForms::defaults()
            }),
            None => ReportForms::defaults(),
        };
        let policy = Arc::new(Policy {
            report_forms,
            server_creators: list
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(Creator::parse)
                .collect(),
        });
        if let Ok(mut cache) = POLICY_CACHE.lock() {
            cache.insert(pool_key(db), (Instant::now(), policy.clone()));
        }
        policy
    }

    pub async fn cached(db: &Db) -> Arc<Policy> {
        let hit = POLICY_CACHE.lock().ok().and_then(|cache| {
            cache
                .get(&pool_key(db))
                .filter(|(at, _)| at.elapsed() < SETTINGS_TTL)
                .map(|(_, policy)| policy.clone())
        });
        match hit {
            Some(policy) => policy,
            None => Policy::load(db).await,
        }
    }

    pub fn forget(db: &Db) {
        if let Ok(mut cache) = POLICY_CACHE.lock() {
            cache.remove(&pool_key(db));
        }
    }
}

/// The answer to a request that the control `control` refuses because it is off for the whole
/// site: `answer` with that reason. Every refusal by an instance control is built here or in
/// `left_out`.
pub(crate) fn refused(control: &'static str, answer: ApiError) -> ApiError {
    tracing::debug!("refused by the {control} setting");
    let ApiError(status, error, _) = answer;
    ApiError::off_site(status, error, control)
}

/// The answer to a request that the control `control` refuses because it leaves the caller
/// out while others may: `answer` with that reason.
pub(crate) fn left_out(control: &'static str, answer: ApiError) -> ApiError {
    tracing::debug!("left out by the {control} setting");
    let ApiError(status, error, _) = answer;
    ApiError::off_account(status, error, control)
}

/// Whether `entry`, which names a role of `server`, also reads as a role of another server.
/// Such an entry counts for nobody: which of the two the operator meant can't be told.
async fn two_roles(db: &Db, entry: &str, server: &str) -> sqlx::Result<bool> {
    for (other, role) in other_readings(entry, server) {
        if role_named(db, &other, &role).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// What the instance lets `user` do. Every check of an instance switch that depends on who
/// asks goes through here.
pub struct Effective<'a> {
    db: &'a Db,
    user: Option<&'a User>,
    settings: Settings,
}

pub async fn effective<'a>(db: &'a Db, user: Option<&'a User>) -> Effective<'a> {
    Effective {
        db,
        user,
        settings: Settings::cached(db).await,
    }
}

impl Effective<'_> {
    /// Who may create servers.
    pub fn server_creation(&self) -> ServerCreation {
        self.settings.server_creation
    }

    /// How the user may get into servers by themselves.
    pub fn server_joining(&self) -> ServerJoining {
        self.settings.server_joining
    }

    /// Whether the user may search servers.
    pub fn server_search(&self) -> bool {
        self.settings.server_search
    }

    /// Who the user may start a direct conversation with.
    pub fn dm_creation(&self) -> DmCreation {
        self.settings.dm_creation
    }

    /// Whether the user may send new friend requests.
    pub fn friend_requests(&self) -> bool {
        self.settings.friend_requests
    }

    /// Whether the user may create a server with `POST /api/v1/servers`. A site admin follows
    /// the same rule as everyone.
    pub async fn can_create_servers(&self) -> Result<bool, ApiError> {
        let Some(user) = self.user else {
            return Ok(false);
        };
        match self.settings.server_creation {
            ServerCreation::Everyone => Ok(true),
            ServerCreation::Nobody => Ok(false),
            ServerCreation::Some => {
                let policy = Policy::cached(self.db).await;
                let named = policy
                    .server_creators
                    .iter()
                    .any(|c| matches!(c, Creator::User(name) if *name == user.username));
                let by_role = policy
                    .server_creators
                    .iter()
                    .any(|c| matches!(c, Creator::Role(_)));
                if named || !by_role {
                    return Ok(named);
                }
                let held = held_roles(self.db, &user.username).await?;
                for creator in &policy.server_creators {
                    let Creator::Role(entry) = creator else {
                        continue;
                    };
                    for (server, role) in &held {
                        if creator.names_role(server, role)
                            && !two_roles(self.db, entry, server).await?
                        {
                            return Ok(true);
                        }
                    }
                }
                Ok(false)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::Json;
    use axum::extract::State;
    use axum::http::StatusCode;
    use serde_json::json;

    use super::{Creator, Policy, ServerCreation, effective};
    use crate::api::admin::{SettingsPatch, patch_settings};
    use crate::api::auth::me_payload;
    use crate::api::servers::{CreateServerReq, create_server};
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::api::{ApiError, Authed, Settings};
    use crate::db::Db;
    use crate::state::AppState;

    async fn add_user(db: &Db, username: &str, site_admin: bool) {
        crate::db::NewUser::plain(username)
            .admin(site_admin)
            .add(db)
            .await;
    }

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    async fn set(state: &AppState, body: serde_json::Value) -> Result<(), ApiError> {
        let patch: SettingsPatch = serde_json::from_value(body).expect("patch");
        patch_settings(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Json(patch),
        )
        .await
        .map(|_| ())
    }

    async fn create(state: &AppState, who: &str, name: &str) -> Result<(), ApiError> {
        let req: CreateServerReq = serde_json::from_value(json!({ "name": name })).expect("req");
        create_server(
            State(state.clone()),
            Authed(mem_user(who, who == "root")),
            Json(req),
        )
        .await
        .map(|_| ())
    }

    async fn may(state: &AppState, who: &str) -> bool {
        let user = mem_user(who, who == "root");
        let me = me_payload(&state.db, &user).await.expect("me");
        let asked = effective(&state.db, Some(&user))
            .await
            .can_create_servers()
            .await
            .expect("effective");
        assert_eq!(
            me.can_create_servers, asked,
            "{who}: me and the check agree"
        );
        asked
    }

    /// alice is nobody special, bob is listed, carol holds Staff in lobby, dave holds a Staff
    /// role in another server, `x:y` is an account whose name looks like a role entry, root is
    /// the site admin.
    async fn people(state: &AppState) {
        let db = &state.db;
        for name in ["alice", "bob", "carol", "dave", "x:y"] {
            add_user(db, name, false).await;
        }
        add_user(db, "root", true).await;
        for server in ["lobby", "other", "x"] {
            sqlx::query("INSERT INTO servers(name, display_name, creator, created_at) VALUES($1, $1, NULL, 0)")
                .bind(server)
                .execute(db)
                .await
                .expect("server");
        }
        add_member(db, "lobby", "carol", 0, 0, 0).await;
        add_member(db, "other", "dave", 0, 0, 0).await;
        exec(db, "INSERT INTO roles(server, name, color) VALUES('lobby', 'Staff', '#000000'), ('other', 'Staff', '#000000'), ('lobby', 'staff', '#000000')").await;
        exec(db, "INSERT INTO user_roles(server, username, role_id) SELECT 'lobby', 'carol', id FROM roles WHERE server = 'lobby' AND name = 'Staff'").await;
        exec(db, "INSERT INTO user_roles(server, username, role_id) SELECT 'other', 'dave', id FROM roles WHERE server = 'other'").await;
    }

    const EVERYONE: [&str; 6] = ["alice", "bob", "carol", "dave", "x:y", "root"];

    #[tokio::test]
    async fn each_creation_mode_for_a_plain_user_a_listed_user_and_a_role_holder() {
        let (state, path) = temp_state("server_creation").await;
        people(&state).await;
        assert_eq!(
            Settings::cached(&state.db).await.server_creation,
            ServerCreation::Everyone
        );
        for (n, who) in EVERYONE.into_iter().enumerate() {
            assert!(may(&state, who).await, "{who}: everyone");
            create(&state, who, &format!("open{n}")).await.expect(who);
        }

        set(&state, json!({"server_creation": "nobody"}))
            .await
            .expect("nobody");
        for (n, who) in EVERYONE.into_iter().enumerate() {
            assert!(!may(&state, who).await, "{who}: nobody");
            let refused = create(&state, who, &format!("closed{n}")).await;
            assert!(
                matches!(refused, Err(ApiError(StatusCode::NOT_FOUND, ref m, _)) if m == "Not found"),
                "{who}: the same 404 as an unknown path, the site admin included"
            );
        }

        set(
            &state,
            json!({"server_creation": "some", "server_creators": ["Bob", "lobby:Staff", "x:y"]}),
        )
        .await
        .expect("some");
        for (n, who) in EVERYONE.into_iter().enumerate() {
            let listed = matches!(who, "bob" | "carol");
            assert_eq!(may(&state, who).await, listed, "{who}: some");
            let made = create(&state, who, &format!("some{n}")).await;
            match listed {
                true => made.expect(who),
                false => assert!(
                    matches!(made, Err(ApiError(StatusCode::NOT_FOUND, ref m, _)) if m == "Not found"),
                    "{who}"
                ),
            }
        }
        assert_eq!(
            Policy::cached(&state.db).await.server_creators,
            [
                Creator::User("bob".to_string()),
                Creator::Role("lobby:Staff".to_string()),
                Creator::Role("x:y".to_string()),
            ]
        );
        assert!(
            !effective(&state.db, None)
                .await
                .can_create_servers()
                .await
                .expect("guest"),
            "guests never create servers"
        );

        set(
            &state,
            json!({"server_creation": "some", "server_creators": []}),
        )
        .await
        .expect("nobody listed");
        for who in EVERYONE {
            assert!(!may(&state, who).await, "{who}: an empty list");
        }
        done(state, path).await;
    }

    /// A server without a creator, a role in it, and an account that holds the role.
    async fn role_holder(db: &Db, server: &str, role: &str, who: &str) {
        sqlx::query("INSERT INTO servers(name, display_name, creator, created_at) VALUES($1, $1, NULL, 0) ON CONFLICT(name) DO NOTHING")
            .bind(server)
            .execute(db)
            .await
            .expect("server");
        sqlx::query("INSERT INTO roles(server, name, color) VALUES($1, $2, '#000000')")
            .bind(server)
            .bind(role)
            .execute(db)
            .await
            .expect("role");
        add_user(db, who, false).await;
        add_member(db, server, who, 0, 0, 0).await;
        sqlx::query("INSERT INTO user_roles(server, username, role_id) SELECT $1, $2, id FROM roles WHERE server = $1 AND name = $3")
            .bind(server)
            .bind(who)
            .bind(role)
            .execute(db)
            .await
            .expect("holds it");
    }

    #[tokio::test]
    async fn a_role_entry_matches_whatever_colons_the_names_have() {
        let (state, path) = temp_state("creator_roles").await;
        let db = &state.db;
        role_holder(db, "team:a", "Staff", "frank").await;
        role_holder(db, "team:a", "staff", "heidi").await;
        role_holder(db, "plain", "Staff", "grace").await;
        set(
            &state,
            json!({"server_creation": "some", "server_creators": ["Team:a:Staff"]}),
        )
        .await
        .expect("one entry");
        assert!(may(&state, "frank").await, "a server name with a colon");
        assert!(
            !may(&state, "heidi").await,
            "the role is matched as written"
        );
        assert!(!may(&state, "grace").await);

        role_holder(db, "crew", "b:Mods", "ivan").await;
        set(&state, json!({"server_creators": ["CREW:b:Mods"]}))
            .await
            .expect("another entry");
        assert!(may(&state, "ivan").await, "a role name with a colon");
        assert!(!may(&state, "frank").await);
        done(state, path).await;
    }

    #[tokio::test]
    async fn an_entry_that_names_two_roles_grants_nobody() {
        let (state, path) = temp_state("creator_two_readings").await;
        let db = &state.db;
        role_holder(db, "team:a", "Staff", "frank").await;
        set(
            &state,
            json!({"server_creation": "some", "server_creators": ["team:a:Staff"]}),
        )
        .await
        .expect("one entry");
        assert!(may(&state, "frank").await, "one reading names a role");

        role_holder(db, "team", "a:Staff", "erin").await;
        for who in ["frank", "erin"] {
            assert!(
                !may(&state, who).await,
                "{who}: the entry now also reads as another server's role, so it counts for neither"
            );
        }
        exec(db, "DELETE FROM roles WHERE server = 'team'").await;
        assert!(may(&state, "frank").await, "one reading again");
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_joining_switches_are_public_and_change_live() {
        use crate::api::admin::get_settings;
        use crate::api::policy::ServerJoining;
        let (state, path) = temp_state("joining_settings").await;
        let wire = || async {
            serde_json::to_value(get_settings(State(state.clone())).await.0).expect("json")
        };
        let fresh = wire().await;
        assert_eq!(fresh["server_joining"], json!("everyone"));
        assert_eq!(fresh["server_search"], json!(true));
        let mut rx = state.hub.subscribe();
        set(
            &state,
            json!({"server_joining": "invites", "server_search": false}),
        )
        .await
        .expect("patch");
        let event = serde_json::to_value(rx.try_recv().expect("settings_changed")).expect("json");
        assert_eq!(event["settings"]["server_joining"], json!("invites"));
        assert_eq!(event["settings"]["server_search"], json!(false));
        let user = mem_user("alice", false);
        for who in [Some(&user), None] {
            let allowed = effective(&state.db, who).await;
            assert_eq!(allowed.server_joining(), ServerJoining::Invites);
            assert!(!allowed.server_search());
        }
        set(&state, json!({"server_joining": "nobody"}))
            .await
            .expect("nobody");
        assert_eq!(wire().await["server_joining"], json!("nobody"));
        assert!(
            serde_json::from_value::<SettingsPatch>(json!({"server_joining": "friends"})).is_err()
        );
        let denied = Settings::DENY;
        assert_eq!(denied.server_joining, ServerJoining::Nobody);
        assert!(!denied.server_search);
        let older: Settings = serde_json::from_value(json!({
            "profanity_filter": true,
            "asset_previews": true,
            "asset_uploads": true,
            "guests_enabled": true,
        }))
        .expect("a copy from before the switches");
        assert_eq!(older.server_joining, ServerJoining::Everyone);
        assert!(older.server_search);
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_dm_and_friend_switches_are_public_and_change_live() {
        use crate::api::admin::get_settings;
        use crate::api::policy::DmCreation;
        let (state, path) = temp_state("dm_settings").await;
        let wire = || async {
            serde_json::to_value(get_settings(State(state.clone())).await.0).expect("json")
        };
        let fresh = wire().await;
        assert_eq!(fresh["dm_creation"], json!("everyone"));
        assert_eq!(fresh["friend_requests"], json!(true));
        let mut rx = state.hub.subscribe();
        set(
            &state,
            json!({"dm_creation": "friends", "friend_requests": false}),
        )
        .await
        .expect("patch");
        let event = serde_json::to_value(rx.try_recv().expect("settings_changed")).expect("json");
        assert_eq!(event["settings"]["dm_creation"], json!("friends"));
        assert_eq!(event["settings"]["friend_requests"], json!(false));
        let user = mem_user("alice", false);
        let allowed = effective(&state.db, Some(&user)).await;
        assert_eq!(allowed.dm_creation(), DmCreation::Friends);
        assert!(!allowed.friend_requests());
        set(&state, json!({"dm_creation": "nobody"}))
            .await
            .expect("nobody");
        assert_eq!(wire().await["dm_creation"], json!("nobody"));
        assert!(serde_json::from_value::<SettingsPatch>(json!({"dm_creation": "some"})).is_err());
        let denied = Settings::DENY;
        assert_eq!(denied.dm_creation, DmCreation::Nobody);
        assert!(!denied.friend_requests);
        let older: Settings = serde_json::from_value(json!({
            "profanity_filter": true,
            "asset_previews": true,
            "asset_uploads": true,
            "guests_enabled": true,
        }))
        .expect("a copy from before the switches");
        assert_eq!(older.dm_creation, DmCreation::Everyone);
        assert!(older.friend_requests);
        done(state, path).await;
    }

    #[tokio::test]
    async fn switching_creation_off_keeps_existing_servers_working() {
        use crate::api::access::{Proof, resolve_server};
        let (state, path) = temp_state("server_creation_off").await;
        people(&state).await;
        create(&state, "alice", "Club").await.expect("create");
        set(&state, json!({"server_creation": "nobody"}))
            .await
            .expect("off");
        let alice = mem_user("alice", false);
        let access = resolve_server(&state.db, "club", Some(&alice), &Proof::none())
            .await
            .expect("the server is still there");
        assert!(access.is_member());
        assert_eq!(access.lite().creator.as_deref(), Some("alice"));
        let perms = access.perms(&state.db).await.expect("perms");
        assert_eq!(
            perms,
            crate::api::access::perms::ALL_PERMS,
            "its owner keeps every permission"
        );
        let renamed: crate::api::servers::ServerPatch =
            serde_json::from_value(json!({"name": "Club Two"})).expect("req");
        let _ = crate::api::servers::update_server(
            State(state.clone()),
            Authed(alice),
            axum::extract::Path("club".to_string()),
            Json(renamed),
        )
        .await
        .expect("managing it still works");
        done(state, path).await;
    }

    /// What an old client reads of `refused`, and its reason as a new one reads it.
    async fn answered<T>(refused: Result<T, ApiError>) -> (StatusCode, String, serde_json::Value) {
        use axum::response::IntoResponse;
        let Err(e) = refused else {
            panic!("refused");
        };
        let res = e.into_response();
        let status = res.status();
        let body = axum::body::to_bytes(res.into_body(), 4096)
            .await
            .expect("body");
        let text = String::from_utf8(body.to_vec()).expect("utf8");
        let json: serde_json::Value = serde_json::from_str(&text).expect("json");
        let error = json["error"].as_str().expect("error").to_string();
        let old = serde_json::to_string(&json!({ "error": error })).expect("old body");
        match json.get("reason") {
            Some(_) => assert!(
                text.starts_with(&format!("{},\"reason\":{{", &old[..old.len() - 1])),
                "the body before the change, with one field after it: {text}"
            ),
            None => assert_eq!(text, old),
        }
        (status, error, json["reason"].clone())
    }

    #[tokio::test]
    async fn each_landed_switch_refuses_with_its_reason() {
        use axum::extract::{Path, Query};

        use crate::api::MaybeAuthed;
        use crate::api::dms::open_dm;
        use crate::api::friends::send_request;
        use crate::api::servers::{guest_access, join_server, search_servers};
        let (state, path) = temp_state("switch_reasons").await;
        people(&state).await;
        let off = |control: &str| json!({"kind": "off_site", "control": control});
        let not_found = |text: &str, reason: serde_json::Value| {
            (StatusCode::NOT_FOUND, text.to_string(), reason)
        };

        set(&state, json!({"server_creation": "nobody"}))
            .await
            .expect("nobody");
        for who in ["alice", "root"] {
            assert_eq!(
                answered(create(&state, who, "made").await).await,
                not_found("Not found", off("server_creation")),
                "{who}"
            );
        }
        set(
            &state,
            json!({"server_creation": "some", "server_creators": ["bob"]}),
        )
        .await
        .expect("some");
        assert_eq!(
            answered(create(&state, "alice", "made").await).await,
            not_found(
                "Not found",
                json!({"kind": "off_account", "control": "server_creation"})
            ),
            "left out of the list: off for this account, not for the site"
        );

        set(&state, json!({"server_joining": "nobody"}))
            .await
            .expect("nobody");
        for name in ["lobby", "no-such-server"] {
            let joined = join_server(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Path(name.to_string()),
                None,
            )
            .await;
            assert_eq!(
                answered(joined).await,
                not_found("Server not found or wrong password", off("server_joining")),
                "{name}"
            );
            let guest = guest_access(
                State(state.clone()),
                MaybeAuthed(None),
                Path(name.to_string()),
                Json(serde_json::from_value(json!({})).expect("req")),
            )
            .await;
            assert_eq!(
                answered(guest).await,
                not_found("Server not found or wrong password", off("server_joining")),
                "{name}"
            );
        }

        set(&state, json!({"server_search": false}))
            .await
            .expect("search off");
        for who in [Some(mem_user("alice", false)), None] {
            let found = search_servers(
                State(state.clone()),
                MaybeAuthed(who),
                Query(serde_json::from_value(json!({"q": "lobby"})).expect("query")),
            )
            .await;
            assert_eq!(
                answered(found).await,
                not_found("Not found", off("server_search"))
            );
        }

        for mode in ["friends", "nobody"] {
            set(&state, json!({ "dm_creation": mode }))
                .await
                .expect(mode);
            for name in ["bob", "no-such-user"] {
                let opened = open_dm(
                    State(state.clone()),
                    Authed(mem_user("alice", false)),
                    Json(serde_json::from_value(json!({ "username": name })).expect("req")),
                )
                .await;
                assert_eq!(
                    answered(opened).await,
                    not_found("User not found", off("dm_creation")),
                    "{mode}: {name}, the same for an account and for a name nobody has"
                );
            }
        }
        set(&state, json!({"dm_creation": "everyone"}))
            .await
            .expect("everyone");
        let unknown = open_dm(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Json(serde_json::from_value(json!({"username": "no-such-user"})).expect("req")),
        )
        .await;
        assert_eq!(
            answered(unknown).await,
            not_found("User not found", serde_json::Value::Null),
            "no switch refused it, so it has no reason"
        );

        set(&state, json!({"friend_requests": false}))
            .await
            .expect("requests off");
        for name in ["bob", "no-such-user"] {
            let asked = send_request(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Json(serde_json::from_value(json!({ "username": name })).expect("req")),
            )
            .await;
            assert_eq!(
                answered(asked).await,
                not_found(
                    "Could not send a friend request to that user.",
                    off("friend_requests")
                ),
                "{name}"
            );
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_list_is_admin_only_and_checked() {
        use crate::api::admin::{get_config, get_settings};
        let (state, path) = temp_state("server_creators").await;
        let mut rx = state.hub.subscribe();
        set(
            &state,
            json!({"server_creation": "some", "server_creators": [" bob ", "lobby:Staff", "bob"]}),
        )
        .await
        .expect("set");
        let public =
            serde_json::to_value(get_settings(State(state.clone())).await.0).expect("json");
        assert_eq!(public["server_creation"], json!("some"));
        assert!(public.get("server_creators").is_none());
        let event = serde_json::to_string(&rx.try_recv().expect("settings_changed")).expect("json");
        assert!(event.contains("\"server_creation\":\"some\""));
        assert!(!event.contains("bob") && !event.contains("server_creators"));
        let view = get_config(State(state.clone()), Authed(mem_user("root", true)))
            .await
            .expect("config")
            .0;
        let view = serde_json::to_value(view).expect("json");
        let row = view["controls"]
            .as_array()
            .expect("controls")
            .iter()
            .find(|c| c["key"] == "server_creators")
            .expect("listed")
            .clone();
        assert_eq!(
            row,
            json!({"key": "server_creators", "env": "SERVER_CREATORS", "value": "bob,lobby:Staff", "config": null, "pinned": false})
        );
        let many: Vec<String> = (0..501).map(|n| format!("user{n}")).collect();
        for (bad, why) in [
            (json!(["a,b"]), "a comma inside an entry"),
            (json!([""]), "an empty entry"),
            (json!([":Staff"]), "a role without a server"),
            (json!(["lobby:"]), "a server without a role"),
            (json!(["a\u{0}b"]), "a NUL"),
            (json!(many), "more than 500 entries"),
            (json!(["x".repeat(202)]), "an entry longer than two names"),
        ] {
            let refused = set(&state, json!({"server_creators": bad})).await;
            assert!(
                matches!(refused, Err(ApiError(StatusCode::BAD_REQUEST, ref m, _)) if m == "server_creators: expected up to 500 usernames or server:role entries"),
                "{why}"
            );
        }
        assert_eq!(Policy::cached(&state.db).await.server_creators.len(), 2);
        let audit: Vec<String> = sqlx::query(
            "SELECT detail FROM instance_audit WHERE action = 'settings.change' ORDER BY id",
        )
        .fetch_all(&state.db)
        .await
        .expect("audit")
        .iter()
        .map(|r| sqlx::Row::try_get(r, 0).expect("detail"))
        .collect();
        assert_eq!(
            audit,
            [
                json!({"key": "server_creation", "from": "everyone", "to": "some"}).to_string(),
                json!({"key": "server_creators", "from": "", "to": "bob,lobby:Staff"}).to_string(),
            ]
        );
        done(state, path).await;
    }
}
