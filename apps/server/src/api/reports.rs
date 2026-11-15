pub mod forms;
mod limits;
mod query;
pub mod snapshot;
mod store;
#[cfg(test)]
mod tests;

pub(crate) use query::{groups as groups_in, list as list_in, open_count, reporter_known};
pub(crate) use store::{forget_user, purge_server, sweep};
pub(crate) use store::{mute as mute_in, mutes as mutes_in};

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::{IntoParams, ToSchema};

use crate::api::access::subjects::{Caller, lists_members, resolve_user};
use crate::api::access::{
    Proof, ReportMode, ReportScope, Via, denied, not_found, report_scope, report_servers,
    resolve_message, resolve_server,
};
use crate::api::features::Feature;
use crate::api::policy::Policy;
use crate::api::{
    ApiError, ApiErrorBody, Authed, LIST_PAGE, OkResp, Paged, Settings, UserRef, allowed, bad,
    decode_cursor, encode_cursor, lookup, ok,
};
use crate::db::{Db, User, now};
use crate::state::AppState;
use crate::ws::WsEvent;
use forms::{Answer, Base, FieldKind, Form, OTHER, StoredAnswer, validate_answers};
use limits::{Caps, Class};
use snapshot::{Place, SnapUser, Snapshot};

/// The longest note of a report, in characters.
pub const NOTE_MAX: usize = 1000;
/// The most earlier messages a report about a message takes along.
pub const CONTEXT_MAX: u8 = 10;
/// The 429 answer to a reporter past a cap, and to one whose reports are muted.
pub const OVER_LIMIT: &str = "You've sent a lot of reports. Try again later.";
pub const INSTANCE_ONLY: &str = "This can only be reported to the instance";
pub const SELF_REPORT: &str = "You can't report yourself";
pub const NOT_REPORTABLE: &str = "This message can't be reported";
pub const WRONG_TARGET: &str = "This form takes another target";

/// The answer to a forms document the instance refuses for what it says, and to a setting the
/// server config holds.
pub(crate) fn refused(msg: &str) -> ApiError {
    bad(msg)
}

/// The 400 answer to a report request whose value `field` is wrong.
pub(crate) fn invalid(field: &str, msg: &str) -> ApiError {
    ApiError::invalid(msg, field)
}

fn over_limit() -> ApiError {
    ApiError::rate(OVER_LIMIT, None)
}

/// Who a report goes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReportKind {
    /// The moderators of the server it happened in: its members with Manage reports.
    Server,
    /// The instance.
    Instance,
}

impl ReportKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ReportKind::Server => "server",
            ReportKind::Instance => "instance",
        }
    }

    pub fn parse(kind: &str) -> Option<ReportKind> {
        match kind {
            "server" => Some(ReportKind::Server),
            "instance" => Some(ReportKind::Instance),
            _ => None,
        }
    }

    fn feature(self) -> Feature {
        match self {
            ReportKind::Server => Feature::ServerReports,
            ReportKind::Instance => Feature::InstanceReports,
        }
    }
}

/// What kind of thing a report is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    /// A message you can read, in a channel or a direct conversation (`id`). Messages in
    /// direct conversations go to the instance only.
    Message,
    /// A member (`username`) of a server you can open (`server`) whose members you can see. A
    /// server whose `members_visible` is off shows them only to its members and instance staff:
    /// anyone else gets `Not found` for every name.
    Member,
    /// An account you can see (`username`). Goes to the instance only.
    Account,
    /// A server you can open (`server`). Goes to the instance only.
    Server,
    /// Nothing: a bug, feedback or a question, for a form of base `none`. Goes to the instance
    /// only.
    None,
}

/// What a report is about: `kind`, and the values that kind takes.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, ToSchema)]
pub struct Target {
    /// What kind of thing it is.
    pub kind: TargetKind,
    /// `message`: the message id.
    #[serde(default)]
    pub id: Option<i64>,
    /// `member` and `server`: the server name, case-insensitive.
    #[serde(default)]
    pub server: Option<String>,
    /// `member` and `account`: the username, case-insensitive.
    #[serde(default)]
    pub username: Option<String>,
}

/// A target with the values its kind takes.
enum Aim {
    Message { id: i64 },
    Member { server: String, username: String },
    Account { username: String },
    Server { server: String },
    None,
}

impl Target {
    fn aim(self) -> Result<Aim, ApiError> {
        let Target {
            kind,
            id,
            server,
            username,
        } = self;
        let incomplete = || invalid("target", "Incomplete target");
        Ok(match kind {
            TargetKind::Message => Aim::Message {
                id: id.ok_or_else(incomplete)?,
            },
            TargetKind::Member => Aim::Member {
                server: server.ok_or_else(incomplete)?,
                username: username.ok_or_else(incomplete)?,
            },
            TargetKind::Account => Aim::Account {
                username: username.ok_or_else(incomplete)?,
            },
            TargetKind::Server => Aim::Server {
                server: server.ok_or_else(incomplete)?,
            },
            TargetKind::None => Aim::None,
        })
    }
}

/// Request body of `POST /api/v1/reports`.
#[derive(Deserialize, ToSchema)]
pub struct CreateReport {
    /// Who it goes to.
    pub to: ReportKind,
    /// What it is about.
    pub target: Target,
    /// The reason: an option id of the form's `reason` field (by default `spam`, `harassment`,
    /// `hate`, `sexual`, `violence`, `illegal`, `impersonation`, `other`). An id the form
    /// doesn't offer counts as `other`. Left out for a form of base `none`, whose reason is the
    /// answer to the field it marks.
    #[serde(default)]
    pub reason: Option<String>,
    /// A note, up to 1,000 characters. When the form has a text field `details` without an
    /// answer, the note is its answer.
    #[serde(default)]
    pub note: Option<String>,
    /// For a message: how many earlier messages to include, 0 to 10.
    #[serde(default)]
    pub context: u8,
    /// The category id from `GET /api/v1/report_forms`. Left out, the target decides: `message`,
    /// `user` (members and accounts) or `server`.
    #[serde(default)]
    pub form: Option<String>,
    /// The answers to the form's fields after those of its base.
    #[serde(default)]
    pub answers: Vec<Answer>,
}

/// The new report.
#[derive(Debug, Serialize, ToSchema)]
pub struct Created {
    /// The report's id.
    pub id: i64,
}

/// A resolved target with what the report's row keeps of it.
struct Placed {
    base: Base,
    target_kind: &'static str,
    target_key: String,
    target_user: Option<String>,
    /// The server it happened in: name and display name.
    server: Option<(String, String)>,
    message_id: Option<i64>,
    channel_id: Option<i64>,
    channel_private: bool,
    dm_id: Option<i64>,
    /// The reported member's first role there.
    role: Option<(i64, String)>,
    snapshot: Snapshot,
}

/// Who must not learn that a report changed: the account it is about, and for a server's report
/// whoever can't view the channel of its message (its id and whether it was private).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Audience {
    pub about: Option<String>,
    pub channel: Option<(i64, bool)>,
}

/// Tells those who handle the reports of `server` (without one, the reports to the instance)
/// that a report changed. `audience` keeps the event from who can't see that report.
fn announce(state: &AppState, server: Option<&str>, audience: Audience) {
    let Audience { about, channel } = audience;
    state.hub.broadcast(WsEvent::ReportsChanged {
        server: server.map(str::to_string),
        about,
        channel: match server {
            Some(_) => channel,
            None => None,
        },
    });
}

