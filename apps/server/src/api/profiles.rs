use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::perms::Perm;
use crate::api::access::{
    Proof, ServerAccess, USER_SCOPE_SMALL, acting_on, forbidden, not_found, resolve_server,
    timed_out, timed_out_error,
};
use crate::api::audit::{self, Details, Entry, Target};
use crate::api::auth::{check_avatar, check_banner, clean_bio, clean_name_for, present};
use crate::api::timeouts::REASON_MAX;
use crate::api::{
    ApiError, ApiErrorBody, Authed, OkResp, ProfanityTarget, Settings, UserRef, bad, check_len,
    check_profanity, ok, placeholders,
};
use crate::db::{AvatarKind, Db, User, now};
use crate::state::AppState;
use crate::ws::WsEvent;

/// What members of a server may set in their server profile.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProfilesMode {
    /// Name, avatar, banner color and description.
    #[default]
    All,
    /// Everything but the name.
    NoNames,
    /// Nothing: stored server profiles are kept and not shown.
    Off,
}

impl ProfilesMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ProfilesMode::All => "all",
            ProfilesMode::NoNames => "no_names",
            ProfilesMode::Off => "off",
        }
    }

    pub fn parse(raw: &str) -> ProfilesMode {
        match raw {
            "no_names" => ProfilesMode::NoNames,
            "off" => ProfilesMode::Off,
            _ => ProfilesMode::All,
        }
    }
}

/// The part of a server profile shown wherever the member is listed: each field is `null` when
/// the member uses the account's value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct MemberLook {
    /// The name shown for the member in this server.
    #[schema(example = "Ali")]
    pub name: Option<String>,
    /// How the avatar is drawn in this server; `null` uses the whole account avatar.
    pub avatar_kind: Option<AvatarKind>,
    /// Lowercase `#rrggbb` color of a `color` avatar or background of an `identicon`. Only set
    /// together with `avatar_kind`.
    #[schema(example = "#4caf50")]
    pub avatar_color: Option<String>,
}

impl MemberLook {
    fn shown(self) -> Option<MemberLook> {
        match (&self.name, self.avatar_kind) {
            (None, None) => None,
            (_, _) => Some(self),
        }
    }

    /// `user` as this look shows it.
    pub fn over(&self, user: &UserRef) -> UserRef {
        let (avatar_kind, avatar_color) = match self.avatar_kind {
            Some(kind) => (kind, self.avatar_color.clone()),
            None => (user.avatar_kind, user.avatar_color.clone()),
        };
        UserRef {
            username: user.username.clone(),
            display_name: self
                .name
                .clone()
                .unwrap_or_else(|| user.display_name.clone()),
            avatar_kind,
            avatar_color,
        }
    }
}

/// The caller's profile in one server.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ServerProfile {
    /// The stored name and avatar.
    pub look: MemberLook,
    /// The stored description; `null` uses the account's.
    pub bio: Option<String>,
    /// The stored `#rrggbb` banner color; `null` uses the account's.
    pub banner_color: Option<String>,
    /// How the caller shows in this server under its `mode`.
    pub effective: UserRef,
    /// The banner color shown in this server; `null` is the default derived from the avatar.
    pub effective_banner: Option<String>,
    /// The description shown in this server.
    pub effective_bio: Option<String>,
    /// What the server lets members set.
    pub mode: ProfilesMode,
    /// Until when (unix seconds) the profile can't be edited: 9223372036854775807 for a lock
    /// that stays until a moderator lifts it; `null` when it can be edited.
    pub locked_until: Option<i64>,
}

/// Changes to the caller's profile in a server. Omitted fields stay as they are; `null` goes back
/// to the account's value.
#[derive(Deserialize, ToSchema)]
pub struct ServerProfilePatch {
    /// The name shown in this server, under the rules of the account's display name. A name
    /// equal to the account's display name is stored as `null`.
    #[serde(default, deserialize_with = "present")]
    #[schema(value_type = Option<String>, example = "Ali")]
    name: Option<Option<String>>,
    /// Description shown in this server: at most 190 characters, checked by the profanity filter
    /// (`bios` target). Empty or `null` uses the account's.
    #[serde(default, deserialize_with = "present")]
    #[schema(value_type = Option<String>)]
    bio: Option<Option<String>>,
    /// Avatar style in this server; `null` uses the whole account avatar.
    #[serde(default, deserialize_with = "present")]
    #[schema(value_type = Option<AvatarKind>)]
    avatar_kind: Option<Option<AvatarKind>>,
    /// `#rrggbb` color, read only together with `avatar_kind`: required for `color`, the
    /// optional background for `identicon`.
    #[schema(example = "#3366ff")]
    avatar_color: Option<String>,
    /// `#rrggbb` banner color in this server; `null` uses the account's.
    #[serde(default, deserialize_with = "present")]
    #[schema(value_type = Option<String>, example = "#112233")]
    banner_color: Option<Option<String>>,
}

/// A part of a server profile a moderator can reset.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProfileField {
    /// The name shown in the server.
    Name,
    /// The description.
    Bio,
    /// The avatar style and its color.
    Avatar,
    /// The banner color.
    Banner,
}

impl ProfileField {
    pub const ALL: [ProfileField; 4] = [
        ProfileField::Name,
        ProfileField::Bio,
        ProfileField::Avatar,
        ProfileField::Banner,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ProfileField::Name => "name",
            ProfileField::Bio => "bio",
            ProfileField::Avatar => "avatar",
            ProfileField::Banner => "banner",
        }
    }
}

/// How long a reset server profile stays locked, in seconds; -1 locks it until a moderator
/// lifts the lock.
pub const LOCK_SECS: [i64; 4] = [86400, 604800, 2592000, -1];

/// `locked_until` of a lock that stays until a moderator lifts it.
pub const LOCKED_FOR_GOOD: i64 = i64::MAX;

/// Request body for resetting parts of a member's server profile.
#[derive(Deserialize, ToSchema)]
pub struct ProfileReset {
    /// The parts that go back to the account's values. May be empty when `lock_secs` is sent.
    pub fields: Vec<ProfileField>,
    /// Locks the member's server profile against their own edits: 86400 (1 day), 604800
    /// (7 days) or 2592000 (30 days) from now, or -1 until a moderator lifts the lock. Left out
    /// or `null` keeps the lock as it is.
    #[serde(default)]
    #[schema(example = 86400)]
    pub lock_secs: Option<i64>,
    /// Why, shown in the audit log; at most 300 characters.
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Stored {
    look: MemberLook,
    bio: Option<String>,
    banner_color: Option<String>,
    locked_until: Option<i64>,
}

impl Stored {
    fn locked(&self, at: i64) -> Option<i64> {
        self.locked_until.filter(|until| *until > at)
    }

    fn without(mut self, field: ProfileField) -> Stored {
        match field {
            ProfileField::Name => self.look.name = None,
            ProfileField::Bio => self.bio = None,
            ProfileField::Avatar => {
                self.look.avatar_kind = None;
                self.look.avatar_color = None;
            }
            ProfileField::Banner => self.banner_color = None,
        }
        self
    }

    fn is_empty(&self) -> bool {
        let Stored {
            look:
                MemberLook {
                    name,
                    avatar_kind,
                    avatar_color: _,
                },
            bio,
            banner_color,
            locked_until,
        } = self;
        name.is_none()
            && avatar_kind.is_none()
            && bio.is_none()
            && banner_color.is_none()
            && locked_until.is_none()
    }
}

const COLUMNS: &str = "name, bio, avatar_kind, avatar_color, banner_color, locked_until";

fn stored_row(r: &sqlx::any::AnyRow, at: usize) -> sqlx::Result<Stored> {
    let avatar_kind = r
        .try_get::<Option<String>, _>(at + 2)?
        .map(|k| AvatarKind::parse(&k))
        .transpose()?;
    Ok(Stored {
        look: MemberLook {
            name: r.try_get(at)?,
            avatar_kind,
            avatar_color: match avatar_kind {
                Some(_) => r.try_get(at + 3)?,
                None => None,
            },
        },
        bio: r.try_get(at + 1)?,
        banner_color: r.try_get(at + 4)?,
        locked_until: r.try_get(at + 5)?,
    })
}

async fn stored<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    ex: E,
    server: &str,
    username: &str,
) -> Result<Stored, ApiError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM member_profiles WHERE server = $1 AND username = $2"
    )))
    .bind(server)
    .bind(username)
    .fetch_optional(ex)
    .await?;
    Ok(match row {
        Some(r) => stored_row(&r, 0)?,
        None => Stored::default(),
    })
}

/// Until when the server profile of `username` in `server` is locked, when it is.
pub(crate) async fn locked_until(
    db: &Db,
    server: &str,
    username: &str,
) -> Result<Option<i64>, ApiError> {
    Ok(stored(db, server, username).await?.locked(now()))
}

