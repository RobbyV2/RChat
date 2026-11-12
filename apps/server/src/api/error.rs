use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// An error answer: its status, its `error` text and, when it has one, its `reason`. A denial
/// about a server, channel or message the caller can't open never has a reason.
#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String, pub Option<Reason>);

/// What kind of error it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReasonKind {
    /// Turned off for this site. `control` is the setting.
    OffSite,
    /// Turned off for this account. `control` is the setting.
    OffAccount,
    /// Turned off in this server by its owner or staff. `control` is the server's setting.
    OffServer,
    /// Turned off for this app by its author or the server's owner. `control` is the setting.
    OffApp,
    /// An app's own rule or action refused. `error` is the app's message.
    App,
    /// A limit of the caller is reached. `control` is the limit.
    Limit,
    /// The site or a shared resource is full right now. `control` is what is full.
    Capacity,
    /// A value in the request is wrong. `field` is the value's name.
    Invalid,
    /// Too many requests. Wait `retry_after` seconds when it is given.
    Rate,
    /// Someone else changed it, or the name is taken.
    Conflict,
    /// The session ended. Sign in again.
    SignIn,
    /// The server can't do it right now. Try again, after `retry_after` seconds when it is
    /// given.
    Unavailable,
}

/// Why a request was refused, for programs. An error without one is a denial about a server,
/// channel or message the caller can't open, an error that has no kind yet, or an answer of an
/// older server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Reason {
    /// The kind of error.
    pub kind: ReasonKind,
    /// The setting or limit that refused: a key of `GET /api/v1/settings`, or a limit's name
    /// such as `upload_max_mib`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(example = "server_search")]
    pub control: Option<String>,
    /// Seconds to wait before trying again. The `Retry-After` header carries the same number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
    /// The name of the request value that is wrong.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl Reason {
    fn of(kind: ReasonKind) -> Reason {
        Reason {
            kind,
            control: None,
            retry_after: None,
            field: None,
        }
    }

    fn by(kind: ReasonKind, control: &str) -> Reason {
        Reason {
            control: Some(control.to_string()),
            ..Reason::of(kind)
        }
    }
}

/// The JSON body of every error the API itself returns.
#[derive(Serialize, ToSchema)]
pub struct ApiErrorBody {
    /// A short, human-readable reason, e.g. `Server not found` or `Unauthorized`.
    pub error: String,
    /// What kind of error it is and which setting or limit caused it. Left out for denials about
    /// a server, channel or message you can't open, and for errors that have no kind yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
}

/// The 500 answer to a request the server failed on. Nothing of the cause is in it; the detail
/// goes to the server log only.
pub const SERVER_ERROR: &str = "Something went wrong";
/// The 503 answer to a request that waited too long for the database: no free connection
/// within `DATABASE_ACQUIRE_TIMEOUT_SECS`, a statement over `DATABASE_STATEMENT_TIMEOUT_SECS`,
/// or a lock. It says to retry after 1 second.
pub const SERVER_BUSY: &str = "Server busy, try again in a moment";