/// A miss of anything a report names: the uniform 404. Server failures stay as they are.
fn hide(e: ApiError) -> ApiError {
    match e.failed() {
        true => e,
        false => not_found(),
    }
}

async fn first_role(
    db: &Db,
    server: &str,
    username: &str,
) -> Result<Option<(i64, String)>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT r.id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1 AND ur.username = $2 ORDER BY r.id LIMIT 1")
        .bind(server)
        .bind(username)
        .fetch_optional(db)
        .await?;
    Ok(match &row {
        Some(r) => Some((r.try_get(0)?, r.try_get(1)?)),
        None => None,
    })
}

async fn place(
    state: &AppState,
    user: &User,
    to: ReportKind,
    target: Aim,
    context: u8,
) -> Result<Placed, ApiError> {
    let db = &state.read();
    let instance_only = || invalid("to", INSTANCE_ONLY);
    let myself = || invalid("target", SELF_REPORT);
    match target {
        Aim::Message { id } => {
            let resolved = resolve_message(db, id, Some(user), &Proof::none()).await?;
            let scope = resolved.scope();
            if scope.author == user.username {
                return Err(myself());
            }
            if !matches!(scope.kind.as_str(), "user" | "poll") {
                return Err(invalid("target", NOT_REPORTABLE));
            }
            let message = snapshot::message(db, id).await?.ok_or_else(not_found)?;
            let target_user = message.author.as_ref().map(|_| scope.author.clone());
            let base = Placed {
                base: Base::Message,
                target_kind: "message",
                target_key: format!("u:{}", scope.author),
                target_user,
                server: None,
                message_id: Some(id),
                channel_id: None,
                channel_private: false,
                dm_id: scope.dm_id,
                role: None,
                snapshot: Snapshot::default(),
            };
            match (resolved.channel(), scope.dm_id) {
                (Some(channel), _) => {
                    let server = channel.server();
                    let since = channel.read_since(db).await?;
                    let spot = match scope.thread_root_id {
                        Some(root) => Place::Thread(root),
                        None => Place::Channel(channel.id()),
                    };
                    let private = crate::api::audit::channel_ref(db, channel.id())
                        .await?
                        .is_some_and(|c| c.private);
                    Ok(Placed {
                        server: Some((
                            server.name().to_string(),
                            server.lite().display_name.clone(),
                        )),
                        channel_id: Some(channel.id()),
                        channel_private: private,
                        role: first_role(db, server.name(), &scope.author).await?,
                        snapshot: Snapshot {
                            context: snapshot::context(db, id, spot, since, context).await?,
                            message: Some(message),
                            channel: Some(channel.name().to_string()),
                            ..Snapshot::default()
                        },
                        ..base
                    })
                }
                (None, Some(dm)) => {
                    if to == ReportKind::Server {
                        return Err(instance_only());
                    }
                    Ok(Placed {
                        snapshot: Snapshot {
                            context: snapshot::context(db, id, Place::Dm(dm), None, context)
                                .await?,
                            message: Some(message),
                            ..Snapshot::default()
                        },
                        ..base
                    })
                }
                (None, None) => Err(not_found()),
            }
        }
        Aim::Member { server, username } => {
            let access = resolve_server(db, &server, Some(user), &Proof::none()).await?;
            if access.via() == Via::Joinable {
                return Err(denied());
            }
            let name = username.to_lowercase();
            if !lists_members(&access) || !access.has_member(db, &name).await? {
                return Err(not_found());
            }
            let Some(member) = crate::db::get_user(db, &name).await? else {
                return Err(not_found());
            };
            if name == user.username {
                return Err(myself());
            }
            Ok(Placed {
                base: Base::User,
                target_kind: "user",
                target_key: format!("u:{name}"),
                target_user: Some(name.clone()),
                server: Some((
                    access.name().to_string(),
                    access.lite().display_name.clone(),
                )),
                message_id: None,
                channel_id: None,
                channel_private: false,
                dm_id: None,
                role: first_role(db, access.name(), &name).await?,
                snapshot: Snapshot {
                    user: Some(SnapUser::of(&member)),
                    ..Snapshot::default()
                },
            })
        }
        Aim::Account { username } => {
            let caller = Caller {
                user: Some(user),
                proof: &Proof::none(),
                server: None,
                badge: None,
            };
            let seen = resolve_user(state, &caller, &username).await?;
            if seen.user.username == user.username {
                return Err(myself());
            }
            if to == ReportKind::Server {
                return Err(instance_only());
            }
            Ok(Placed {
                base: Base::User,
                target_kind: "user",
                target_key: format!("u:{}", seen.user.username),
                target_user: Some(seen.user.username.clone()),
                server: None,
                message_id: None,
                channel_id: None,
                channel_private: false,
                dm_id: None,
                role: None,
                snapshot: Snapshot {
                    user: Some(SnapUser::of(&seen.user)),
                    ..Snapshot::default()
                },
            })
        }
        Aim::Server { server } => {
            let access = resolve_server(db, &server, Some(user), &Proof::none()).await?;
            if to == ReportKind::Server {
                return Err(instance_only());
            }
            Ok(Placed {
                base: Base::Server,
                target_kind: "server",
                target_key: format!("s:{}", access.name()),
                target_user: None,
                server: Some((
                    access.name().to_string(),
                    access.lite().display_name.clone(),
                )),
                message_id: None,
                channel_id: None,
                channel_private: false,
                dm_id: None,
                role: None,
                snapshot: Snapshot {
                    server: Some(snapshot::server(db, access.lite()).await?),
                    ..Snapshot::default()
                },
            })
        }
        Aim::None => {
            if to == ReportKind::Server {
                return Err(instance_only());
            }
            Ok(Placed {
                base: Base::None,
                target_kind: "none",
                target_key: "-".to_string(),
                target_user: None,
                server: None,
                message_id: None,
                channel_id: None,
                channel_private: false,
                dm_id: None,
                role: None,
                snapshot: Snapshot::default(),
            })
        }
    }
}

/// The form a target takes when the request names none.
fn form_of(target: &Aim) -> Option<&'static str> {
    match target {
        Aim::Message { id: _ } => Some("message"),
        Aim::Member {
            server: _,
            username: _,
        }
        | Aim::Account { username: _ } => Some("user"),
        Aim::Server { server: _ } => Some("server"),
        Aim::None => None,
    }
}

/// The answers of a report as it keeps them. A note stands in for the answer to a text field
/// `details` the request leaves out, as long as the field takes it; `true` then.
fn kept_answers(
    forms: &forms::ReportForms,
    form: &Form,
    answers: Vec<Answer>,
    note: Option<&str>,
) -> Result<(Vec<StoredAnswer>, bool), ApiError> {
    let details = form
        .open_fields()
        .iter()
        .any(|f| f.id == "details" && matches!(f.kind, FieldKind::ShortText | FieldKind::LongText));
    if let Some(note) = note
        && details
        && !answers.iter().any(|a| a.id == "details")
    {
        let mut with = answers.clone();
        with.push(Answer {
            id: "details".to_string(),
            value: Value::from(note),
        });
        if let Ok(kept) = validate_answers(forms, &form.id, &with) {
            return Ok((kept, true));
        }
    }
    Ok((validate_answers(forms, &form.id, &answers)?, false))
}

