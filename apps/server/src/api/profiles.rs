use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::api::access::{
    Proof, ServerAccess, USER_SCOPE_SMALL, acting_on, not_found, resolve_server, timed_out,
    timed_out_error,
};
use crate::api::audit::{self, Details, Entry, Target};
use crate::api::auth::{check_avatar, check_banner, clean_bio, clean_name_for, present};
use crate::api::{
    ApiError, ApiErrorBody, Authed, ProfanityTarget, Settings, UserRef, check_profanity,
    placeholders,
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
    /// Until when (unix seconds) the profile can't be edited; `null` when it can.
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Stored {
    look: MemberLook,
    bio: Option<String>,
    banner_color: Option<String>,
    locked_until: Option<i64>,
}

impl Stored {
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

/// Saves `next` over `before` for `user` in `key`, logs a name change and tells the server.
async fn save(
    state: &AppState,
    key: &str,
    user: &User,
    before: &Stored,
    next: Stored,
) -> Result<Stored, ApiError> {
    if *before == next {
        return Ok(next);
    }
    let mut tx = state.db.begin().await?;
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
        (status = 403, description = "`Not a member`; `You are timed out in this server`; or the server's `profiles_mode` refuses the change (`reason.kind` `off_server`, `reason.control` `profiles_mode`): `Server profiles are off in this server`, or `Server names are off in this server` for a name", body = ApiErrorBody),
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
    let before = stored(&state.db, &key, &user.username).await?;
    let mut next = before.clone();
    if let Some(raw) = new_name {
        next.look.name = match raw {
            Some(raw) if raw.trim() == user.display_name => None,
            Some(raw) => {
                let current = before.look.name.as_deref().unwrap_or(&user.display_name);
                Some(clean_name_for(&state, &user, &raw, current).await?)
                    .filter(|name| *name != user.display_name)
            }
            None => None,
        };
    }
    if let Some(kind) = avatar_kind {
        (next.look.avatar_kind, next.look.avatar_color) = match kind {
            Some(kind) => (Some(kind), check_avatar(kind, avatar_color)?),
            None => (None, None),
        };
    }
    if let Some(color) = banner_color {
        next.banner_color = check_banner(color)?;
    }
    if let Some(text) = bio {
        next.bio = clean_bio(text.as_deref().unwrap_or(""))?;
        if let Some(text) = &next.bio {
            check_profanity(&state.db, ProfanityTarget::Bios, text).await?;
        }
    }
    let saved = save(&state, &key, &user, &before, next).await?;
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
        (status = 403, description = "`Not a member`, or `You are timed out in this server`", body = ApiErrorBody),
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
    let before = stored(&state.db, &key, &user.username).await?;
    let next = Stored {
        look: MemberLook::default(),
        bio: None,
        banner_color: None,
        locked_until: before.locked_until,
    };
    let saved = save(&state, &key, &user, &before, next).await?;
    Ok(Json(answer(
        &user,
        saved,
        access.lite().profiles_mode,
        shown_in(&state.db, &key).await?,
    )))
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
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
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
        let db = &state.db;
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
        (state, path)
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
        for mode in [ProfilesMode::All, ProfilesMode::NoNames, ProfilesMode::Off] {
            assert_eq!(ProfilesMode::parse(mode.as_str()), mode);
            assert_eq!(
                serde_json::to_value(mode).expect("mode"),
                json!(mode.as_str())
            );
        }
    }
}