impl ApiError {
    /// A failure of the server itself (storage, encoding, a response that can't be built):
    /// logged with its cause and answered with the generic 500, so the cause never reaches a
    /// client.
    pub fn internal(cause: impl std::fmt::Display) -> ApiError {
        tracing::error!("request failed: {cause}");
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            SERVER_ERROR.to_string(),
            None,
        )
    }

    fn because(status: StatusCode, error: impl Into<String>, reason: Reason) -> ApiError {
        ApiError(status, error.into(), Some(reason))
    }

    /// Refused because the setting `control` is off for the whole site.
    pub fn off_site(status: StatusCode, error: impl Into<String>, control: &str) -> ApiError {
        ApiError::because(status, error, Reason::by(ReasonKind::OffSite, control))
    }

    /// Refused because the setting `control` leaves this account out.
    pub fn off_account(status: StatusCode, error: impl Into<String>, control: &str) -> ApiError {
        ApiError::because(status, error, Reason::by(ReasonKind::OffAccount, control))
    }

    /// Refused because the server's own setting `control` is off. Only for callers who can
    /// open that server.
    pub fn off_server(status: StatusCode, error: impl Into<String>, control: &str) -> ApiError {
        ApiError::because(status, error, Reason::by(ReasonKind::OffServer, control))
    }

    /// Refused because the setting `control` is off for this app.
    pub fn off_app(status: StatusCode, error: impl Into<String>, control: &str) -> ApiError {
        ApiError::because(status, error, Reason::by(ReasonKind::OffApp, control))
    }

    /// Refused by an app's own rule. `error` is the app's message.
    pub fn app(status: StatusCode, error: impl Into<String>) -> ApiError {
        ApiError::because(status, error, Reason::of(ReasonKind::App))
    }

    /// The caller reached the limit `control`.
    pub fn limit(status: StatusCode, error: impl Into<String>, control: &str) -> ApiError {
        ApiError::because(status, error, Reason::by(ReasonKind::Limit, control))
    }

    /// `control` is full right now, for everyone.
    pub fn capacity(
        status: StatusCode,
        error: impl Into<String>,
        control: &str,
        retry_after: Option<u64>,
    ) -> ApiError {
        let reason = Reason {
            retry_after,
            ..Reason::by(ReasonKind::Capacity, control)
        };
        ApiError::because(status, error, reason)
    }

    /// 400: the request value `field` is wrong.
    pub fn invalid(error: impl Into<String>, field: &str) -> ApiError {
        let reason = Reason {
            field: Some(field.to_string()),
            ..Reason::of(ReasonKind::Invalid)
        };
        ApiError::because(StatusCode::BAD_REQUEST, error, reason)
    }

    /// 429: too many requests.
    pub fn rate(error: impl Into<String>, retry_after: Option<u64>) -> ApiError {
        let reason = Reason {
            retry_after,
            ..Reason::of(ReasonKind::Rate)
        };
        ApiError::because(StatusCode::TOO_MANY_REQUESTS, error, reason)
    }

    /// Someone else changed it, or the name is taken.
    pub fn conflict(status: StatusCode, error: impl Into<String>) -> ApiError {
        ApiError::because(status, error, Reason::of(ReasonKind::Conflict))
    }

    /// 401: the session ended or was never there.
    pub fn sign_in(error: impl Into<String>) -> ApiError {
        ApiError::because(
            StatusCode::UNAUTHORIZED,
            error,
            Reason::of(ReasonKind::SignIn),
        )
    }

    /// 503: the server can't do it right now.
    pub fn unavailable(error: impl Into<String>, retry_after: Option<u64>) -> ApiError {
        let reason = Reason {
            retry_after,
            ..Reason::of(ReasonKind::Unavailable)
        };
        ApiError::because(StatusCode::SERVICE_UNAVAILABLE, error, reason)
    }

    /// Whether the server failed, rather than the request being refused.
    pub fn failed(&self) -> bool {
        self.0.is_server_error()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let ApiError(status, error, reason) = self;
        let wait = reason.as_ref().and_then(|r| r.retry_after);
        let mut res = (status, axum::Json(ApiErrorBody { error, reason })).into_response();
        if let Some(secs) = wait {
            res.headers_mut().insert(header::RETRY_AFTER, secs.into());
        }
        res
    }
}