/// The reason a report is stored with and the label its option had.
fn reason_of(
    form: &Form,
    given: Option<&str>,
    answers: &[StoredAnswer],
) -> Result<(String, Option<String>), ApiError> {
    let field = form.reason_field();
    match form.base {
        Base::None => {
            let answer = field.and_then(|f| answers.iter().find(|a| a.id == f.id));
            Ok(match answer.and_then(|a| a.value.as_str()) {
                Some(id) => (
                    id.to_string(),
                    answer.and_then(|a| a.shown.as_ref()?.first().cloned()),
                ),
                None => (OTHER.to_string(), None),
            })
        }
        Base::User | Base::Server | Base::Message => {
            let given = given
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .ok_or_else(|| invalid("reason", "Missing required field: reason"))?;
            let options = field.map(|f| f.options.as_slice()).unwrap_or_default();
            let option = options
                .iter()
                .find(|o| o.id == given)
                .or_else(|| options.iter().find(|o| o.id == OTHER));
            Ok(match option {
                Some(option) => (option.id.clone(), Some(option.label.clone())),
                None => (OTHER.to_string(), None),
            })
        }
    }
}

/// Resolves what the answers name, each through the same gate as a target, and keeps the names
/// they had. Anything the reporter can't see is the uniform 404, naming no field.
async fn resolve_references(
    state: &AppState,
    user: &User,
    server: Option<&str>,
    answers: &mut [StoredAnswer],
) -> Result<(), ApiError> {
    let db = &state.read();
    for answer in answers {
        match answer.kind {
            FieldKind::User => {
                let name = answer.value["username"].as_str().unwrap_or_default();
                let caller = Caller {
                    user: Some(user),
                    proof: &Proof::none(),
                    server,
                    badge: None,
                };
                let seen = resolve_user(state, &caller, name).await.map_err(hide)?;
                answer.value = json!({
                    "username": seen.user.username,
                    "display_name": seen.user.display_name,
                });
            }
            FieldKind::Server => {
                let name = answer.value["server"].as_str().unwrap_or_default();
                let access = resolve_server(db, name, Some(user), &Proof::none())
                    .await
                    .map_err(hide)?;
                answer.value = json!({
                    "server": access.name(),
                    "display_name": access.lite().display_name,
                });
            }
            FieldKind::Message => {
                let id = answer.value["message_id"].as_i64().unwrap_or_default();
                resolve_message(db, id, Some(user), &Proof::none())
                    .await
                    .map_err(hide)?;
                let author = snapshot::message(db, id)
                    .await?
                    .ok_or_else(not_found)?
                    .author;
                answer.value = json!({ "message_id": id, "author": author });
            }
            FieldKind::ShortText
            | FieldKind::LongText
            | FieldKind::SingleChoice
            | FieldKind::MultipleChoice
            | FieldKind::Checkbox => {}
        }
    }
    Ok(())
}

/// Send a report
///
/// Reports a message, a member, an account or a server, or sends a bug report or feedback
/// (`target.kind` `none`). `to` says who gets it: `server` goes to the moderators of the server
/// it happened in (its members with Manage reports), `instance` to the instance. Messages in
/// direct conversations, accounts, servers and reports without a target go to the instance
/// only. `form` names the category of `GET /api/v1/report_forms` and `answers` answers its
/// fields after those of its base; without `form` the target picks `message`, `user` or
/// `server`. A report about a message keeps the message as it is now and, with `context`, up to
/// 10 earlier messages you can read from the same place. Accounts, servers and messages that
/// answers name must be ones you can see. Limits per account and per `to`: the same account
/// (or any of its messages) once per 72 hours (`REPORT_SAME_TARGET_HOURS`), by default 3
/// different targets per day (`REPORT_TARGETS_PER_DAY`) and 10 reports per week
/// (`REPORT_MAX_PER_WEEK`); reports without a target count apart, by default 10 per week
/// (`REPORT_FEEDBACK_PER_WEEK`). Emits `reports_changed` to those who handle the report.
/// A server whose `members_visible` is off shows its members only to its members and instance
/// staff: anyone else gets `Not found` for a member of it, whatever the name. A 404 counts as a
/// miss (`LOOKUP_MISSES_PER_HOUR`, as for
/// `GET /api/v1/users/{username}/card`). Needs an account: guests get 401. Strict rate-limit
/// bucket.
#[utoipa::path(
    post,
    path = "/api/v1/reports",
    tag = "Reports",
    request_body = CreateReport,
    responses(
        (status = 200, description = "The report was sent", body = Created),
        (status = 400, description = "`This can only be reported to the instance`, `Incomplete target`, `You can't report yourself`, `This message can't be reported` (not written by a person), `Note must be at most 1000 characters`, `Context must be 0 to 10 messages`, `Unknown form`, `This form takes another target`, `Missing required field: <id>`, or an answer the form refuses (`Unknown field`, `Field answered twice`, `Answer too long`, `Answer has invalid characters`, `Answer of the wrong kind`, `Unknown option`, `Option picked twice`, `Too few options picked`, `Too many options picked`, `Answers too long`). Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token, or a guest", body = ApiErrorBody),
        (status = 403, description = "`You are banned from this server`", body = ApiErrorBody),
        (status = 404, description = "`Not found` or `Server not found or wrong password`: the target, or something an answer names, does not exist or you can't see it (identical responses), and every member of a server whose members you can't see. Also `Not found` while reports of this `to` are turned off on this instance (reason `off_site`)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "`You've sent a lot of reports. Try again later.` (JSON): past a report limit. `Too many lookups. Try again later.` with a `Retry-After` header (JSON): more 404s for names this hour than `LOOKUP_MISSES_PER_HOUR`. Or too many requests in the strict bucket (plain text)", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn create_report(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(req): Json<CreateReport>,
) -> Result<Json<Created>, ApiError> {
    let settings = Settings::cached(&state.db).await;
    let feature = req.to.feature();
    if !settings.on(feature) {
        return Err(crate::api::policy::refused(feature.key(), not_found()));
    }
    let held = lookup::unmissed(&state, Some(&user))?;
    lookup::counted(held, create_at(&state, &user, req, now()).await).map(Json)
}

/// `create_report` at the time `t`.
pub(crate) async fn create_at(
    state: &AppState,
    user: &User,
    req: CreateReport,
    t: i64,
) -> Result<Created, ApiError> {
    let CreateReport {
        to,
        target,
        reason,
        note,
        context,
        form,
        answers,
    } = req;
    let note = note.as_deref().map(str::trim).filter(|n| !n.is_empty());
    if note.is_some_and(|n| n.chars().count() > NOTE_MAX) {
        return Err(invalid(
            "note",
            &format!("Note must be at most {NOTE_MAX} characters"),
        ));
    }
    if context > CONTEXT_MAX {
        return Err(invalid(
            "context",
            &format!("Context must be 0 to {CONTEXT_MAX} messages"),
        ));
    }
    let target = target.aim()?;
    let form_id = match (form, form_of(&target)) {
        (Some(form), _) => form,
        (None, Some(derived)) => derived.to_string(),
        (None, None) => return Err(invalid("form", "Unknown form")),
    };
    let placed = place(state, user, to, target, context).await?;
    let policy = Policy::cached(&state.db).await;
    let forms = &policy.report_forms;
    let form = forms
        .find(&form_id)
        .filter(|f| f.enabled)
        .ok_or_else(|| invalid("form", "Unknown form"))?;
    if form.base != placed.base {
        return Err(invalid("target", WRONG_TARGET));
    }
    let (mut answers, note_answered) = kept_answers(forms, form, answers, note)?;
    let (reason, reason_label) = reason_of(form, reason.as_deref(), &answers)?;
    let server = placed.server.as_ref().map(|(name, _)| name.as_str());
    resolve_references(state, user, server, &mut answers).await?;
    let note = match note_answered {
        true => None,
        false => note,
    };
    let class = match placed.base {
        Base::None => Class::Feedback,
        Base::User | Base::Server | Base::Message => Class::Abuse {
            target_key: &placed.target_key,
        },
    };
    let row = store::NewReport {
        kind: to,
        placed: &placed,
        reporter: &user.username,
        form: &form.id,
        form_label: &form.label,
        form_rev: forms.rev,
        reason: &reason,
        reason_label: reason_label.as_deref(),
        note,
        answers: &answers,
    };
    let id = store::insert(&state.db, row, class, Caps::of(&state.limits), t)
        .await?
        .ok_or_else(over_limit)?;
    let audience = Audience {
        about: placed.target_user.clone(),
        channel: placed.channel_id.map(|id| (id, placed.channel_private)),
    };
    let scope = match to {
        ReportKind::Server => server,
        ReportKind::Instance => None,
    };
    announce(state, scope, audience);
    Ok(Created { id })
}

/// Where a report stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Open,
    InReview,
    Resolved,
    Dismissed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Open => "open",
            Status::InReview => "in_review",
            Status::Resolved => "resolved",
            Status::Dismissed => "dismissed",
        }
    }

    pub fn parse(status: &str) -> Option<Status> {
        [
            Status::Open,
            Status::InReview,
            Status::Resolved,
            Status::Dismissed,
        ]
        .into_iter()
        .find(|s| s.as_str() == status)
    }
}