/// What `server` lets its members set.
pub(crate) async fn mode_of(db: &Db, server: &str) -> Result<ProfilesMode, ApiError> {
    Ok(
        sqlx::query("SELECT profiles_mode FROM servers WHERE name = $1")
            .bind(server)
            .fetch_optional(db)
            .await?
            .map(|r| r.try_get::<String, _>(0))
            .transpose()?
            .map_or(ProfilesMode::All, |m| ProfilesMode::parse(&m)),
    )
}

/// Which parts of the stored profiles of a server are shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Shown {
    names: bool,
    rest: bool,
}

impl Shown {
    pub(crate) const NONE: Shown = Shown {
        names: false,
        rest: false,
    };

    pub(crate) fn names(self) -> bool {
        self.names
    }

    fn any(self) -> bool {
        self.names || self.rest
    }

    fn look(self, look: MemberLook) -> Option<MemberLook> {
        let MemberLook {
            name,
            avatar_kind,
            avatar_color,
        } = look;
        MemberLook {
            name: name.filter(|_| self.names),
            avatar_kind: avatar_kind.filter(|_| self.rest),
            avatar_color: avatar_color.filter(|_| self.rest),
        }
        .shown()
    }
}

/// Which parts of the profiles of `server` are shown: none while the site switch is off or the
/// server's mode is `off`, no names under `no_names` or while display names are off.
pub(crate) async fn shown_in(db: &Db, server: &str) -> Result<Shown, ApiError> {
    let settings = Settings::cached(db).await;
    if !settings.server_profiles {
        return Ok(Shown::NONE);
    }
    Ok(match mode_of(db, server).await? {
        ProfilesMode::All => Shown {
            names: settings.display_names,
            rest: true,
        },
        ProfilesMode::NoNames => Shown {
            names: false,
            rest: true,
        },
        ProfilesMode::Off => Shown::NONE,
    })
}

