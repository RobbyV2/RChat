pub mod forms;
mod limits;
pub mod snapshot;
mod store;
#[cfg(test)]
mod tests;

pub(crate) use store::{forget_user, purge_server, sweep};

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::ToSchema;

use crate::api::access::subjects::{Caller, lists_members, resolve_user};
use crate::api::access::{Proof, Via, denied, not_found, resolve_message, resolve_server};
use crate::api::features::Feature;
use crate::api::policy::Policy;
use crate::api::{ApiError, ApiErrorBody, Authed, Settings, bad, lookup};
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