/// What was done about a resolved report.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModAction {
    /// The message was deleted.
    Delete,
    /// The member was timed out.
    Timeout,
    /// The member was kicked.
    Kick,
    /// The member was banned.
    Ban,
    /// The reported server was deleted. Only for a report about a server.
    DeleteServer,
    /// The owner of the reported server was banned from the instance. Only for a report about
    /// a server.
    BanOwner,
}

impl ModAction {
    pub const ALL: [ModAction; 6] = [
        ModAction::Delete,
        ModAction::Timeout,
        ModAction::Kick,
        ModAction::Ban,
        ModAction::DeleteServer,
        ModAction::BanOwner,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ModAction::Delete => "delete",
            ModAction::Timeout => "timeout",
            ModAction::Kick => "kick",
            ModAction::Ban => "ban",
            ModAction::DeleteServer => "delete_server",
            ModAction::BanOwner => "ban_owner",
        }
    }

    pub fn parse(action: &str) -> Option<ModAction> {
        ModAction::ALL.into_iter().find(|a| a.as_str() == action)
    }
}

/// What a list of report groups sorts the reports by.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum GroupBy {
    /// The server a report to the instance happened in. For the reports to the instance only.
    Server,
    /// Who or what is reported: the key is the report's `target_key`.
    Member,
    /// Who reported: the key is a username, or empty for deleted accounts.
    Reporter,
    /// The reported member's first role when the report was sent: the key is the role id, or
    /// empty for none.
    Role,
    /// The channel of the reported message: the key is the channel id, or empty for none.
    Channel,
    /// The report's `reason`.
    Reason,
    /// The report's `status`.
    Status,
    /// Who handles it: the key is a username, or empty for nobody.
    Assignee,
    /// The day it was sent, `YYYY-MM-DD`, in the time zone `tz` gives.
    Day,
    /// The report's category: the key is the form id.
    Form,
}

/// Filters, grouping and paging of the report lists.
#[derive(Clone, Debug, Default, Deserialize, IntoParams)]
pub struct ReportQuery {
    /// Only reports with this status.
    pub status: Option<Status>,
    /// Only reports with this reason id.
    pub reason: Option<String>,
    /// Only reports of this category: a form id.
    pub form: Option<String>,
    /// Only reports sent at or after this time, unix seconds.
    pub from: Option<i64>,
    /// Only reports sent at or before this time, unix seconds.
    pub to: Option<i64>,
    /// The grouping: required for the group list; with `key`, it filters a report list to one
    /// group.
    pub by: Option<GroupBy>,
    /// A group key of the grouping `by`, as the group list gives it.
    pub key: Option<String>,
    /// For `by=day`: minutes to add to UTC, -840 to 840. Default 0.
    pub tz: Option<i64>,
    /// List the oldest reports first.
    pub oldest: Option<bool>,
    /// The `X-Next-Cursor` of the page before.
    pub cursor: Option<String>,
    /// Page size, 1 to 50. Default 50.
    pub limit: Option<i64>,
}

/// A report in a list.
#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct ReportRow {
    /// The report's id.
    pub id: i64,
    /// Who it went to.
    pub kind: ReportKind,
    /// Where it stands.
    pub status: Status,
    /// What was done, on a resolved report.
    pub action: Option<ModAction>,
    /// The reason id. For a report without a target it is the answer to the field its form
    /// marks as the reason, or `other`.
    pub reason: String,
    /// The label the reason had when the report was sent.
    pub reason_label: Option<String>,
    /// The category: the id of the form the report was sent with.
    pub form: String,
    /// The name the category had when the report was sent.
    pub form_label: String,
    /// `message`, `user`, `server` or `none`.
    pub target_kind: String,
    /// Groups the reports about the same target: `u:<username>` for an account and its
    /// messages, `s:<server>` for a server, `d:<id>` once the account is deleted, `-` for
    /// none.
    pub target_key: String,
    /// The reported account; `null` for webhooks, servers, deleted accounts and none.
    pub target: Option<UserRef>,
    /// The name of the webhook whose post was reported.
    pub webhook: Option<String>,
    /// The server it happened in.
    pub server: Option<String>,
    /// That server's display name when the report was sent.
    pub server_name: Option<String>,
    /// The channel of the reported message.
    pub channel_id: Option<i64>,
    /// The channel's name now, or when the report was sent if it is gone.
    pub channel: Option<String>,
    /// The name of the reported member's first role when the report was sent.
    pub role: Option<String>,
    /// Who sent it; `null` once the account is deleted.
    pub reporter: Option<UserRef>,
    /// Who handles it.
    pub assignee: Option<UserRef>,
    /// The first 200 characters of the reported message, the name of the reported account or
    /// server, or the first text answer of a report without a target.
    pub excerpt: String,
    /// Whether it was passed on to the instance.
    pub escalated: bool,
    /// Unix seconds.
    pub created_at: i64,
    /// Unix seconds.
    pub updated_at: i64,
}