/// The looks of `usernames` in `server` as they are shown, for those who have one.
pub(crate) async fn looks_of(
    db: &Db,
    server: &str,
    usernames: &[String],
) -> Result<HashMap<String, MemberLook>, ApiError> {
    let mut out = HashMap::new();
    if usernames.is_empty() {
        return Ok(out);
    }
    let shown = shown_in(db, server).await?;
    if !shown.any() {
        return Ok(out);
    }
    let sql = format!(
        "SELECT username, {COLUMNS} FROM member_profiles WHERE server = $1 AND username IN ({})",
        placeholders(2, usernames.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for name in usernames {
        query = query.bind(name);
    }
    for r in &query.fetch_all(db).await? {
        if let Some(look) = shown.look(stored_row(r, 1)?.look) {
            out.insert(r.try_get(0)?, look);
        }
    }
    Ok(out)
}

/// The look of `username` in `server` as it is shown.
pub(crate) async fn look_of(
    db: &Db,
    server: &str,
    username: &str,
) -> Result<Option<MemberLook>, ApiError> {
    Ok(looks_of(db, server, &[username.to_string()])
        .await?
        .remove(username))
}

/// The description and banner color `username` set for `server`, as they are shown.
pub(crate) async fn bio_and_banner(
    db: &Db,
    server: &str,
    username: &str,
) -> Result<(Option<String>, Option<String>), ApiError> {
    match shown_in(db, server).await?.rest {
        true => {
            let Stored {
                look: _,
                bio,
                banner_color,
                locked_until: _,
            } = stored(db, server, username).await?;
            Ok((bio, banner_color))
        }
        false => Ok((None, None)),
    }
}

/// Usernames of members of `server` whose server name starts with `q` (lowercase), alphabetical
/// by that name, at most `limit`.
pub(crate) async fn named_like(
    db: &Db,
    server: &str,
    q: &str,
    end: Option<&str>,
    limit: i64,
) -> Result<Vec<String>, ApiError> {
    if !shown_in(db, server).await?.names() {
        return Ok(Vec::new());
    }
    let col = match crate::db::is_sqlite(db) {
        true => "lower(name)",
        false => "(lower(name) COLLATE \"C\")",
    };
    let upper = match end {
        Some(_) => format!(" AND {col} < $4"),
        None => String::new(),
    };
    let sql = format!(
        "SELECT username FROM member_profiles WHERE server = $1 AND name IS NOT NULL AND {col} >= $2{upper} ORDER BY {col}, username LIMIT $3"
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(server)
        .bind(q)
        .bind(limit);
    if let Some(end) = end {
        query = query.bind(end);
    }
    let mut out = Vec::new();
    for r in &query.fetch_all(db).await? {
        out.push(r.try_get(0)?);
    }
    Ok(out)
}

/// Drops the server profile of `username` in `server`, when their membership ends.
pub(crate) async fn forget(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    username: &str,
) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM member_profiles WHERE server = $1 AND username = $2")
        .bind(server)
        .bind(username)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn store(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    username: &str,
    profile: &Stored,
) -> Result<(), ApiError> {
    if profile.is_empty() {
        forget(conn, server, username).await?;
        return Ok(());
    }
    let Stored {
        look:
            MemberLook {
                name,
                avatar_kind,
                avatar_color,
            },
        bio,
        banner_color,
        locked_until,
    } = profile;
    sqlx::query(
        "INSERT INTO member_profiles(server, username, name, bio, avatar_kind, avatar_color, banner_color, locked_until, updated_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT(server, username) DO UPDATE SET name = excluded.name, bio = excluded.bio, avatar_kind = excluded.avatar_kind, avatar_color = excluded.avatar_color, banner_color = excluded.banner_color, locked_until = excluded.locked_until, updated_at = excluded.updated_at",
    )
    .bind(server)
    .bind(username)
    .bind(name.as_deref())
    .bind(bio.as_deref())
    .bind(avatar_kind.map(AvatarKind::as_str))
    .bind(avatar_color.as_deref())
    .bind(banner_color.as_deref())
    .bind(*locked_until)
    .bind(now())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

fn answer(user: &User, profile: Stored, mode: ProfilesMode, shown: Shown) -> ServerProfile {
    let Stored {
        look,
        bio,
        banner_color,
        locked_until,
    } = profile;
    let account = UserRef::from_user(user);
    let effective = match shown.look(look.clone()) {
        Some(look) => look.over(&account),
        None => account,
    };
    let (shown_bio, shown_banner) = match shown.rest {
        true => (bio.clone(), banner_color.clone()),
        false => (None, None),
    };
    ServerProfile {
        look,
        bio,
        banner_color,
        effective,
        effective_banner: shown_banner.or_else(|| user.banner_color.clone()),
        effective_bio: shown_bio.or_else(|| user.bio.clone()),
        mode,
        locked_until: locked_until.filter(|until| *until > now()),
    }
}

fn locked_error(until: i64) -> ApiError {
    ApiError::locked("A moderator locked your server profile", until)
}

/// `before` as its member may change it now: refused while a lock runs, and without a lock
/// that ended.
fn unlocked(before: &Stored) -> Result<Stored, ApiError> {
    match before.locked(now()) {
        Some(until) => Err(locked_error(until)),
        None => Ok(Stored {
            locked_until: None,
            ..before.clone()
        }),
    }
}

/// The caller's profile in the server `access` opened, when they are a member and server
/// profiles are on.
pub(crate) async fn mine(
    db: &Db,
    access: &ServerAccess,
) -> Result<Option<ServerProfile>, ApiError> {
    let user = match (access.viewer(), access.is_member()) {
        (Some(user), true) if Settings::cached(db).await.server_profiles => user,
        (_, _) => return Ok(None),
    };
    let key = access.name();
    Ok(Some(answer(
        user,
        stored(db, key, &user.username).await?,
        access.lite().profiles_mode,
        shown_in(db, key).await?,
    )))
}

/// The event that tells a server about the look of `username` in it. `bio` says the description
/// or banner changed.
pub(crate) async fn profile_event(
    db: &Db,
    server: &str,
    username: &str,
    bio: bool,
) -> Result<WsEvent, ApiError> {
    Ok(WsEvent::MemberProfile {
        server: server.to_string(),
        username: username.to_string(),
        profile: look_of(db, server, username).await?,
        bio,
        view_only: crate::api::servers::member_count(db, server).await? > USER_SCOPE_SMALL,
    })
}

fn mode_off(what: &str) -> ApiError {
    ApiError::off_server(
        StatusCode::FORBIDDEN,
        format!("{what} are off in this server"),
        "profiles_mode",
    )
}

/// The server a signed-in member opens to read or change their own profile there.
async fn own(state: &AppState, user: &User, name: &str) -> Result<(User, ServerAccess), ApiError> {
    if !Settings::cached(&state.db).await.server_profiles {
        return Err(not_found());
    }
    let user = acting_on(user, &user.username);
    let access = resolve_server(&state.db, name, Some(&user), &Proof::none()).await?;
    access.require_member()?;
    Ok((user, access))
}

async fn writable(state: &AppState, access: &ServerAccess, user: &User) -> Result<(), ApiError> {
    match timed_out(&state.db, access.name(), &user.username).await? {
        Some(_) => Err(timed_out_error()),
        None => Ok(()),
    }
}

/// Applies `change` to the stored profile of `user` in `key` as it is under the membership row
/// lock, refused while a moderator's lock runs, logs a name change and tells the server.
async fn save(
    state: &AppState,
    key: &str,
    user: &User,
    change: impl FnOnce(Stored) -> Stored,
) -> Result<Stored, ApiError> {
    let Some((mut tx, before)) = open_member(&state.db, key, &user.username).await? else {
        return Err(forbidden("Not a member"));
    };
    let next = change(unlocked(&before)?);
    if before == next {
        return Ok(next);
    }
    store(&mut tx, key, &user.username, &next).await?;
    if before.look.name != next.look.name {
        audit::record(
            &mut tx,
            Entry::new(
                key,
                &audit::Actor::of(user, false),
                audit::Action::MemberProfileName,
            )
            .target(Target::user(&user.username))
            .details(
                Details::new()
                    .set("old", before.look.name.clone())
                    .set("new", next.look.name.clone()),
            ),
        )
        .await?;
    }
    tx.commit().await?;
    let bio = before.bio != next.bio || before.banner_color != next.banner_color;
    state
        .hub
        .broadcast(profile_event(&state.db, key, &user.username, bio).await?);
    Ok(next)
}

/// Get your server profile
///
/// Returns the name, avatar, banner color and description the caller set for this server, how
/// they show in it (`effective`) and what the server lets members set (`mode`). Only for
/// signed-in members. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/profile",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "The caller's profile in the server", body = ServerProfile),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Not a member`", body = ApiErrorBody),
        (status = 404, description = "`Not found`: the `server_profiles` switch is off. `Server not found or wrong password`: no such server, or one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn get_profile(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<ServerProfile>, ApiError> {
    let (user, access) = own(&state, &user, &name).await?;
    let db = &state.read();
    let key = access.name();
    Ok(Json(answer(
        &user,
        stored(db, key, &user.username).await?,
        access.lite().profiles_mode,
        shown_in(db, key).await?,
    )))
}

/// Update your server profile
///
/// Sets the name, avatar, banner color and/or description the caller shows in this server.
/// Fields left out stay as they are and `null` goes back to the account's value. The name
/// follows the rules of the account's display name, with the name already set here free to
/// keep; a name equal to the account's display name is stored as `null`. Only for signed-in
/// members who are not timed out. A name change is logged in the audit log as
/// `member.profile_name`. Emits `member_profile` to the server and the caller. General
/// rate-limit bucket.
/// A new name is a rare request, counted with new display names: each account may try at most
/// `RARE_REQUESTS_PER_HOUR` (20) an hour and `RARE_REQUESTS_PER_DAY` (100) a day by default,
/// taken or free; your own username and the name you have here don't count.
#[utoipa::path(
    patch,
    path = "/api/v1/servers/{name}/profile",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = ServerProfilePatch,
    responses(
        (status = 200, description = "The caller's profile in the server after the change", body = ServerProfile),
        (status = 400, description = "A name that is blank, over 32 characters, holds control, format or invisible characters (`Display name has invalid characters`), passes for the instance staff (`That name is reserved`), is blocked by the profanity filter, or is new and passes for another account's username (`Username is taken`); `Description must be at most 190 characters` or a description blocked by the profanity filter; `Invalid avatar color`; `Invalid banner color`. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Not a member`; `You are timed out in this server`; the server's `profiles_mode` refuses the change (`reason.kind` `off_server`, `reason.control` `profiles_mode`): `Server profiles are off in this server`, or `Server names are off in this server` for a name; or `A moderator locked your server profile` (`reason.kind` `locked`, `reason.until` when the lock ends)", body = ApiErrorBody),
        (status = 404, description = "`Not found`: the `server_profiles` switch is off, or `name` was sent while the `display_names` switch is off. `Server not found or wrong password`: no such server, or one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "`You've done this too often. Try again later.` (JSON, with `Retry-After`): past the rare requests of this kind. Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn patch_profile(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<ServerProfilePatch>,
) -> Result<Json<ServerProfile>, ApiError> {
    let ServerProfilePatch {
        name: new_name,
        bio,
        avatar_kind,
        avatar_color,
        banner_color,
    } = req;
    let (user, access) = own(&state, &user, &name).await?;
    writable(&state, &access, &user).await?;
    let key = access.name().to_string();
    let mode = access.lite().profiles_mode;
    match (mode, &new_name) {
        (ProfilesMode::Off, _) => return Err(mode_off("Server profiles")),
        (ProfilesMode::NoNames, Some(_)) => return Err(mode_off("Server names")),
        (ProfilesMode::All, Some(_)) if !Settings::cached(&state.db).await.display_names => {
            return Err(not_found());
        }
        (ProfilesMode::All | ProfilesMode::NoNames, _) => {}
    }
    let seen = stored(&state.db, &key, &user.username).await?;
    unlocked(&seen)?;
    let new_name = match new_name {
        Some(Some(raw)) if raw.trim() != user.display_name => {
            let current = seen.look.name.as_deref().unwrap_or(&user.display_name);
            let name = Some(clean_name_for(&state, &user, &raw, current).await?)
                .filter(|name| *name != user.display_name);
            (name != seen.look.name).then_some(name)
        }
        Some(_) => Some(None),
        None => None,
    };
    let avatar = match avatar_kind {
        Some(Some(kind)) => Some((Some(kind), check_avatar(kind, avatar_color)?)),
        Some(None) => Some((None, None)),
        None => None,
    };
    let banner_color = banner_color.map(check_banner).transpose()?;
    let bio = match bio {
        Some(text) => {
            let text = clean_bio(text.as_deref().unwrap_or(""))?;
            if let Some(text) = &text {
                check_profanity(&state.db, ProfanityTarget::Bios, text).await?;
            }
            Some(text)
        }
        None => None,
    };
    let saved = save(&state, &key, &user, |mut next| {
        if let Some(name) = new_name {
            next.look.name = name;
        }
        if let Some((kind, color)) = avatar {
            (next.look.avatar_kind, next.look.avatar_color) = (kind, color);
        }
        if let Some(color) = banner_color {
            next.banner_color = color;
        }
        if let Some(text) = bio {
            next.bio = text;
        }
        next
    })
    .await?;
    Ok(Json(answer(
        &user,
        saved,
        mode,
        shown_in(&state.db, &key).await?,
    )))
}

/// Reset your server profile
///
/// Goes back to the account's name, avatar, banner color and description in this server. Only
/// for signed-in members who are not timed out. A removed name is logged in the audit log as
/// `member.profile_name`. Emits `member_profile` to the server and the caller when something
/// changed. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/servers/{name}/profile",
    tag = "Servers",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "The caller's profile in the server, every field `null`", body = ServerProfile),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Not a member`; `You are timed out in this server`; or `A moderator locked your server profile` (`reason.kind` `locked`, `reason.until` when the lock ends)", body = ApiErrorBody),
        (status = 404, description = "`Not found`: the `server_profiles` switch is off. `Server not found or wrong password`: no such server, or one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn delete_profile(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<ServerProfile>, ApiError> {
    let (user, access) = own(&state, &user, &name).await?;
    writable(&state, &access, &user).await?;
    let key = access.name().to_string();
    let saved = save(&state, &key, &user, |_| Stored::default()).await?;
    Ok(Json(answer(
        &user,
        saved,
        access.lite().profiles_mode,
        shown_in(&state.db, &key).await?,
    )))
}

/// Who may reset or unlock the server profile of `target` in this server, and how it is logged.
async fn moderator(db: &Db, access: &ServerAccess, target: &str) -> Result<audit::Actor, ApiError> {
    access.require_perm(db, Perm::ManageProfiles).await?;
    if !access.has_member(db, target).await? {
        return Err(not_found());
    }
    access.require_moderate(db, target).await?;
    let bypassed = access
        .bypassed(|m| async move {
            m.require_perm(db, Perm::ManageProfiles).await?;
            m.require_moderate(db, target).await
        })
        .await;
    Ok(access
        .audit_actor(db, Perm::ManageProfiles)
        .await?
        .staff_if(bypassed))
}

/// The server a moderator opens to act on the profile of another member, and that member.
async fn moderated(
    state: &AppState,
    user: &User,
    name: &str,
    username: &str,
) -> Result<(ServerAccess, String), ApiError> {
    if !Settings::cached(&state.db).await.server_profiles {
        return Err(not_found());
    }
    let target = username.to_lowercase();
    let user = acting_on(user, &target);
    let access = resolve_server(&state.db, name, Some(&user), &Proof::none()).await?;
    access.require_perm(&state.db, Perm::ManageProfiles).await?;
    Ok((access, target))
}

/// Opens a write of the server profile of `username` in `server`: the transaction, with their
/// membership row locked on Postgres so changes to one member's server profile run one after
/// another (SQLite has a single writer already), and their stored profile. `None` when they are
/// not a member.
async fn open_member<'a>(
    db: &'a Db,
    server: &str,
    username: &str,
) -> Result<Option<(sqlx::Transaction<'a, sqlx::Any>, Stored)>, ApiError> {
    let mut tx = db.begin().await?;
    let sql = match tx.backend_name() {
        "PostgreSQL" => "SELECT 1 FROM members WHERE server = $1 AND username = $2 FOR UPDATE",
        _ => "SELECT 1 FROM members WHERE server = $1 AND username = $2",
    };
    let member = sqlx::query(sql)
        .bind(server)
        .bind(username)
        .fetch_optional(&mut *tx)
        .await?;
    if member.is_none() {
        return Ok(None);
    }
    let profile = stored(&mut *tx, server, username).await?;
    Ok(Some((tx, profile)))
}

/// Reset a member's server profile
///
/// Puts the listed parts of the server profile of `username` back to the account's values, and
/// with `lock_secs` locks the profile so the member can't edit it until the lock ends or is
/// lifted. A moderator can only clear what a member set, never set it. Requires the Reset
/// server profiles permission, and the member's server permissions must be a strict subset of
/// yours. The lock ends when the member leaves or is removed. Logged in the audit log as
/// `member.profile_reset`. Emits `member_profile` to the server and the member when something
/// changed. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/members/{username}/profile/reset",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("username" = String, Path, description = "Member whose server profile is reset, case-insensitive")),
    request_body = ProfileReset,
    responses(
        (status = 200, description = "The parts are reset and the lock is set", body = OkResp),
        (status = 400, description = "`Choose what to reset` (no field and no lock), `Invalid lock` (`lock_secs` is not one of the four choices), a reason over 300 characters, or `You can't reset your own server profile`. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Reset server profiles permission, `You are timed out in this server`, or the member's server permissions are not a strict subset of yours (`You can't moderate this member`)", body = ApiErrorBody),
        (status = 404, description = "`Not found`: the `server_profiles` switch is off, or the user is not a member. `Server not found or wrong password`: no such server, or one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn reset_member_profile(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, username)): Path<(String, String)>,
    Json(req): Json<ProfileReset>,
) -> Result<Json<OkResp>, ApiError> {
    let ProfileReset {
        fields,
        lock_secs,
        reason,
    } = req;
    let (access, target) = moderated(&state, &user, &name, &username).await?;
    if target == user.username {
        return Err(bad("You can't reset your own server profile"));
    }
    if fields.is_empty() && lock_secs.is_none() {
        return Err(bad("Choose what to reset"));
    }
    if lock_secs.is_some_and(|secs| !LOCK_SECS.contains(&secs)) {
        return Err(ApiError::invalid("Invalid lock", "lock_secs"));
    }
    let reason = match reason
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
    {
        Some(r) => {
            check_len(&r, REASON_MAX, "Reason")?;
            Some(r)
        }
        None => None,
    };
    let key = access.name().to_string();
    let actor = moderator(&state.db, &access, &target).await?;
    let t = now();
    let Some((mut tx, before)) = open_member(&state.db, &key, &target).await? else {
        return Err(not_found());
    };
    let mut next = fields.iter().fold(before.clone(), |p, f| p.without(*f));
    next.locked_until = match lock_secs {
        Some(-1) => Some(LOCKED_FOR_GOOD),
        Some(secs) => Some(t + secs),
        None => before.locked(t),
    };
    let reset: Vec<&str> = ProfileField::ALL
        .into_iter()
        .filter(|f| fields.contains(f))
        .map(ProfileField::as_str)
        .collect();
    store(&mut tx, &key, &target, &next).await?;
    let details = Details::new().set("fields", reset).set(
        "old_name",
        before
            .look
            .name
            .clone()
            .filter(|_| fields.contains(&ProfileField::Name)),
    );
    let details = match lock_secs {
        Some(_) => details.set("lock_until", next.locked_until),
        None => details,
    };
    audit::record(
        &mut tx,
        Entry::new(&key, &actor, audit::Action::MemberProfileReset)
            .target(Target::user(&target))
            .details(details.set("reason", reason)),
    )
    .await?;
    tx.commit().await?;
    if before != next {
        let bio = before.bio != next.bio || before.banner_color != next.banner_color;
        state
            .hub
            .broadcast(profile_event(&state.db, &key, &target, bio).await?);
    }
    Ok(ok())
}

/// Unlock a member's server profile
///
/// Lifts the lock on the server profile of `username`, so they can edit it again. Succeeds
/// without changes when it is not locked. Same permissions as resetting it. Logged in the audit
/// log as `member.profile_unlock`. Emits `member_profile` to the server and the member when a
/// lock was lifted. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/servers/{name}/members/{username}/profile/lock",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("username" = String, Path, description = "Member whose server profile is unlocked, case-insensitive")),
    responses(
        (status = 200, description = "The server profile is not locked any more", body = OkResp),
        (status = 400, description = "`You can't unlock your own server profile`", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Reset server profiles permission, `You are timed out in this server`, or the member's server permissions are not a strict subset of yours (`You can't moderate this member`)", body = ApiErrorBody),
        (status = 404, description = "`Not found`: the `server_profiles` switch is off, or the user is not a member. `Server not found or wrong password`: no such server, or one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn unlock_member_profile(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, username)): Path<(String, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let (access, target) = moderated(&state, &user, &name, &username).await?;
    if target == user.username {
        return Err(bad("You can't unlock your own server profile"));
    }
    let key = access.name().to_string();
    let actor = moderator(&state.db, &access, &target).await?;
    let t = now();
    let Some((mut tx, before)) = open_member(&state.db, &key, &target).await? else {
        return Err(not_found());
    };
    let next = Stored {
        locked_until: None,
        ..before.clone()
    };
    if before != next {
        store(&mut tx, &key, &target, &next).await?;
    }
    let lifted = before.locked(t);
    if let Some(until) = lifted {
        audit::record(
            &mut tx,
            Entry::new(&key, &actor, audit::Action::MemberProfileUnlock)
                .target(Target::user(&target))
                .details(Details::new().change("lock_until", until, None::<i64>)),
        )
        .await?;
    }
    tx.commit().await?;
    if lifted.is_some() {
        state
            .hub
            .broadcast(profile_event(&state.db, &key, &target, false).await?);
    }
    Ok(ok())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use axum::extract::RawQuery;
    use axum::http::HeaderMap;
    use serde_json::{Value, json};

    use super::*;
    use crate::api::access::{DENIED, TIMED_OUT};
    use crate::api::servers::{leave_server, list_members};
    use crate::api::test_util::{add_member, done, each_db, mem_user, temp_state};
    use crate::api::{MaybeAuthed, Paged};

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("count")
    }

    /// `club` (creator alice) with bob and carol; dave is not a member, root is a site admin
    /// who is not one either. `vault` is a password server only alice is in.
    async fn club(tag: &str) -> (AppState, PathBuf) {
        let (state, path) = temp_state(tag).await;
        seed_club(&state.db).await;
        (state, path)
    }

    async fn seed_club(db: &Db) {
        for name in ["alice", "bob", "carol", "dave", "root"] {
            crate::db::NewUser::plain(name).add(db).await;
        }
        exec(
            db,
            "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
        )
        .await;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 0)").await;
        exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', 'hash', 0)").await;
        add_member(db, "club", "alice", 1, 0, 0).await;
        add_member(db, "vault", "alice", 1, 0, 0).await;
        for name in ["bob", "carol"] {
            add_member(db, "club", name, 0, 0, 0).await;
        }
    }

    fn who(name: &str) -> Authed {
        Authed(mem_user(name, name == "root"))
    }

    async fn patch_in(
        state: &AppState,
        server: &str,
        by: &str,
        body: Value,
    ) -> Result<ServerProfile, ApiError> {
        patch_profile(
            State(state.clone()),
            who(by),
            Path(server.to_string()),
            Json(serde_json::from_value(body).expect("body")),
        )
        .await
        .map(|Json(p)| p)
    }

    async fn patch(state: &AppState, by: &str, body: Value) -> Result<ServerProfile, ApiError> {
        patch_in(state, "club", by, body).await
    }

    async fn read(state: &AppState, server: &str, by: &str) -> Result<ServerProfile, ApiError> {
        get_profile(State(state.clone()), who(by), Path(server.to_string()))
            .await
            .map(|Json(p)| p)
    }

    fn refusal<T>(res: Result<T, ApiError>) -> (u16, String) {
        match res {
            Ok(_) => (200, String::new()),
            Err(ApiError(code, msg, _)) => (code.as_u16(), msg),
        }
    }

    async fn set(db: &Db, key: &str, value: &str) {
        sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(key)
            .bind(value)
            .execute(db)
            .await
            .expect("setting");
        Settings::load(db).await;
    }

    async fn listed(state: &AppState, by: Option<&str>) -> Vec<(String, Option<MemberLook>)> {
        let Paged(members, _) = list_members(
            State(state.clone()),
            MaybeAuthed(by.map(|name| mem_user(name, false))),
            HeaderMap::new(),
            Path("club".to_string()),
            RawQuery(None),
        )
        .await
        .unwrap_or_else(|e| panic!("list: {}", e.1));
        let mut out: Vec<(String, Option<MemberLook>)> = members
            .into_iter()
            .map(|m| (m.user.username, m.profile))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    fn named(name: &str) -> Option<MemberLook> {
        Some(MemberLook {
            name: Some(name.to_string()),
            avatar_kind: None,
            avatar_color: None,
        })
    }

    #[tokio::test]
    async fn server_names_follow_the_display_name_rules() {
        let (state, path) = club("profile_names").await;
        let limits = crate::limits::Limits {
            rare_requests_per_hour: 2,
            ..(*state.limits).clone()
        };
        let state = state.with_limits(std::sync::Arc::new(limits));
        let db = &state.db;
        crate::api::test_util::profanity_on(db).await;
        for (name, error) in [
            ("   ", "Display name required"),
            (
                &"x".repeat(33),
                "Display name must be at most 32 characters",
            ),
            ("Bo\u{200b}b", "Display name has invalid characters"),
            ("Instance Staff", "That name is reserved"),
            ("what the fuck", "Content blocked by profanity filter"),
            ("Carol", "Username is taken"),
        ] {
            assert_eq!(
                refusal(patch(&state, "bob", json!({"name": name})).await),
                (400, error.to_string()),
                "{name:?}"
            );
        }
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM member_profiles").await,
            0,
            "a refused name stores nothing"
        );
        let own = patch(&state, "bob", json!({"name": "BOB"}))
            .await
            .unwrap_or_else(|e| panic!("own username: {}", e.1));
        assert_eq!(own.look.name.as_deref(), Some("BOB"));
        assert_eq!(own.effective.display_name, "BOB");
        let same = patch(&state, "bob", json!({"name": " bob "}))
            .await
            .unwrap_or_else(|e| panic!("account name: {}", e.1));
        assert_eq!(same.look.name, None, "the account's name is not stored");
        assert_eq!(count(db, "SELECT COUNT(*) FROM member_profiles").await, 0);
        let first = patch(&state, "bob", json!({"name": "Robert"}))
            .await
            .unwrap_or_else(|e| panic!("new name: {}", e.1));
        assert_eq!(first.look, named("Robert").expect("look"));
        for _ in 0..3 {
            patch(&state, "bob", json!({"name": "Robert"}))
                .await
                .unwrap_or_else(|e| panic!("the name he has: {}", e.1));
        }
        assert_eq!(
            refusal(patch(&state, "bob", json!({"name": "Roberto"})).await).0,
            429,
            "the display name budget of 2 an hour is used up by Carol and Robert"
        );
        let rows = sqlx::query(
            "SELECT actor, target_name, details FROM audit_log WHERE action = 'member.profile_name' ORDER BY id",
        )
        .fetch_all(db)
        .await
        .expect("audit");
        let logged: Vec<(String, String, Value)> = rows
            .iter()
            .map(|r| {
                (
                    r.get::<String, _>(0),
                    r.get::<String, _>(1),
                    serde_json::from_str(&r.get::<String, _>(2)).expect("details"),
                )
            })
            .collect();
        assert_eq!(logged.len(), 3, "{logged:?}");
        assert!(logged.iter().all(|(a, t, _)| a == "bob" && t == "bob"));
        assert_eq!(logged[2].2["old"], Value::Null);
        assert_eq!(logged[2].2["new"], json!("Robert"));
        done(state, path).await;
    }

    #[tokio::test]
    async fn profile_fields_merge_and_empty_rows_are_dropped() {
        let (state, path) = club("profile_fields").await;
        let db = &state.db;
        let set_all = patch(
            &state,
            "bob",
            json!({"bio": " here \n\n\n\n now ", "avatar_kind": "identicon", "banner_color": "#AABBCC"}),
        )
        .await
        .unwrap_or_else(|e| panic!("set: {}", e.1));
        assert_eq!(set_all.bio.as_deref(), Some("here \n\n now"));
        assert_eq!(set_all.banner_color.as_deref(), Some("#aabbcc"));
        assert_eq!(
            (set_all.look.avatar_kind, set_all.look.avatar_color.clone()),
            (Some(AvatarKind::Identicon), None),
            "an explicit identicon"
        );
        for (body, error) in [
            (json!({"avatar_kind": "color"}), "Invalid avatar color"),
            (
                json!({"avatar_kind": "color", "avatar_color": "red"}),
                "Invalid avatar color",
            ),
            (json!({"banner_color": "blue"}), "Invalid banner color"),
            (
                json!({"bio": "x".repeat(191)}),
                "Description must be at most 190 characters",
            ),
        ] {
            assert_eq!(
                refusal(patch(&state, "bob", body).await),
                (400, error.to_string())
            );
        }
        let kept = patch(&state, "bob", json!({"avatar_color": "#000000"}))
            .await
            .unwrap_or_else(|e| panic!("a color alone: {}", e.1));
        assert_eq!(kept.look, set_all.look, "avatar_color alone is not read");
        let partly = patch(&state, "bob", json!({"bio": null, "avatar_kind": null}))
            .await
            .unwrap_or_else(|e| panic!("inherit: {}", e.1));
        assert_eq!((partly.bio, partly.look.avatar_kind), (None, None));
        assert_eq!(partly.banner_color.as_deref(), Some("#aabbcc"));
        assert_eq!(count(db, "SELECT COUNT(*) FROM member_profiles").await, 1);
        let cleared = delete_profile(State(state.clone()), who("bob"), Path("club".to_string()))
            .await
            .map(|Json(p)| p)
            .unwrap_or_else(|e| panic!("reset: {}", e.1));
        assert_eq!(cleared.look, MemberLook::default());
        assert_eq!((cleared.bio, cleared.banner_color), (None, None));
        assert_eq!(count(db, "SELECT COUNT(*) FROM member_profiles").await, 0);
        done(state, path).await;
    }

    #[tokio::test]
    async fn profile_routes_hide_unknown_and_hidden_servers_alike() {
        let (state, path) = club("profile_hidden").await;
        let denied = (404, DENIED.to_string());
        for server in ["vault", "nowhere"] {
            assert_eq!(refusal(read(&state, server, "bob").await), denied);
            assert_eq!(
                refusal(patch_in(&state, server, "bob", json!({"name": "Bobby"})).await),
                denied
            );
            assert_eq!(
                refusal(
                    delete_profile(State(state.clone()), who("bob"), Path(server.to_string()))
                        .await
                ),
                denied
            );
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn non_members_and_guests_have_no_profile() {
        use crate::server::client_ip::{ClientIp, ProxyTrust};
        let (state, path) = club("profile_outside").await;
        let trusted = ProxyTrust::from_config(false, Some("127.0.0.1")).expect("trust");
        let app = crate::api::routes(
            state.clone(),
            &crate::config::Roles::ALL,
            ClientIp(trusted),
            None,
        )
        .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
        });
        let client = reqwest::Client::new();
        let url = format!("http://{addr}/servers/club/profile");
        for grant in [None, Some("some-guest-grant")] {
            for req in [
                client.get(&url),
                client
                    .patch(&url)
                    .header("content-type", "application/json")
                    .body(r#"{"bio":"hi"}"#),
                client.delete(&url),
            ] {
                let req = match grant {
                    Some(grant) => req.header("x-guest-grant", grant),
                    None => req,
                };
                let res = req.send().await.expect("request");
                assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{grant:?}");
            }
        }
        server.abort();
        for outsider in ["dave", "root"] {
            assert_eq!(
                refusal(read(&state, "club", outsider).await),
                (403, "Not a member".to_string()),
                "{outsider}"
            );
            assert_eq!(
                refusal(patch(&state, outsider, json!({"bio": "hi"})).await),
                (403, "Not a member".to_string()),
                "{outsider}"
            );
        }
        assert_eq!(
            count(&state.db, "SELECT COUNT(*) FROM member_profiles").await,
            0
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn timed_out_members_cannot_edit_their_profile() {
        let (state, path) = club("profile_timeout").await;
        let db = &state.db;
        patch(&state, "bob", json!({"bio": "before"}))
            .await
            .unwrap_or_else(|e| panic!("before: {}", e.1));
        exec(db, &format!("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('club', 'bob', {}, 0)", now() + 600)).await;
        assert_eq!(
            refusal(patch(&state, "bob", json!({"bio": "during"})).await),
            (403, TIMED_OUT.to_string())
        );
        assert_eq!(
            refusal(
                delete_profile(State(state.clone()), who("bob"), Path("club".to_string())).await
            ),
            (403, TIMED_OUT.to_string())
        );
        let seen = read(&state, "club", "bob")
            .await
            .unwrap_or_else(|e| panic!("read: {}", e.1));
        assert_eq!(seen.bio.as_deref(), Some("before"));
        done(state, path).await;
    }

    #[tokio::test]
    async fn profiles_mode_no_names_refuses_names() {
        let (state, path) = club("profile_no_names").await;
        let db = &state.db;
        patch(&state, "bob", json!({"name": "Robert", "bio": "hi"}))
            .await
            .unwrap_or_else(|e| panic!("under all: {}", e.1));
        exec(db, "UPDATE servers SET profiles_mode = 'no_names'").await;
        let ApiError(code, msg, reason) = patch(&state, "bob", json!({"name": "Rob"}))
            .await
            .expect_err("a name under no_names");
        assert_eq!(
            (code.as_u16(), msg.as_str()),
            (403, "Server names are off in this server")
        );
        assert_eq!(
            serde_json::to_value(reason).expect("reason"),
            json!({"kind": "off_server", "control": "profiles_mode"})
        );
        let rest = patch(&state, "bob", json!({"bio": "still"}))
            .await
            .unwrap_or_else(|e| panic!("a bio under no_names: {}", e.1));
        assert_eq!(rest.mode, ProfilesMode::NoNames);
        assert_eq!(rest.look.name.as_deref(), Some("Robert"), "kept");
        assert_eq!(rest.effective.display_name, "bob", "and not shown");
        assert_eq!(
            listed(&state, Some("carol")).await[1],
            ("bob".to_string(), None)
        );
        exec(db, "UPDATE servers SET profiles_mode = 'all'").await;
        assert_eq!(
            listed(&state, Some("carol")).await[1],
            ("bob".to_string(), named("Robert"))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn profiles_mode_off_hides_stored_profiles() {
        let (state, path) = club("profile_mode_off").await;
        let db = &state.db;
        patch(
            &state,
            "bob",
            json!({"name": "Robert", "bio": "hi", "avatar_kind": "color", "avatar_color": "#123456"}),
        )
        .await
        .unwrap_or_else(|e| panic!("under all: {}", e.1));
        exec(db, "UPDATE servers SET profiles_mode = 'off'").await;
        assert_eq!(
            refusal(patch(&state, "bob", json!({"bio": "more"})).await),
            (403, "Server profiles are off in this server".to_string())
        );
        let mine = read(&state, "club", "bob")
            .await
            .unwrap_or_else(|e| panic!("read: {}", e.1));
        assert_eq!(mine.mode, ProfilesMode::Off);
        assert_eq!(mine.effective, UserRef::from_user(&mem_user("bob", false)));
        assert_eq!(mine.effective_bio, None);
        assert!(
            listed(&state, Some("carol"))
                .await
                .iter()
                .all(|m| m.1.is_none())
        );
        assert_eq!(
            bio_and_banner(db, "club", "bob").await.expect("bio"),
            (None, None)
        );
        exec(db, "UPDATE servers SET profiles_mode = 'all'").await;
        let back = read(&state, "club", "bob")
            .await
            .unwrap_or_else(|e| panic!("read: {}", e.1));
        assert_eq!(back.effective.display_name, "Robert");
        assert_eq!(back.effective.avatar_color.as_deref(), Some("#123456"));
        assert_eq!(back.effective_bio.as_deref(), Some("hi"));
        done(state, path).await;
    }

    #[tokio::test]
    async fn server_profiles_are_on_by_default() {
        let (state, path) = club("profile_default").await;
        assert!(Settings::cached(&state.db).await.server_profiles);
        assert!(crate::api::features::Feature::ServerProfiles.default_on());
        assert_eq!(
            mode_of(&state.db, "club").await.expect("mode"),
            ProfilesMode::All
        );
        let mine = read(&state, "club", "bob")
            .await
            .unwrap_or_else(|e| panic!("read: {}", e.1));
        assert_eq!(mine.look, MemberLook::default());
        assert_eq!(mine.locked_until, None);
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_site_switch_hides_server_profiles() {
        let (state, path) = club("profile_switch").await;
        let db = &state.db;
        patch(&state, "bob", json!({"name": "Robert", "bio": "hi"}))
            .await
            .unwrap_or_else(|e| panic!("set: {}", e.1));
        set(db, "server_profiles", "0").await;
        let gone = (404, crate::api::access::NOT_FOUND.to_string());
        assert_eq!(refusal(read(&state, "club", "bob").await), gone);
        assert_eq!(refusal(read(&state, "nowhere", "bob").await), gone);
        assert_eq!(
            refusal(patch(&state, "bob", json!({"bio": "x"})).await),
            gone
        );
        assert!(
            listed(&state, Some("carol"))
                .await
                .iter()
                .all(|m| m.1.is_none())
        );
        assert_eq!(count(db, "SELECT COUNT(*) FROM member_profiles").await, 1);
        set(db, "server_profiles", "1").await;
        set(db, "display_names", "0").await;
        assert_eq!(
            refusal(patch(&state, "bob", json!({"name": "Rob"})).await),
            gone,
            "a name while display names are off"
        );
        assert_eq!(
            listed(&state, Some("carol")).await[1],
            ("bob".to_string(), None),
            "names are not shown while display names are off"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn profiles_end_with_the_membership() {
        let (state, path) = club("profile_leave").await;
        let db = &state.db;
        for name in ["bob", "carol"] {
            patch(&state, name, json!({"bio": "hi"}))
                .await
                .unwrap_or_else(|e| panic!("set: {}", e.1));
        }
        let _ = leave_server(State(state.clone()), who("bob"), Path("club".to_string()))
            .await
            .unwrap_or_else(|e| panic!("leave: {}", e.1));
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM member_profiles WHERE username = 'bob'"
            )
            .await,
            0
        );
        let mut conn = db.acquire().await.expect("conn");
        crate::api::servers::end_membership(&mut conn, "club", "carol")
            .await
            .expect("kick");
        drop(conn);
        assert_eq!(count(db, "SELECT COUNT(*) FROM member_profiles").await, 0);
        done(state, path).await;
    }

    #[tokio::test]
    async fn member_lists_carry_looks_where_members_show() {
        let (state, path) = club("profile_lists").await;
        let db = &state.db;
        patch(
            &state,
            "bob",
            json!({"name": "Robert", "avatar_kind": "color", "avatar_color": "#123456"}),
        )
        .await
        .unwrap_or_else(|e| panic!("set: {}", e.1));
        let look = Some(MemberLook {
            name: Some("Robert".to_string()),
            avatar_kind: Some(AvatarKind::Color),
            avatar_color: Some("#123456".to_string()),
        });
        assert_eq!(
            listed(&state, Some("carol")).await,
            [
                ("alice".to_string(), None),
                ("bob".to_string(), look.clone()),
                ("carol".to_string(), None)
            ]
        );
        exec(db, "UPDATE servers SET public_read = 1").await;
        assert_eq!(listed(&state, Some("dave")).await[1].1, look);
        exec(db, "UPDATE servers SET members_visible = 0").await;
        assert!(listed(&state, Some("dave")).await.is_empty());
        done(state, path).await;
    }

    #[tokio::test]
    async fn profile_changes_tell_the_server_about_one_member() {
        let (state, path) = club("profile_event").await;
        let mut rx = state.hub.subscribe();
        patch(&state, "bob", json!({"name": "Robert"}))
            .await
            .unwrap_or_else(|e| panic!("name: {}", e.1));
        patch(&state, "bob", json!({"name": "Robert"}))
            .await
            .unwrap_or_else(|e| panic!("again: {}", e.1));
        patch(&state, "bob", json!({"bio": "secret words"}))
            .await
            .unwrap_or_else(|e| panic!("bio: {}", e.1));
        let mut seen = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::MemberProfile {
                server,
                username,
                profile,
                bio,
                view_only,
            } = &ev
            {
                assert_eq!((server.as_str(), username.as_str()), ("club", "bob"));
                assert!(!view_only);
                assert!(!serde_json::to_string(&ev).expect("json").contains("secret"));
                seen.push((profile.clone(), *bio));
            }
        }
        assert_eq!(seen, [(named("Robert"), false), (named("Robert"), true)]);
        done(state, path).await;
    }

    async fn reset_in(
        state: &AppState,
        by: &str,
        target: &str,
        body: Value,
    ) -> Result<(), ApiError> {
        reset_member_profile(
            State(state.clone()),
            who(by),
            Path(("club".to_string(), target.to_string())),
            Json(serde_json::from_value(body).expect("body")),
        )
        .await
        .map(|Json(_)| ())
    }

    async fn unlock_in(state: &AppState, by: &str, target: &str) -> Result<(), ApiError> {
        unlock_member_profile(
            State(state.clone()),
            who(by),
            Path(("club".to_string(), target.to_string())),
        )
        .await
        .map(|Json(_)| ())
    }

    async fn moderators(db: &Db) {
        let mods = Perm::ManageProfiles as i64 | Perm::Kick as i64;
        exec(
            db,
            &format!("UPDATE members SET is_admin = 1, perms = {mods} WHERE server = 'club' AND username = 'carol'"),
        )
        .await;
    }

    fn all_of_it() -> Value {
        json!({"name": "Robert", "bio": "words", "avatar_kind": "color", "avatar_color": "#112233", "banner_color": "#445566"})
    }

    #[tokio::test]
    async fn reset_needs_manage_profiles_and_outranking() {
        let (state, path) = club("profile_reset").await;
        let db = &state.db;
        moderators(db).await;
        for name in ["alice", "bob", "carol"] {
            patch(&state, name, all_of_it())
                .await
                .unwrap_or_else(|e| panic!("set {name}: {}", e.1));
        }
        let name_only = json!({"fields": ["name"]});
        assert_eq!(
            refusal(reset_in(&state, "bob", "carol", name_only.clone()).await),
            (403, "Missing permission".to_string())
        );
        assert_eq!(
            refusal(unlock_in(&state, "bob", "carol").await),
            (403, "Missing permission".to_string())
        );
        for target in ["alice", "ALICE"] {
            assert_eq!(
                refusal(reset_in(&state, "carol", target, name_only.clone()).await),
                (403, "You can't moderate this member".to_string())
            );
        }
        assert_eq!(
            refusal(unlock_in(&state, "carol", "alice").await),
            (403, "You can't moderate this member".to_string())
        );
        assert_eq!(
            refusal(reset_in(&state, "carol", "carol", name_only.clone()).await).0,
            400
        );
        assert_eq!(refusal(unlock_in(&state, "carol", "carol").await).0, 400);
        for (body, text) in [
            (json!({"fields": []}), "Choose what to reset"),
            (json!({"fields": ["name"], "lock_secs": 60}), "Invalid lock"),
            (json!({"fields": ["name"], "lock_secs": 0}), "Invalid lock"),
        ] {
            assert_eq!(
                refusal(reset_in(&state, "carol", "bob", body).await),
                (400, text.to_string())
            );
        }
        let long = "x".repeat(REASON_MAX + 1);
        assert_eq!(
            refusal(
                reset_in(
                    &state,
                    "carol",
                    "bob",
                    json!({"fields": ["name"], "reason": long})
                )
                .await
            )
            .0,
            400
        );
        exec(db, &format!("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('club', 'carol', {}, 0)", now() + 600)).await;
        assert_eq!(
            refusal(reset_in(&state, "carol", "bob", name_only.clone()).await),
            (403, TIMED_OUT.to_string())
        );
        exec(db, "DELETE FROM member_timeouts").await;
        assert_eq!(count(db, "SELECT COUNT(*) FROM audit_log WHERE action LIKE 'member.profile_re%' OR action = 'member.profile_unlock'").await, 0);

        let mut rx = state.hub.subscribe();
        reset_in(
            &state,
            "carol",
            "BOB",
            json!({"fields": ["name", "avatar"], "reason": "  not that  "}),
        )
        .await
        .unwrap_or_else(|e| panic!("reset: {}", e.1));
        let seen = read(&state, "club", "bob")
            .await
            .unwrap_or_else(|e| panic!("read: {}", e.1));
        assert_eq!(seen.look, MemberLook::default());
        assert_eq!(seen.bio.as_deref(), Some("words"));
        assert_eq!(seen.banner_color.as_deref(), Some("#445566"));
        assert_eq!(seen.locked_until, None);
        reset_in(&state, "alice", "bob", json!({"fields": ["banner", "bio"]}))
            .await
            .unwrap_or_else(|e| panic!("reset: {}", e.1));
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM member_profiles WHERE username = 'bob'"
            )
            .await,
            0
        );
        reset_in(&state, "alice", "bob", json!({"fields": ["bio"]}))
            .await
            .unwrap_or_else(|e| panic!("nothing left: {}", e.1));
        let mut events = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::MemberProfile {
                server: _,
                username,
                profile,
                bio,
                view_only: _,
            } = ev
            {
                events.push((username, profile, bio));
            }
        }
        assert_eq!(
            events,
            [
                ("bob".to_string(), None, false),
                ("bob".to_string(), None, true)
            ]
        );
        reset_in(
            &state,
            "root",
            "carol",
            json!({"fields": ["name"], "lock_secs": 86400}),
        )
        .await
        .unwrap_or_else(|e| panic!("staff: {}", e.1));
        let rows = sqlx::query(
            "SELECT actor, staff, target_name, details FROM audit_log WHERE action = 'member.profile_reset' ORDER BY id",
        )
        .fetch_all(db)
        .await
        .expect("audit");
        let logged: Vec<(Option<String>, i64, String, Value)> = rows
            .iter()
            .map(|r| {
                (
                    r.get(0),
                    r.get(1),
                    r.get(2),
                    serde_json::from_str(&r.get::<String, _>(3)).expect("details"),
                )
            })
            .collect();
        assert_eq!(logged.len(), 4, "{logged:?}");
        assert_eq!(
            (logged[0].0.as_deref(), logged[0].1, logged[0].2.as_str()),
            (Some("carol"), 0, "bob")
        );
        assert_eq!(logged[0].3["fields"], json!(["name", "avatar"]));
        assert_eq!(logged[0].3["old_name"], json!("Robert"));
        assert_eq!(logged[0].3.get("lock_until"), None);
        assert_eq!(logged[0].3["reason"], json!("not that"));
        assert_eq!(logged[1].3["fields"], json!(["bio", "banner"]));
        assert_eq!(logged[1].3["old_name"], Value::Null);
        assert_eq!(
            (logged[3].0.as_deref(), logged[3].1, logged[3].2.as_str()),
            (None, 1, "carol")
        );
        assert!(
            logged[3].3["lock_until"]
                .as_i64()
                .is_some_and(|until| until > now())
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn reset_of_a_non_member_is_not_found() {
        let (state, path) = club("profile_reset_outside").await;
        let body = json!({"fields": ["name"]});
        for target in ["dave", "nobody"] {
            for by in ["alice", "root"] {
                assert_eq!(
                    refusal(reset_in(&state, by, target, body.clone()).await),
                    (404, crate::api::access::NOT_FOUND.to_string()),
                    "{by} on {target}"
                );
                assert_eq!(
                    refusal(unlock_in(&state, by, target).await),
                    (404, crate::api::access::NOT_FOUND.to_string()),
                    "{by} on {target}"
                );
            }
        }
        for by in ["dave", "bob"] {
            let res = reset_member_profile(
                State(state.clone()),
                who(by),
                Path(("vault".to_string(), "alice".to_string())),
                Json(serde_json::from_value(body.clone()).expect("body")),
            )
            .await;
            assert_eq!(refusal(res), (404, DENIED.to_string()));
        }
        set(&state.db, "server_profiles", "0").await;
        assert_eq!(
            refusal(reset_in(&state, "alice", "bob", body.clone()).await),
            (404, crate::api::access::NOT_FOUND.to_string())
        );
        assert_eq!(
            refusal(unlock_in(&state, "alice", "bob").await),
            (404, crate::api::access::NOT_FOUND.to_string())
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_locked_profile_refuses_edits_until_it_expires_or_is_unlocked() {
        let (state, path) = club("profile_lock").await;
        let db = &state.db;
        moderators(db).await;
        patch(&state, "bob", all_of_it())
            .await
            .unwrap_or_else(|e| panic!("set: {}", e.1));
        let before = now();
        reset_in(
            &state,
            "carol",
            "bob",
            json!({"fields": ["name"], "lock_secs": 604800}),
        )
        .await
        .unwrap_or_else(|e| panic!("lock: {}", e.1));
        let seen = read(&state, "club", "bob")
            .await
            .unwrap_or_else(|e| panic!("read: {}", e.1));
        let until = seen.locked_until.expect("locked");
        assert!((before + 604800..=now() + 604800).contains(&until));
        assert_eq!((seen.look.name, seen.bio.as_deref()), (None, Some("words")));
        let refused = |res: Result<Json<ServerProfile>, ApiError>| match res {
            Ok(_) => panic!("a locked profile was changed"),
            Err(ApiError(code, text, reason)) => {
                let reason = reason.expect("reason");
                (code.as_u16(), text, reason.kind, reason.until)
            }
        };
        let locked = |until: i64| {
            (
                403,
                "A moderator locked your server profile".to_string(),
                crate::api::ReasonKind::Locked,
                Some(until),
            )
        };
        assert_eq!(
            refused(
                patch(&state, "bob", json!({"name": "Bobby"}))
                    .await
                    .map(Json)
            ),
            locked(until)
        );
        assert_eq!(
            refused(patch(&state, "bob", json!({"bio": null})).await.map(Json)),
            locked(until)
        );
        assert_eq!(
            refused(
                delete_profile(State(state.clone()), who("bob"), Path("club".to_string())).await
            ),
            locked(until)
        );
        reset_in(&state, "carol", "bob", json!({"fields": ["bio"]}))
            .await
            .unwrap_or_else(|e| panic!("a reset without a lock: {}", e.1));
        assert_eq!(
            locked_until(db, "club", "bob").await.expect("lock"),
            Some(until)
        );
        reset_in(
            &state,
            "carol",
            "bob",
            json!({"fields": [], "lock_secs": -1}),
        )
        .await
        .unwrap_or_else(|e| panic!("for good: {}", e.1));
        assert_eq!(
            refused(
                patch(&state, "bob", json!({"name": "Bobby"}))
                    .await
                    .map(Json)
            ),
            locked(LOCKED_FOR_GOOD)
        );

        let mut rx = state.hub.subscribe();
        unlock_in(&state, "carol", "bob")
            .await
            .unwrap_or_else(|e| panic!("unlock: {}", e.1));
        unlock_in(&state, "carol", "bob")
            .await
            .unwrap_or_else(|e| panic!("unlock again: {}", e.1));
        let mut told = 0;
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::MemberProfile { .. } = ev {
                told += 1;
            }
        }
        assert_eq!(told, 1);
        assert_eq!(count(db, "SELECT COUNT(*) FROM audit_log WHERE action = 'member.profile_unlock' AND actor = 'carol' AND target_name = 'bob'").await, 1);
        let seen = patch(&state, "bob", json!({"name": "Bobby"}))
            .await
            .unwrap_or_else(|e| panic!("after the unlock: {}", e.1));
        assert_eq!(
            (seen.look.name.as_deref(), seen.locked_until),
            (Some("Bobby"), None)
        );

        reset_in(
            &state,
            "carol",
            "bob",
            json!({"fields": ["name", "banner", "avatar"], "lock_secs": 86400}),
        )
        .await
        .unwrap_or_else(|e| panic!("lock: {}", e.1));
        exec(
            db,
            &format!(
                "UPDATE member_profiles SET locked_until = {} WHERE username = 'bob'",
                now() - 1
            ),
        )
        .await;
        assert_eq!(locked_until(db, "club", "bob").await.expect("lock"), None);
        assert_eq!(
            read(&state, "club", "bob")
                .await
                .unwrap_or_else(|e| panic!("read: {}", e.1))
                .locked_until,
            None
        );
        unlock_in(&state, "carol", "bob")
            .await
            .unwrap_or_else(|e| panic!("nothing to lift: {}", e.1));
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM audit_log WHERE action = 'member.profile_unlock'"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM member_profiles WHERE username = 'bob'"
            )
            .await,
            0,
            "an ended lock alone is not kept"
        );
        patch(&state, "bob", json!({"bio": "back"}))
            .await
            .unwrap_or_else(|e| panic!("after the lock ended: {}", e.1));

        reset_in(
            &state,
            "carol",
            "bob",
            json!({"fields": [], "lock_secs": -1}),
        )
        .await
        .unwrap_or_else(|e| panic!("lock: {}", e.1));
        let _ = leave_server(State(state.clone()), who("bob"), Path("club".to_string()))
            .await
            .unwrap_or_else(|e| panic!("leave: {}", e.1));
        assert_eq!(count(db, "SELECT COUNT(*) FROM member_profiles").await, 0);
        add_member(db, "club", "bob", 0, 0, 0).await;
        patch(&state, "bob", json!({"name": "Bobby"}))
            .await
            .unwrap_or_else(|e| panic!("after joining again: {}", e.1));
        done(state, path).await;
    }

    #[tokio::test]
    async fn an_edit_applies_to_the_profile_as_it_is_when_saved() {
        for (state, temp) in each_db("profile_edit_race").await {
            seed_club(&state.db).await;
            edit_applies_when_saved(&state).await;
            temp.done(state).await;
        }
    }

    async fn edit_applies_when_saved(state: &AppState) {
        let db = &state.db;
        moderators(db).await;
        patch(state, "bob", all_of_it())
            .await
            .unwrap_or_else(|e| panic!("set: {}", e.1));
        let bob = mem_user("bob", false);
        let seen = stored(db, "club", "bob").await.expect("read");
        unlocked(&seen).expect("not locked yet");
        reset_in(state, "carol", "bob", json!({"fields": ["bio"]}))
            .await
            .unwrap_or_else(|e| panic!("reset: {}", e.1));
        let saved = save(state, "club", &bob, |mut next| {
            next.banner_color = Some("#000000".to_string());
            next
        })
        .await
        .unwrap_or_else(|e| panic!("save: {}", e.1));
        assert_eq!(
            (saved.bio, saved.banner_color.as_deref(), saved.look.name),
            (None, Some("#000000"), Some("Robert".to_string()))
        );

        let seen = stored(db, "club", "bob").await.expect("read");
        unlocked(&seen).expect("not locked yet");
        reset_in(
            state,
            "carol",
            "bob",
            json!({"fields": ["name"], "lock_secs": 604800}),
        )
        .await
        .unwrap_or_else(|e| panic!("lock: {}", e.1));
        let res = save(state, "club", &bob, |mut next| {
            next.look.name = seen.look.name.clone();
            next.bio = Some("new".to_string());
            next
        })
        .await;
        assert_eq!(
            refusal(res),
            (403, "A moderator locked your server profile".to_string())
        );
        let res = save(state, "club", &bob, |_| Stored::default()).await;
        assert_eq!(refusal(res).0, 403);
        let after = stored(db, "club", "bob").await.expect("read");
        assert_eq!(
            (
                after.locked(now()).is_some(),
                after.look.name,
                after.bio,
                after.banner_color.as_deref()
            ),
            (true, None, None, Some("#000000"))
        );
    }

    #[tokio::test]
    async fn profile_writes_need_the_membership_when_they_are_saved() {
        for (state, temp) in each_db("profile_write_member").await {
            seed_club(&state.db).await;
            writes_need_the_membership(&state).await;
            temp.done(state).await;
        }
    }

    async fn writes_need_the_membership(state: &AppState) {
        let db = &state.db;
        patch(state, "bob", all_of_it())
            .await
            .unwrap_or_else(|e| panic!("set: {}", e.1));
        assert!(
            open_member(db, "club", "bob")
                .await
                .expect("open")
                .is_some()
        );
        assert!(
            open_member(db, "club", "dave")
                .await
                .expect("open")
                .is_none()
        );
        exec(
            db,
            "DELETE FROM members WHERE server = 'club' AND username = 'bob'",
        )
        .await;
        exec(
            db,
            "DELETE FROM member_profiles WHERE server = 'club' AND username = 'bob'",
        )
        .await;
        assert!(
            open_member(db, "club", "bob")
                .await
                .expect("open")
                .is_none()
        );
        let res = save(state, "club", &mem_user("bob", false), |mut next| {
            next.bio = Some("still here".to_string());
            next
        })
        .await;
        assert_eq!(refusal(res), (403, "Not a member".to_string()));
        assert_eq!(count(db, "SELECT COUNT(*) FROM member_profiles").await, 0);
    }

    #[test]
    fn the_field_limits_match_the_shared_table() {
        let table: Value =
            serde_json::from_str(include_str!("../../../../assets/profile_fields.json"))
                .expect("profile_fields.json");
        assert_eq!(
            table["name"]["max"],
            json!(crate::api::auth::DISPLAY_NAME_MAX)
        );
        assert_eq!(table["bio"]["max"], json!(crate::api::auth::BIO_MAX));
        let pattern = table["color"]["pattern"].as_str().expect("pattern");
        assert_eq!(pattern, "^#[0-9a-fA-F]{6}$");
        for (color, ok) in [("#a1B2c3", true), ("#12345", false), ("123456", false)] {
            assert_eq!(check_banner(Some(color.to_string())).is_ok(), ok, "{color}");
        }
        assert_eq!(
            table["avatar_kinds"],
            json!([AvatarKind::Identicon.as_str(), AvatarKind::Color.as_str()])
        );
        assert_eq!(
            table["modes"],
            json!([
                ProfilesMode::All.as_str(),
                ProfilesMode::NoNames.as_str(),
                ProfilesMode::Off.as_str()
            ])
        );
        assert_eq!(
            table["reset_fields"],
            json!(ProfileField::ALL.map(ProfileField::as_str))
        );
        for field in ProfileField::ALL {
            assert_eq!(
                serde_json::to_value(field).expect("field"),
                json!(field.as_str())
            );
        }
        assert_eq!(table["lock_secs"], json!(LOCK_SECS));
        for mode in [ProfilesMode::All, ProfilesMode::NoNames, ProfilesMode::Off] {
            assert_eq!(ProfilesMode::parse(mode.as_str()), mode);
            assert_eq!(
                serde_json::to_value(mode).expect("mode"),
                json!(mode.as_str())
            );
        }
    }
}