/// Whether the database gave up waiting: for a connection, a lock or a statement.
fn timed_out(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed => true,
        sqlx::Error::Io(io) => io.kind() == std::io::ErrorKind::TimedOut,
        sqlx::Error::Database(db) => matches!(
            db.code().as_deref(),
            Some("57014" | "55P03" | "57P03" | "53300" | "5" | "6" | "261" | "262" | "517")
        ),
        _ => false,
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> ApiError {
        match timed_out(&e) {
            true => {
                tracing::warn!("the database did not answer in time: {e}");
                ApiError::unavailable(SERVER_BUSY, Some(1))
            }
            false => {
                tracing::error!("database error: {e}");
                ApiError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    SERVER_ERROR.to_string(),
                    None,
                )
            }
        }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> ApiError {
        match e.downcast::<sqlx::Error>() {
            Ok(db) => db.into(),
            Err(e) => ApiError::internal(format_args!("{e:#}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{StatusCode, header};
    use axum::response::IntoResponse;
    use serde_json::json;

    use super::{ApiError, Reason, ReasonKind, SERVER_BUSY, SERVER_ERROR};

    async fn sent(e: ApiError) -> (StatusCode, Option<String>, String) {
        let res = e.into_response();
        let wait = res
            .headers()
            .get(header::RETRY_AFTER)
            .map(|v| v.to_str().expect("header").to_string());
        let status = res.status();
        let body = axum::body::to_bytes(res.into_body(), 4096)
            .await
            .expect("body");
        (
            status,
            wait,
            String::from_utf8(body.to_vec()).expect("utf8"),
        )
    }

    #[tokio::test]
    async fn an_error_without_a_reason_reads_as_before() {
        let plain = ApiError(StatusCode::NOT_FOUND, "Not found".to_string(), None);
        assert_eq!(
            sent(plain).await,
            (
                StatusCode::NOT_FOUND,
                None,
                r#"{"error":"Not found"}"#.to_string()
            )
        );
    }

    #[tokio::test]
    async fn server_failures_answer_without_their_cause() {
        let failed = ApiError::internal("PUT https://media.example.com/bucket/x: 403 Forbidden");
        assert_eq!(
            sent(failed).await,
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                None,
                json!({ "error": SERVER_ERROR }).to_string()
            )
        );
        let mut files = vec![std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src"
        ))];
        let mut read = 0;
        while let Some(at) = files.pop() {
            if at.is_dir() {
                files.extend(
                    std::fs::read_dir(&at)
                        .expect("dir")
                        .map(|e| e.expect("entry").path()),
                );
                continue;
            }
            let text = std::fs::read_to_string(&at).expect("source");
            read += 1;
            assert!(
                !text.contains(concat!("INTERNAL_SERVER_ERROR, ", "e.to_string()")),
                "{}: a 500 that carries its cause",
                at.display()
            );
        }
        assert!(read > 50);
    }

    #[tokio::test]
    async fn a_reason_only_adds_a_field_after_the_error() {
        let refused = ApiError::off_site(StatusCode::NOT_FOUND, "Not found", "server_search");
        assert_eq!(
            sent(refused).await,
            (
                StatusCode::NOT_FOUND,
                None,
                r#"{"error":"Not found","reason":{"kind":"off_site","control":"server_search"}}"#
                    .to_string()
            )
        );
        let full = ApiError::capacity(
            StatusCode::SERVICE_UNAVAILABLE,
            "Full",
            "upload_buffer_mib",
            Some(120),
        );
        assert_eq!(
            sent(full).await,
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Some("120".to_string()),
                r#"{"error":"Full","reason":{"kind":"capacity","control":"upload_buffer_mib","retry_after":120}}"#
                    .to_string()
            )
        );
        let (_, wait, body) = sent(ApiError::rate("Slow down", Some(3))).await;
        assert_eq!(wait.as_deref(), Some("3"));
        assert_eq!(
            body,
            r#"{"error":"Slow down","reason":{"kind":"rate","retry_after":3}}"#
        );
        let (_, wait, _) = sent(ApiError::rate("Slow down", None)).await;
        assert_eq!(wait, None, "no header without a time");
    }

    #[test]
    fn every_kind_has_its_constructor() {
        let (not_found, forbidden) = (StatusCode::NOT_FOUND, StatusCode::FORBIDDEN);
        let made = [
            (ApiError::off_site(not_found, "a", "calls"), "off_site"),
            (
                ApiError::off_account(not_found, "a", "calls"),
                "off_account",
            ),
            (ApiError::off_server(forbidden, "a", "calls"), "off_server"),
            (ApiError::off_app(forbidden, "a", "calls"), "off_app"),
            (ApiError::app(forbidden, "a"), "app"),
            (
                ApiError::limit(StatusCode::PAYLOAD_TOO_LARGE, "a", "calls"),
                "limit",
            ),
            (
                ApiError::capacity(StatusCode::SERVICE_UNAVAILABLE, "a", "calls", None),
                "capacity",
            ),
            (ApiError::invalid("a", "name"), "invalid"),
            (ApiError::rate("a", None), "rate"),
            (ApiError::conflict(StatusCode::CONFLICT, "a"), "conflict"),
            (ApiError::sign_in("a"), "sign_in"),
            (ApiError::unavailable("a", None), "unavailable"),
        ];
        let mut kinds = Vec::new();
        for (ApiError(status, error, reason), kind) in made {
            let reason = reason.expect(kind);
            let wire = serde_json::to_value(&reason).expect("json");
            assert_eq!(wire["kind"], json!(kind));
            assert_eq!(error, "a");
            let controlled = matches!(
                reason.kind,
                ReasonKind::OffSite
                    | ReasonKind::OffAccount
                    | ReasonKind::OffServer
                    | ReasonKind::OffApp
                    | ReasonKind::Limit
                    | ReasonKind::Capacity
            );
            assert_eq!(
                reason.control.as_deref(),
                controlled.then_some("calls"),
                "{kind}"
            );
            assert_eq!(
                reason.field.as_deref(),
                (reason.kind == ReasonKind::Invalid).then_some("name"),
                "{kind}"
            );
            let fixed = match reason.kind {
                ReasonKind::Invalid => Some(StatusCode::BAD_REQUEST),
                ReasonKind::Rate => Some(StatusCode::TOO_MANY_REQUESTS),
                ReasonKind::SignIn => Some(StatusCode::UNAUTHORIZED),
                ReasonKind::Unavailable => Some(StatusCode::SERVICE_UNAVAILABLE),
                ReasonKind::OffSite
                | ReasonKind::OffAccount
                | ReasonKind::OffServer
                | ReasonKind::OffApp
                | ReasonKind::App
                | ReasonKind::Limit
                | ReasonKind::Capacity
                | ReasonKind::Conflict => None,
            };
            if let Some(fixed) = fixed {
                assert_eq!(status, fixed, "{kind}");
            }
            let back: Reason = serde_json::from_value(wire).expect("reads back");
            assert_eq!(back, reason);
            kinds.push(kind);
        }
        kinds.sort();
        kinds.dedup();
        assert_eq!(kinds.len(), 12);
    }

    #[test]
    fn rate_limits_and_limits_say_their_kind() {
        use crate::api::budget::{SLOW_DOWN, slow_down};
        let ApiError(status, error, reason) = slow_down();
        assert_eq!(
            (status, error.as_str()),
            (StatusCode::TOO_MANY_REQUESTS, SLOW_DOWN)
        );
        assert_eq!(
            serde_json::to_value(reason).expect("json"),
            json!({"kind": "rate"})
        );
        let ApiError(status, error, reason) = crate::api::media::json_over(2 * 1024 * 1024);
        assert_eq!(
            (status, error.as_str()),
            (StatusCode::PAYLOAD_TOO_LARGE, "JSON exceeds 2MB limit")
        );
        assert_eq!(
            serde_json::to_value(reason).expect("json"),
            json!({"kind": "limit", "control": "json_max_mib"})
        );
    }

    #[derive(Debug)]
    struct Coded(&'static str);

    impl std::fmt::Display for Coded {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "relation secret_table: code {}", self.0)
        }
    }

    impl std::error::Error for Coded {}

    impl sqlx::error::DatabaseError for Coded {
        fn message(&self) -> &str {
            "relation secret_table"
        }

        fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
            Some(self.0.into())
        }

        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }

        fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }

        fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }

        fn kind(&self) -> sqlx::error::ErrorKind {
            sqlx::error::ErrorKind::Other
        }
    }

    fn coded(code: &'static str) -> sqlx::Error {
        sqlx::Error::Database(Box::new(Coded(code)))
    }

    #[test]
    fn database_errors_answer_without_their_text() {
        let failed = [
            sqlx::Error::Protocol("relation secret_table".to_string()),
            sqlx::Error::RowNotFound,
            sqlx::Error::ColumnNotFound("secret_table".to_string()),
            coded("23505"),
            coded("42P01"),
            coded("1"),
        ];
        for e in failed {
            let shown = e.to_string();
            let ApiError(status, error, reason) = e.into();
            assert_eq!(
                (status, error.as_str(), reason),
                (StatusCode::INTERNAL_SERVER_ERROR, SERVER_ERROR, None),
                "{shown}"
            );
        }
        let waited = [
            sqlx::Error::PoolTimedOut,
            sqlx::Error::PoolClosed,
            sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::TimedOut, "secret")),
            coded("57014"),
            coded("55P03"),
            coded("5"),
            coded("517"),
        ];
        for e in waited {
            let shown = e.to_string();
            let ApiError(status, error, reason) = e.into();
            assert_eq!(
                (status, error.as_str()),
                (StatusCode::SERVICE_UNAVAILABLE, SERVER_BUSY),
                "{shown}"
            );
            let reason = reason.expect("a reason");
            assert_eq!(reason.kind, ReasonKind::Unavailable);
            assert_eq!(
                (reason.control, reason.field, reason.retry_after),
                (None, None, Some(1))
            );
        }
        let wrapped: ApiError = anyhow::Error::from(coded("42P01")).into();
        assert_eq!(wrapped.1, SERVER_ERROR);
        let wrapped: ApiError = anyhow::Error::from(sqlx::Error::PoolTimedOut).into();
        assert_eq!(wrapped.0, StatusCode::SERVICE_UNAVAILABLE);
        let other: ApiError = anyhow::anyhow!("key file /etc/secret is bad").into();
        assert_eq!(
            (other.0, other.1.as_str()),
            (StatusCode::INTERNAL_SERVER_ERROR, SERVER_ERROR)
        );
        for text in [SERVER_ERROR, SERVER_BUSY] {
            assert!(text.is_ascii() && !text.contains("secret"));
        }
        assert!(ApiError::from(sqlx::Error::PoolTimedOut).failed());
        assert!(ApiError::from(sqlx::Error::RowNotFound).failed());
        assert!(!ApiError(StatusCode::NOT_FOUND, String::new(), None).failed());
    }
}