/// A group of reports.
#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct ReportGroup {
    /// The group's key: pass it as `key` with the same `by` to list its reports.
    pub key: String,
    /// A name for the group, where the key is not one: a role, channel, server, reason or
    /// category name, `Deleted user`, `Unassigned`, `No role`, `No channel` or `No server`.
    pub label: Option<String>,
    /// The account the group is about, for `member`, `reporter` and `assignee`.
    pub user: Option<UserRef>,
    /// Reports in the group.
    pub count: i64,
    /// Of those, the ones with the status `open`.
    pub open: i64,
}

/// A line of a report's history.
#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct ReportEvent {
    /// `created`, `status`, `assign`, `note` or `escalate`.
    pub kind: String,
    /// Who did it; `null` for `created` and for deleted accounts.
    pub actor: Option<UserRef>,
    /// `status`: `{status, action?}`. `assign`: `{assignee}`. `note`: `{text}`. `escalate`:
    /// `{note?, to}` on the report and `{note?, from}` on its copy.
    #[schema(value_type = Object)]
    pub detail: Value,
    /// Unix seconds.
    pub created_at: i64,
}

/// A report in full.
#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct ReportDetail {
    /// The report as the list shows it.
    pub report: ReportRow,
    /// The reporter's note.
    pub note: Option<String>,
    /// The answers to the form's fields, in form order, with the labels they had when the
    /// report was sent. Empty answers are left out.
    pub answers: Vec<StoredAnswer>,
    /// The reported content as it was when the report was sent.
    pub snapshot: Snapshot,
    /// Whether the content is proven to be what was sent. Always `false` for now.
    pub franked: bool,
    /// The newest 50 lines of the history, oldest first.
    pub events: Vec<ReportEvent>,
    /// The cursor for the lines before `events`: pass it as `cursor` to
    /// `GET /api/v1/reports/{id}/events`. `null` when `events` is the whole history.
    pub events_cursor: Option<String>,
    /// The 50 newest other reports about the same target that you can see.
    pub related: Vec<ReportRow>,
}

/// The open reports of one server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct OpenCount {
    /// The server's name.
    pub server: String,
    /// Its reports with the status `open` that you can see.
    pub open: i64,
}

/// A count of open reports.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct Open {
    /// The reports with the status `open` that you can see.
    pub open: i64,
}

/// List a server's reports
///
/// The reports sent to the moderators of the server, newest first, as pages of `limit`
/// (default and max 50). Page with `cursor` from the `X-Next-Cursor` response header. Filter
/// by `status`, `reason`, `form` (the category) and the time range `from` to `to`; `by` with
/// `key` lists one group of `GET /api/v1/servers/{name}/reports/groups`; `oldest=true` lists
/// the oldest first. You never see a report about yourself, nor one about a message in a
/// channel you can't view. Requires being a member with the Manage reports permission; a
/// timeout does not hide the reports. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/reports",
    tag = "Reports",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ReportQuery),
    responses(
        (status = 200, description = "A page of reports", body = Vec<ReportRow>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "`Unknown grouping` (`by=server`), `Invalid tz`, `Invalid day`, an invalid cursor (JSON), or a value of the wrong type (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Missing permission`: a member without Manage reports. Or banned from the server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or one you are not a member of (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_reports(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Query(q): Query<ReportQuery>,
) -> Result<Paged<ReportRow>, ApiError> {
    let db = &state.read();
    let scope = report_scope(db, &user, Some(&name), ReportMode::Read).await?;
    query::list(db, &scope, &q).await
}

/// List a server's reports in groups
///
/// The reports sent to the moderators of the server, counted by the grouping `by`: `member`
/// (who is reported), `reporter`, `role`, `channel`, `reason`, `status`, `assignee`, `day`
/// (with `tz`) or `form` (the category). Groups with the most open reports come first, then
/// the largest, as pages of `limit` (default and max 50); page with `cursor` from the
/// `X-Next-Cursor` response header. The filters of the report list apply. The counts leave out
/// what the list leaves out for you. Requires being a member with the Manage reports
/// permission. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/reports/groups",
    tag = "Reports",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ReportQuery),
    responses(
        (status = 200, description = "A page of groups", body = Vec<ReportGroup>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "`Unknown grouping` (no `by`, or `by=server`), `Invalid tz`, an invalid cursor (JSON), or a value of the wrong type (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Missing permission`: a member without Manage reports. Or banned from the server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or one you are not a member of (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_groups(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Query(q): Query<ReportQuery>,
) -> Result<Paged<ReportGroup>, ApiError> {
    let db = &state.read();
    let scope = report_scope(db, &user, Some(&name), ReportMode::Read).await?;
    query::groups(db, &scope, &q).await
}

/// Count a server's open reports
///
/// How many reports to the moderators of the server have the status `open`, among those you
/// can see. Requires being a member with the Manage reports permission. General rate-limit
/// bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/reports/open",
    tag = "Reports",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    responses(
        (status = 200, description = "The count", body = Open),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Missing permission`: a member without Manage reports. Or banned from the server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or one you are not a member of (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn server_open(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
) -> Result<Json<Open>, ApiError> {
    let db = &state.read();
    let scope = report_scope(db, &user, Some(&name), ReportMode::Read).await?;
    Ok(Json(Open {
        open: query::open_count(db, &scope).await?,
    }))
}

/// Paging of `GET /api/v1/reports/open`.
#[derive(Debug, Default, Deserialize, IntoParams)]
pub struct OpenQuery {
    /// The `X-Next-Cursor` of the page before.
    pub cursor: Option<String>,
}

/// Count the open reports of your servers
///
/// The servers where you hold Manage reports and at least one report you can see is `open`,
/// by name, each with its count, 50 a page. Page with `cursor` from the `X-Next-Cursor`
/// response header. Ask again when `reports_changed` arrives. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/reports/open",
    tag = "Reports",
    params(OpenQuery),
    responses(
        (status = 200, description = "A page of servers with open reports", body = Vec<OpenCount>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "An invalid cursor", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn my_open(
    State(state): State<AppState>,
    Authed(user): Authed,
    Query(q): Query<OpenQuery>,
) -> Result<Paged<OpenCount>, ApiError> {
    let db = &state.read();
    let after = match q.cursor.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(cursor) => Some(decode_cursor(cursor, 1)?.remove(0)),
        None => None,
    };
    let servers = report_servers(db, &user).await?;
    let mut out = Vec::new();
    let mut next = None;
    for server in servers
        .into_iter()
        .filter(|s| after.as_ref().is_none_or(|a| s > a))
    {
        if out.len() as i64 == LIST_PAGE {
            next = out
                .last()
                .map(|last: &OpenCount| encode_cursor(&[&last.server]));
            break;
        }
        let Some(scope) = allowed(report_scope(db, &user, Some(&server), ReportMode::Read).await)?
        else {
            continue;
        };
        let open = query::open_count(db, &scope).await?;
        if open > 0 {
            out.push(OpenCount { server, open });
        }
    }
    Ok(Paged(out, next))
}

/// Get a report
///
/// A report in full: its row, the reporter's note and answers, the reported content as it was
/// when the report was sent, the newest 50 lines of its history and the other reports about
/// the same target. `GET /api/v1/reports/{id}/events` pages through the rest of the history.
/// For the moderators of the report's server (members with Manage reports). General
/// rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/reports/{id}",
    tag = "Reports",
    params(("id" = i64, Path, description = "Report id")),
    responses(
        (status = 200, description = "The report", body = ReportDetail),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such report, one you don't handle, one about you, or one about a message in a channel you can't view (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn get_report(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> Result<Json<ReportDetail>, ApiError> {
    query::detail(&state.read(), &user, id).await.map(Json)
}

/// Paging of a report's history.
#[derive(Debug, Default, Deserialize, IntoParams)]
pub struct EventsQuery {
    /// The report's `events_cursor`, or the `X-Next-Cursor` of the page before.
    pub cursor: Option<String>,
}

/// List a report's history
///
/// The history of a report, 50 lines a page, each page oldest first. Without `cursor` it is
/// the newest 50 lines, as `GET /api/v1/reports/{id}` gives them in `events`; with that
/// answer's `events_cursor`, or the `X-Next-Cursor` response header of a page, the 50 lines
/// before. For the moderators of the report's server (members with Manage reports). General
/// rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/reports/{id}/events",
    tag = "Reports",
    params(("id" = i64, Path, description = "Report id"), EventsQuery),
    responses(
        (status = 200, description = "A page of the history, oldest first", body = Vec<ReportEvent>, headers(("x-next-cursor" = String, description = "Cursor for the lines before these; absent on the first lines"))),
        (status = 400, description = "An invalid cursor", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such report, one you don't handle, one about you, or one about a message in a channel you can't view (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_events(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Query(EventsQuery { cursor }): Query<EventsQuery>,
) -> Result<Paged<ReportEvent>, ApiError> {
    query::history(&state.read(), &user, id, cursor.as_deref()).await
}

/// Which reports an admin route reads: those to the instance, or with `scope=server` those to
/// the moderators of `server`, read-only.
#[derive(Debug, Default, Deserialize)]
pub struct AdminScope {
    pub scope: Option<String>,
    pub server: Option<String>,
}

/// The scope an admin route reads. Only for the site admin: everyone else gets `not_found()`.
pub(crate) async fn admin_scope(
    db: &Db,
    user: &User,
    which: &AdminScope,
) -> Result<ReportScope, ApiError> {
    if !user.is_site_admin {
        return Err(not_found());
    }
    match (which.scope.as_deref(), which.server.as_deref()) {
        (None | Some("instance"), _) => report_scope(db, user, None, ReportMode::Read).await,
        (Some("server"), Some(server)) => {
            report_scope(db, user, Some(server), ReportMode::Staff).await
        }
        (Some(_), _) => Err(invalid("scope", "Unknown scope")),
    }
}

pub const ACTION_NEEDS_RESOLVED: &str = "Action goes only with resolved";
pub const SERVER_REPORTS_ONLY: &str = "This action is only for server reports";
pub const CANT_HANDLE: &str = "They can't handle reports here";
pub const NOT_ESCALATABLE: &str = "Only server reports can be escalated";

/// Changes to a report. Left-out fields stay as they are.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct ReportPatch {
    /// The new status. Any status can follow any other.
    #[serde(default)]
    pub status: Option<Status>,
    /// What was done about it. Only together with `status: "resolved"`; any other status
    /// clears it. `delete_server` and `ban_owner` are carried out by this request.
    #[serde(default)]
    pub action: Option<ModAction>,
    /// Who handles it: a username, or `null` for nobody. For a server's report a member with
    /// Manage reports who is not the one reported; otherwise yourself.
    #[serde(default, deserialize_with = "crate::api::auth::present")]
    #[schema(value_type = Option<String>)]
    pub assignee: Option<Option<String>>,
    /// With `ban_owner`: the account to ban, the server's creator or one of its admins. Left
    /// out, it is the creator.
    #[serde(default)]
    pub owner: Option<String>,
}

/// Request body of `POST /api/v1/reports/{id}/notes`.
#[derive(Debug, Deserialize, ToSchema)]
pub struct NoteBody {
    /// The note, 1 to 1,000 characters.
    pub text: String,
}

/// Request body of `POST /api/v1/reports/{id}/escalate`.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct EscalateBody {
    /// A note for the instance, up to 1,000 characters.
    #[serde(default)]
    pub note: Option<String>,
}

/// Request body of `POST /api/v1/servers/{name}/reports/resolve`.
#[derive(Debug, Deserialize, ToSchema)]
pub struct BulkResolve {
    /// The `target_key` of the reports to close.
    pub target: String,
    /// `resolved` or `dismissed`.
    pub status: Status,
    /// What was done, with `resolved`.
    #[serde(default)]
    pub action: Option<ModAction>,
}

/// How many reports a bulk change closed.
#[derive(Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct Resolved {
    /// The reports that were open or in review and are closed now.
    pub count: i64,
}

/// An account whose reports are muted.
#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct MutedReporter {
    /// The account.
    pub user: UserRef,
    /// When it was muted, unix seconds.
    pub created_at: i64,
}

/// Paging of the muted reporters.
#[derive(Debug, Default, Deserialize, IntoParams)]
pub struct MutesQuery {
    /// The `X-Next-Cursor` of the page before.
    pub cursor: Option<String>,
}

fn note_text(text: &str) -> Result<&str, ApiError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(invalid("text", "Note can't be empty"));
    }
    if text.chars().count() > NOTE_MAX {
        return Err(invalid(
            "text",
            &format!("Note must be at most {NOTE_MAX} characters"),
        ));
    }
    Ok(text)
}

/// The action of a status change, checked against the status and the report.
fn action_for(
    scope: &ReportScope,
    row: &ReportRow,
    status: Option<Status>,
    action: Option<ModAction>,
) -> Result<Option<ModAction>, ApiError> {
    let Some(action) = action else {
        return Ok(None);
    };
    if status != Some(Status::Resolved) {
        return Err(invalid("action", ACTION_NEEDS_RESOLVED));
    }
    match action {
        ModAction::DeleteServer | ModAction::BanOwner => {
            if scope.server.is_some() || row.target_kind != "server" {
                return Err(invalid("action", SERVER_REPORTS_ONLY));
            }
        }
        ModAction::Delete | ModAction::Timeout | ModAction::Kick | ModAction::Ban => {}
    }
    Ok(Some(action))
}

/// Who a report is assigned to after `given`, which names an account or nobody.
async fn assignee_for(
    db: &Db,
    scope: &ReportScope,
    row: &ReportRow,
    given: Option<String>,
) -> Result<Option<String>, ApiError> {
    let Some(name) = given else {
        return Ok(None);
    };
    let name = name.to_lowercase();
    let reported = row.target.as_ref().is_some_and(|t| t.username == name);
    let channel = store::audience(db, row.id).await?.channel;
    match scope.handler(db, &name, channel).await? && !reported {
        true => Ok(Some(name)),
        false => Err(invalid("assignee", CANT_HANDLE)),
    }
}

/// A `delete_server` or `ban_owner` that passed its checks.
enum Deed {
    DeleteServer { server: String },
    BanOwner { server: String, who: String },
}

/// What a deed leaves to do once its transaction is committed.
enum Done {
    Server(crate::api::admin::RemovedServer),
    Owner(crate::api::admin::HiddenUser),
}

fn server_gone() -> ApiError {
    ApiError(
        axum::http::StatusCode::NOT_FOUND,
        "Server not found".to_string(),
        None,
    )
}

/// What `action` does to the server of the server report `row`, checked: nothing for the
/// actions that only record what was done.
async fn deed_for(
    state: &AppState,
    user: &User,
    row: &ReportRow,
    action: ModAction,
    owner: Option<&str>,
) -> Result<Option<Deed>, ApiError> {
    use crate::api::admin;
    match action {
        ModAction::Delete | ModAction::Timeout | ModAction::Kick | ModAction::Ban => Ok(None),
        ModAction::DeleteServer => {
            let server = row.server.clone().ok_or_else(server_gone)?;
            if admin::is_default_builtin(state, &server).await {
                return Err(invalid("action", admin::DEFAULT_SERVER_STAYS));
            }
            Ok(Some(Deed::DeleteServer { server }))
        }
        ModAction::BanOwner => {
            let server = row.server.clone().ok_or_else(server_gone)?;
            let who = store::server_owner(&state.db, &server, owner)
                .await?
                .ok_or_else(|| invalid("owner", "They don't own this server"))?;
            if who == user.username {
                return Err(invalid("owner", admin::BAN_SELF));
            }
            Ok(Some(Deed::BanOwner { server, who }))
        }
    }
}

impl Deed {
    /// Carries the deed out in `tx` for the report `report`, as the admin routes do it, and
    /// notes it in the instance audit log. A ban that changes nothing is not noted.
    async fn carry_out(
        self,
        tx: &mut sqlx::Transaction<'_, sqlx::Any>,
        actor: &str,
        report: i64,
        t: i64,
    ) -> Result<Done, ApiError> {
        use crate::api::{admin, instance_audit};
        match self {
            Deed::DeleteServer { server } => {
                let removed = admin::remove_server_in(tx, &server)
                    .await?
                    .ok_or_else(server_gone)?;
                let about = json!({ "report": report });
                instance_audit::record_in(tx, actor, "server.delete", Some(&server), about, t)
                    .await?;
                Ok(Done::Server(removed))
            }
            Deed::BanOwner { server, who } => {
                let hidden = admin::ban_in(tx, &who).await?;
                if hidden.changed {
                    let about = json!({ "report": report, "server": server });
                    instance_audit::record_in(tx, actor, "user.ban", Some(&who), about, t).await?;
                }
                Ok(Done::Owner(hidden))
            }
        }
    }
}

impl Done {
    async fn finish(self, state: &AppState) {
        match self {
            Done::Server(removed) => removed.finish(state).await,
            Done::Owner(hidden) => hidden.finish(state).await,
        }
    }
}

/// Change a report
///
/// Sets the status of a report, what was done about it, and who handles it. `action` goes only
/// with `status: "resolved"`, and any other status clears a stored action. For a report about
/// a server, `delete_server` deletes that server and `ban_owner` bans its creator (or the
/// admin `owner` names) from the instance, together with the status change: either both
/// happen or neither. Other actions only record what you did through the moderation
/// endpoints. A server's report can be assigned to a moderator who can view the channel of
/// the reported message. Every change is added to the report's history and to the audit log
/// (`report.status`, `report.assign`), which never names the reporter or the one reported.
/// Emits `reports_changed`. For the moderators of the report's server: members with the
/// Manage reports permission who are not timed out. General rate-limit bucket.
#[utoipa::path(
    patch,
    path = "/api/v1/reports/{id}",
    tag = "Reports",
    params(("id" = i64, Path, description = "Report id")),
    request_body = ReportPatch,
    responses(
        (status = 200, description = "The report after the change", body = ReportRow),
        (status = 400, description = "`Action goes only with resolved`, `This action is only for server reports`, `They can't handle reports here` (the assignee is not a moderator of the server, can't view the channel of the reported message, is the one reported, or for a report to the instance is not you), `They don't own this server`, `Cannot ban yourself` (`ban_owner` on your own account), `The rchat server is a default server. Take it off the default servers first` (`delete_server`). Each has the reason `invalid` with the field `action`, `assignee` or `owner`. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`You are timed out in this server`", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such report, one you don't handle, one about you, or one about a message in a channel you can't view (identical responses). `Server not found or wrong password`: you can read the report but are not a member of its server. `Server not found`: the reported server is gone", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn patch_report(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(patch): Json<ReportPatch>,
) -> Result<Json<ReportRow>, ApiError> {
    let ReportPatch {
        status,
        action,
        assignee,
        owner,
    } = patch;
    let db = &state.db;
    let (scope, row) = query::held(db, &user, id).await?;
    let action = action_for(&scope, &row, status, action)?;
    let assignee = match assignee {
        Some(given) => Some(assignee_for(db, &scope, &row, given).await?),
        None => None,
    };
    let deed = match action {
        Some(action) => deed_for(&state, &user, &row, action, owner.as_deref()).await?,
        None => None,
    };
    let change = store::Change {
        id,
        status: status.map(|s| (s, action)),
        assignee,
    };
    let t = now();
    let mut tx = db.begin().await?;
    store::change(&mut tx, &scope, &user.username, change, t).await?;
    let done = match deed {
        Some(deed) => Some(deed.carry_out(&mut tx, &user.username, id, t).await?),
        None => None,
    };
    tx.commit().await?;
    if let Some(done) = done {
        done.finish(&state).await;
    }
    if status.is_some() {
        let audience = store::audience(db, id).await?;
        announce(&state, scope.server.as_deref(), audience);
    }
    Ok(Json(query::row(db, &scope, id).await?))
}

/// Add a note to a report
///
/// Adds a note to the report's history, for the others who handle it. The reporter never sees
/// it. Logged as `report.note` without the text. For the moderators of the report's server:
/// members with the Manage reports permission who are not timed out. General rate-limit
/// bucket.
#[utoipa::path(
    post,
    path = "/api/v1/reports/{id}/notes",
    tag = "Reports",
    params(("id" = i64, Path, description = "Report id")),
    request_body = NoteBody,
    responses(
        (status = 200, description = "The report with the note in its history", body = ReportDetail),
        (status = 400, description = "`Note can't be empty` or `Note must be at most 1000 characters`. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`You are timed out in this server`", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such report, one you don't handle, one about you, or one about a message in a channel you can't view (identical responses). `Server not found or wrong password`: you can read the report but are not a member of its server", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn add_note(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(NoteBody { text }): Json<NoteBody>,
) -> Result<Json<ReportDetail>, ApiError> {
    let text = note_text(&text)?;
    let db = &state.db;
    let (scope, _) = query::held(db, &user, id).await?;
    store::note(db, &scope, &user.username, id, text, now()).await?;
    Ok(Json(query::detail_in(db, &scope, id).await?))
}

/// Pass a report on to the instance
///
/// Sends a copy of a server's report to the instance: the same target, content, reason and
/// reporter, with your note. The copy never counts against the reporter's limits. Asking
/// again changes nothing. Logged as `report.escalate`. Emits `reports_changed`. For the
/// moderators of the report's server: members with the Manage reports permission who are not
/// timed out. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/reports/{id}/escalate",
    tag = "Reports",
    params(("id" = i64, Path, description = "Report id")),
    request_body = EscalateBody,
    responses(
        (status = 200, description = "The report, now `escalated`", body = ReportDetail),
        (status = 400, description = "`Only server reports can be escalated` or `Note must be at most 1000 characters`. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`You are timed out in this server`", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such report, one you don't handle, one about you, or one about a message in a channel you can't view (identical responses); also while reports to the instance are turned off (reason `off_site`). `Server not found or wrong password`: you can read the report but are not a member of its server", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn escalate(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(EscalateBody { note }): Json<EscalateBody>,
) -> Result<Json<ReportDetail>, ApiError> {
    let feature = Feature::InstanceReports;
    if !Settings::cached(&state.db).await.on(feature) {
        return Err(crate::api::policy::refused(feature.key(), not_found()));
    }
    let note = note.as_deref().map(str::trim).filter(|n| !n.is_empty());
    if note.is_some_and(|n| n.chars().count() > NOTE_MAX) {
        return Err(invalid(
            "note",
            &format!("Note must be at most {NOTE_MAX} characters"),
        ));
    }
    let db = &state.db;
    let (scope, _) = query::held(db, &user, id).await?;
    if scope.server.is_none() {
        return Err(invalid("id", NOT_ESCALATABLE));
    }
    if store::escalate(db, &scope, &user.username, id, note, now()).await? {
        let audience = store::audience(db, id).await?;
        announce(&state, scope.server.as_deref(), audience.clone());
        announce(&state, None, audience);
    }
    Ok(Json(query::detail_in(db, &scope, id).await?))
}

/// The status and action of a bulk change.
fn bulk_change(req: &BulkResolve) -> Result<(Status, Option<ModAction>), ApiError> {
    let BulkResolve {
        target: _,
        status,
        action,
    } = req;
    match (status, action) {
        (Status::Open | Status::InReview, _) => {
            Err(invalid("status", "Only resolved or dismissed"))
        }
        (Status::Dismissed, Some(_)) => Err(invalid("action", ACTION_NEEDS_RESOLVED)),
        (Status::Resolved, Some(ModAction::DeleteServer | ModAction::BanOwner)) => {
            Err(invalid("action", "This action goes with one report"))
        }
        (Status::Resolved | Status::Dismissed, action) => Ok((*status, *action)),
    }
}

/// `bulk_resolve` over `scope`.
pub(crate) async fn resolve_in(
    state: &AppState,
    scope: &ReportScope,
    user: &User,
    req: BulkResolve,
) -> Result<Resolved, ApiError> {
    let (status, action) = bulk_change(&req)?;
    let closed = store::resolve_all(
        &state.db,
        scope,
        &user.username,
        &req.target,
        (status, action),
        now(),
    )
    .await?;
    let count = closed.len() as i64;
    let mut told: Vec<Audience> = Vec::new();
    for audience in closed {
        if !told.contains(&audience) {
            announce(state, scope.server.as_deref(), audience.clone());
            told.push(audience);
        }
    }
    Ok(Resolved { count })
}

/// Close every report about one target
///
/// Sets every report of the server about `target` (a `target_key`) that is `open` or
/// `in_review`, and that you can see, to `resolved` or `dismissed`. Logged once as
/// `report.status` with the count. Emits `reports_changed`. Requires being a member with the
/// Manage reports permission who is not timed out. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/servers/{name}/reports/resolve",
    tag = "Reports",
    params(("name" = String, Path, description = "Server name, case-insensitive")),
    request_body = BulkResolve,
    responses(
        (status = 200, description = "How many reports were closed", body = Resolved),
        (status = 400, description = "`Only resolved or dismissed`, `Action goes only with resolved`, `This action goes with one report`. Malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Missing permission`: a member without Manage reports. `You are timed out in this server`. Or banned from the server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or one you are not a member of (identical responses)", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn bulk_resolve(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(req): Json<BulkResolve>,
) -> Result<Json<Resolved>, ApiError> {
    let scope = report_scope(&state.db, &user, Some(&name), ReportMode::Write).await?;
    resolve_in(&state, &scope, &user, req).await.map(Json)
}

/// List muted reporters
///
/// The accounts whose reports to this server's moderators are muted, by username, 50 a page.
/// Page with `cursor` from the `X-Next-Cursor` response header. Requires being a member with
/// the Manage reports permission. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/report_mutes",
    tag = "Reports",
    params(("name" = String, Path, description = "Server name, case-insensitive"), MutesQuery),
    responses(
        (status = 200, description = "A page of muted reporters", body = Vec<MutedReporter>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "An invalid cursor", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Missing permission`: a member without Manage reports. Or banned from the server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or one you are not a member of (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_mutes(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Query(q): Query<MutesQuery>,
) -> Result<Paged<MutedReporter>, ApiError> {
    let db = &state.read();
    let scope = report_scope(db, &user, Some(&name), ReportMode::Read).await?;
    store::mutes(db, &scope, q.cursor.as_deref()).await
}

/// Mute a reporter
///
/// Mutes the reports of `username` to this server's moderators: their next reports here get
/// the answer of a reporter past a limit, and nothing is stored. Their reports to the instance
/// are not affected. Works for members of the server and for accounts with a report here that
/// you can see; every other name answers 404 and counts as a miss
/// (`LOOKUP_MISSES_PER_HOUR`, as for `GET /api/v1/users/{username}/card`). Muting twice
/// changes nothing. Logged as `report.mute`. Requires being a member with the Manage reports
/// permission who is not timed out. General rate-limit bucket.
#[utoipa::path(
    put,
    path = "/api/v1/servers/{name}/report_mutes/{username}",
    tag = "Reports",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("username" = String, Path, description = "The reporter, case-insensitive")),
    responses(
        (status = 200, description = "Their reports are muted", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Missing permission`: a member without Manage reports. `You are timed out in this server`. Or banned from the server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or one you are not a member of (identical responses). `Not found`: no account by that name, or one that is no member and sent no report here that you can see (identical responses)", body = ApiErrorBody),
        (status = 429, description = "`Too many lookups. Try again later.` with a `Retry-After` header (JSON): the caller got more 404s for names this hour than `LOOKUP_MISSES_PER_HOUR`. Or too many requests in the general bucket (plain text)", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn mute_reporter(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, username)): Path<(String, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let db = &state.db;
    let scope = report_scope(db, &user, Some(&name), ReportMode::Write).await?;
    let target = username.to_lowercase();
    let held = lookup::unmissed(&state, Some(&user))?;
    let known = match query::reporter_known(db, &scope, &target).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(not_found()),
        Err(e) => Err(e),
    };
    lookup::counted(held, known)?;
    store::mute(db, &scope, &user.username, &target, true, now()).await?;
    Ok(ok())
}

/// Unmute a reporter
///
/// Lets `username` report to this server's moderators again. Succeeds without changes when
/// they are not muted. Logged as `report.unmute`. Requires being a member with the Manage
/// reports permission who is not timed out. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/servers/{name}/report_mutes/{username}",
    tag = "Reports",
    params(("name" = String, Path, description = "Server name, case-insensitive"), ("username" = String, Path, description = "The reporter, case-insensitive")),
    responses(
        (status = 200, description = "Their reports are not muted", body = OkResp),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "`Missing permission`: a member without Manage reports. `You are timed out in this server`. Or banned from the server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, or one you are not a member of (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn unmute_reporter(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((name, username)): Path<(String, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let db = &state.db;
    let scope = report_scope(db, &user, Some(&name), ReportMode::Write).await?;
    store::mute(
        db,
        &scope,
        &user.username,
        &username.to_lowercase(),
        false,
        now(),
    )
    .await?;
    Ok(ok())
}
