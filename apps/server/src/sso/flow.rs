use super::{
    accounts::{self, Identity},
    config::{ProviderConfig, TokenAuth},
    jwt,
    provider::{Provider, bounded_json},
};
use crate::{
    api::{ApiError, auth::new_token, reauth::Session},
    crypt::secrets::{Sealer, open_or, open_or_on},
    db::{Db, now, secret_key},
    state::AppState,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::{Position, Url};

pub const FRESH_SECS: i64 = 300;
pub const FLOW_TTL: i64 = 600;
pub const CODE_TTL: i64 = 600;
pub const TICKET_TTL: i64 = 300;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlowKind {
    Login,
    Link,
    Reauth,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Return {
    Web,
    App,
    Client { origin: String },
}

#[derive(Serialize, Deserialize)]
pub struct NewFlow {
    #[serde(default)]
    pub confirm: bool,
    pub kind: FlowKind,
    pub ret: Return,
    pub challenge: String,
    pub user: Option<String>,
    pub session_key: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Pending {
    flow: NewFlow,
    verifier: String,
    nonce: String,
    issuer: String,
    client_id: String,
    redirect_uri: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AppCode {
    #[serde(default)]
    pub confirm: bool,
    pub kind: FlowKind,
    pub identity: Identity,
    pub client_id: String,
    #[serde(default)]
    admission_policy: Option<String>,
    pub user: Option<String>,
    pub session_key: Option<String>,
    pub auth_time: Option<i64>,
    pub challenge: String,
    #[serde(skip)]
    pub expires_at: i64,
}

fn admission_policy(cfg: &ProviderConfig) -> Option<String> {
    if cfg.allowed_groups.is_empty() {
        return None;
    }
    let mut groups: Vec<_> = cfg.allowed_groups.iter().map(String::as_str).collect();
    groups.sort_unstable();
    groups.dedup();
    let mut hash = Sha256::new();
    for value in std::iter::once(cfg.groups_claim.as_str()).chain(groups) {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value.as_bytes());
    }
    Some(hex::encode(hash.finalize()))
}

impl AppCode {
    pub fn matches_provider(&self, cfg: &ProviderConfig) -> bool {
        self.identity.provider == cfg.id
            && self.identity.issuer == cfg.issuer
            && self.client_id == cfg.client_id
            && self.admission_policy == admission_policy(cfg)
    }
}

#[derive(Debug, Clone, Copy)]
pub enum CallbackError {
    Expired,
    Denied,
    Failed,
    Unavailable,
    NotAllowed,
}
impl CallbackError {
    pub fn query(self) -> &'static str {
        match self {
            Self::Expired => "error=expired",
            Self::Denied => "error=denied",
            Self::Failed => "error=failed",
            Self::Unavailable => "error=unavailable",
            Self::NotAllowed => "error=not_allowed",
        }
    }
}
pub fn expired() -> ApiError {
    ApiError::conflict(
        axum::http::StatusCode::BAD_REQUEST,
        "Sign-in expired. Try again",
    )
}
fn random() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}
fn digest(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
pub fn valid_challenge(challenge: &str) -> bool {
    challenge.len() == 43
        && URL_SAFE_NO_PAD
            .decode(challenge)
            .is_ok_and(|bytes| bytes.len() == 32)
}

pub fn verifier_ok(verifier: &str, challenge: &str) -> bool {
    aws_lc_rs::constant_time::verify_slices_are_equal(
        digest(verifier).as_bytes(),
        challenge.as_bytes(),
    )
    .is_ok()
}
pub fn end_session_url(
    provider: &Provider,
    meta: &super::provider::Metadata,
    public_url: &Url,
) -> Option<String> {
    if !provider.config.end_session {
        return None;
    }
    let mut endpoint = meta.end_session_endpoint.clone()?;
    endpoint
        .query_pairs_mut()
        .append_pair("client_id", &provider.config.client_id)
        .append_pair(
            "post_logout_redirect_uri",
            public_url.join("/login").ok()?.as_str(),
        );
    Some(endpoint.into())
}

pub fn return_url(ret: Return, public_url: &Url, query: &str) -> String {
    match ret {
        Return::Web => format!("{}/sso?{query}", public_url.as_str().trim_end_matches('/')),
        Return::Client { origin } => {
            let mut url = public_url.clone();
            url.set_path(&format!("{}/sso", url.path().trim_end_matches('/')));
            let mut fragment = url::form_urlencoded::Serializer::new(String::new());
            if let Some(receipt) = query.strip_prefix("consent=") {
                fragment.append_pair("consent", receipt);
            } else {
                fragment.append_pair(
                    "client_error",
                    query.strip_prefix("error=").unwrap_or("failed"),
                );
                fragment.append_pair("origin", &origin);
            }
            url.set_fragment(Some(&fragment.finish()));
            url.into()
        }
        Return::App => format!(
            "rchat://{}/sso?{query}",
            &public_url[Position::BeforeHost..Position::AfterPort]
        ),
    }
}

/// Adds a pending row. Its data is stored sealed, bound to the row id, when a key seals secrets.
async fn put<'e>(
    conn: impl sqlx::Executor<'e, Database = sqlx::Any>,
    sealer: &Sealer,
    (id, kind, provider): (&str, &str, &str),
    data: String,
    expiry: i64,
) -> sqlx::Result<()> {
    let sealed = sealer.seal("sso_pending", "data", id, &data);
    let query = match sealed {
        Some(record) => sqlx::query(
            "INSERT INTO sso_pending(id,kind,provider,data,data_sealed,expires_at) VALUES($1,$2,$3,'',$4,$5)",
        )
        .bind(id)
        .bind(kind)
        .bind(provider)
        .bind(record),
        None => sqlx::query(
            "INSERT INTO sso_pending(id,kind,provider,data,expires_at) VALUES($1,$2,$3,$4,$5)",
        )
        .bind(id)
        .bind(kind)
        .bind(provider)
        .bind(data),
    };
    query.bind(expiry).execute(conn).await.map(|_| ())
}

/// The data of a pending row as it was stored.
async fn pending(
    db: &Db,
    id: &str,
    data: String,
    sealed: Option<Vec<u8>>,
) -> Result<String, ApiError> {
    Ok(open_or(db, "sso_pending", "data", id, sealed, data)
        .await?
        .to_string())
}

async fn store<T: Serialize>(
    db: &Db,
    value: &str,
    kind: &str,
    provider: &str,
    data: &T,
    expiry: i64,
) -> Result<(), ApiError> {
    let data = serde_json::to_string(data).map_err(ApiError::internal)?;
    let (sealer, id) = (Sealer::of(db).await?, secret_key(value));
    put(db, &sealer, (&id, kind, provider), data, expiry).await?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct Ticket {
    pub kind: FlowKind,
    pub user: String,
    pub session_key: String,
}

pub async fn reauth_ticket(
    state: &AppState,
    session: &Session,
    provider: &Provider,
) -> Result<String, ApiError> {
    let cfg = &provider.config;
    let linked: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM sso_links WHERE username=$1 AND provider=$2 AND issuer=$3 LIMIT 1",
    )
    .bind(&session.user.username)
    .bind(&cfg.id)
    .bind(&cfg.issuer)
    .fetch_optional(&state.db)
    .await?;
    if linked.is_none() {
        return Err(ApiError::conflict(
            axum::http::StatusCode::BAD_REQUEST,
            "Not linked",
        ));
    }
    issue_ticket(state, session, &cfg.id, FlowKind::Reauth).await
}

pub(crate) async fn issue_ticket(
    state: &AppState,
    session: &Session,
    provider: &str,
    kind: FlowKind,
) -> Result<String, ApiError> {
    let value = random();
    let ticket = Ticket {
        kind,
        user: session.user.username.clone(),
        session_key: secret_key(&session.token),
    };
    store(
        &state.db,
        &value,
        "ticket",
        provider,
        &ticket,
        state.clock.unix() + TICKET_TTL,
    )
    .await?;
    Ok(value)
}

pub async fn take_ticket(db: &Db, value: &str, provider: &str) -> Result<Option<Ticket>, ApiError> {
    let id = secret_key(value);
    let row: Option<(String, Option<Vec<u8>>)> = sqlx::query_as("DELETE FROM sso_pending WHERE id=$1 AND kind='ticket' AND provider=$2 AND expires_at>$3 RETURNING data, data_sealed")
        .bind(&id).bind(provider).bind(now()).fetch_optional(db).await?;
    let Some((data, sealed)) = row else {
        return Ok(None);
    };
    let data = pending(db, &id, data, sealed).await?;
    serde_json::from_str(&data)
        .map(Some)
        .map_err(ApiError::internal)
}

fn fresh(auth_time: Option<i64>) -> bool {
    auth_time.is_some_and(|t| t >= now().saturating_sub(FRESH_SECS))
}

async fn linked(db: &Db, id: &Identity, user: Option<&str>) -> sqlx::Result<bool> {
    let found: Option<String> = sqlx::query_scalar("SELECT username FROM sso_links WHERE issuer=$1 AND subject=$2 AND provider=$3 AND username=$4")
        .bind(&id.issuer).bind(id.subject.as_str()).bind(&id.provider).bind(user).fetch_optional(db).await?;
    Ok(found.is_some())
}

pub async fn verify_fresh(
    state: &AppState,
    session: &Session,
    provider: &str,
    code: &str,
) -> Result<(), ApiError> {
    let denied = || ApiError::sign_in("Sign in again to continue");
    let app = take_code(&state.db, code).await.map_err(|e| {
        if e.status() == axum::http::StatusCode::BAD_REQUEST {
            denied()
        } else {
            e
        }
    })?;
    if app.kind != FlowKind::Reauth
        || app.identity.provider != provider
        || app.user.as_deref() != Some(&session.user.username)
        || app.session_key.as_deref() != Some(&secret_key(&session.token))
        || !fresh(app.auth_time)
        || !state
            .sso
            .provider(provider)
            .is_some_and(|p| app.matches_provider(&p.config))
        || !linked(&state.db, &app.identity, app.user.as_deref()).await?
    {
        return Err(denied());
    }
    Ok(())
}

pub async fn begin(
    state: &AppState,
    provider: &Provider,
    flow: NewFlow,
) -> Result<Url, CallbackError> {
    let cfg = &provider.config;
    let meta = provider
        .metadata(state.sso.http())
        .await
        .map_err(|_| CallbackError::Unavailable)?;
    let public = state
        .instance
        .public_url
        .as_ref()
        .ok_or(CallbackError::Unavailable)?;
    let api = state.instance.api_url.as_ref().map_or_else(
        || format!("{}/api", public.as_str().trim_end_matches('/')),
        |u| u.as_str().trim_end_matches('/').to_owned(),
    );
    let pending = Pending {
        flow,
        verifier: random(),
        nonce: random(),
        issuer: cfg.issuer.clone(),
        client_id: cfg.client_id.clone(),
        redirect_uri: format!("{api}/auth/oidc/{}/callback", cfg.id),
    };
    let value = random();
    let mut url = meta.authorization_endpoint.clone();
    url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", &cfg.client_id),
        ("redirect_uri", &pending.redirect_uri),
        ("scope", &cfg.scopes.join(" ")),
        ("state", &value),
        ("nonce", &pending.nonce),
        ("code_challenge", &digest(&pending.verifier)),
        ("code_challenge_method", "S256"),
    ]);
    if pending.flow.confirm || pending.flow.kind == FlowKind::Reauth {
        url.query_pairs_mut()
            .extend_pairs([("prompt", "login"), ("max_age", "0")]);
    }
    store(
        &state.db,
        &value,
        "flow",
        &cfg.id,
        &pending,
        state.clock.unix() + FLOW_TTL,
    )
    .await
    .map_err(|_| CallbackError::Failed)?;
    Ok(url)
}

pub async fn finish(
    state: &AppState,
    provider: &Provider,
    state_param: &str,
    code: &str,
) -> Result<(Return, String), (Return, CallbackError)> {
    finish_response(state, provider, state_param, Ok(code)).await
}

pub async fn finish_response(
    state: &AppState,
    provider: &Provider,
    state_param: &str,
    response: Result<&str, CallbackError>,
) -> Result<(Return, String), (Return, CallbackError)> {
    let id = secret_key(state_param);
    let row: Option<(String, Option<Vec<u8>>)> = sqlx::query_as(
        "DELETE FROM sso_pending WHERE id=$1 AND kind='flow' AND provider=$2 AND expires_at>$3 RETURNING data, data_sealed",
    )
    .bind(&id)
    .bind(&provider.config.id)
    .bind(state.clock.unix())
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        tracing::warn!(%e, "OIDC state lookup failed");
        (Return::Web, CallbackError::Failed)
    })?;
    let (data, sealed) = row.ok_or((Return::Web, CallbackError::Expired))?;
    let data = pending(&state.db, &id, data, sealed).await.map_err(|e| {
        tracing::warn!(%e, "OIDC state lookup failed");
        (Return::Web, CallbackError::Failed)
    })?;
    let p: Pending =
        serde_json::from_str(&data).map_err(|_| (Return::Web, CallbackError::Failed))?;
    let ret = p.flow.ret.clone();
    if p.issuer != provider.config.issuer || p.client_id != provider.config.client_id {
        return Err((ret, CallbackError::Failed));
    }
    let code = response.map_err(|e| (ret.clone(), e))?;
    complete(state, provider, p, code)
        .await
        .map(|c| (ret.clone(), c))
        .map_err(|e| (ret, e))
}

async fn complete(
    state: &AppState,
    provider: &Provider,
    p: Pending,
    code: &str,
) -> Result<String, CallbackError> {
    let cfg = &provider.config;
    let http = state.sso.http();
    let meta = provider
        .metadata(http)
        .await
        .map_err(|_| CallbackError::Unavailable)?;
    let mut request = http.post(meta.token_endpoint.clone());
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", &p.redirect_uri),
        ("code_verifier", &p.verifier),
        ("client_id", &cfg.client_id),
    ];
    if let Some(secret) = &cfg.client_secret {
        match cfg.token_auth {
            TokenAuth::Basic => {
                let escape = |s: &str| {
                    url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>()
                };
                request = request.basic_auth(escape(&cfg.client_id), Some(escape(&secret.0)));
            }
            TokenAuth::Post => form.push(("client_secret", &secret.0)),
        }
    }
    let res = request
        .form(&form)
        .send()
        .await
        .map_err(|_| CallbackError::Unavailable)?;
    #[derive(Deserialize)]
    struct Tokens {
        id_token: String,
    }
    let Tokens { id_token } = bounded_json(res).await.map_err(|_| CallbackError::Failed)?;
    let invalid = |e: jwt::SsoError| {
        tracing::warn!(%e,"OIDC token verification failed");
        CallbackError::Failed
    };
    let (alg, kid) = jwt::header(&id_token).map_err(invalid)?;
    let key = provider
        .key(http, alg, kid.as_deref())
        .await
        .map_err(invalid)?;
    let claims = jwt::verify_id_token(
        &id_token,
        &key,
        alg,
        &jwt::Expect {
            issuer: &p.issuer,
            client_id: &p.client_id,
            nonce: &p.nonce,
            now: state.clock.unix(),
        },
    )
    .map_err(invalid)?;
    let claim = |name: &str| claims.claims.get(name)?.as_str();
    let group_claim = claims.claims.get(&cfg.groups_claim);
    let groups: Vec<&str> = match group_claim {
        Some(serde_json::Value::String(group)) => vec![group.as_str()],
        Some(serde_json::Value::Array(items)) => {
            items.iter().filter_map(|item| item.as_str()).collect()
        }
        _ => Vec::new(),
    };
    if !cfg.allowed_groups.is_empty()
        && !groups
            .iter()
            .any(|group| cfg.allowed_groups.iter().any(|allowed| allowed == group))
    {
        return Err(CallbackError::NotAllowed);
    }
    let username = claim(&cfg.username_claim);
    let display = match (cfg.sync_profile, claim(&cfg.display_claim)) {
        (true, Some(display)) => accounts::display_from_claim(&state.db, display)
            .await
            .map_err(|_| CallbackError::Unavailable)?,
        _ => None,
    };
    let identity = Identity {
        provider: cfg.id.clone(),
        issuer: p.issuer,
        username_claim: username.and_then(accounts::clean_username),
        scim_key: username
            .filter(|_| {
                state
                    .sso
                    .config
                    .scim
                    .as_ref()
                    .and_then(|scim| scim.provider.as_ref())
                    == Some(&cfg.id)
            })
            .map(accounts::user_name_key),
        display,
        subject: accounts::oidc_key(&claims.sub),
        groups: groups
            .into_iter()
            .filter(|group| state.sso.config.group_map.0.contains_key(*group))
            .map(str::to_owned)
            .collect(),
        sid: claims.sid.as_deref().map(accounts::oidc_key),
    };
    if p.flow.confirm && !fresh(claims.auth_time) {
        return Err(CallbackError::Failed);
    }
    if p.flow.kind == FlowKind::Reauth
        && (!fresh(claims.auth_time)
            || !linked(&state.db, &identity, p.flow.user.as_deref())
                .await
                .map_err(|_| CallbackError::Failed)?)
    {
        return Err(CallbackError::Failed);
    }
    let app = AppCode {
        confirm: p.flow.confirm,
        session_key: p.flow.session_key,
        kind: p.flow.kind,
        identity,
        client_id: p.client_id,
        admission_policy: admission_policy(cfg),
        user: p.flow.user,
        challenge: p.flow.challenge,
        auth_time: claims.auth_time,
        expires_at: state.clock.unix() + CODE_TTL,
    };
    let value = new_token();
    if let Return::Client { origin } = p.flow.ret {
        let expires_at = app.expires_at;
        store(
            &state.db,
            &value,
            "client_consent",
            &cfg.id,
            &Consent { origin, app },
            expires_at,
        )
        .await
        .map_err(|_| CallbackError::Failed)?;
        return Ok(value);
    }
    put_back(&state.db, &value, &app, app.expires_at)
        .await
        .map_err(|_| CallbackError::Failed)?;
    Ok(value)
}

/// One-use Settings confirmation bound to the session returned by this exchange.
#[derive(Serialize, utoipa::ToSchema)]
pub struct Confirmation {
    /// Linked provider ID.
    pub provider: String,
    /// One-use fresh IdP proof for the newly issued bearer.
    pub code: String,
    /// Proof deadline in Unix seconds.
    pub expires_at: i64,
}

pub(super) async fn issue_confirmation(
    conn: &mut sqlx::AnyConnection,
    sealer: &Sealer,
    app: &AppCode,
    username: &str,
    token: &str,
    session_deadline: i64,
) -> Result<Confirmation, ApiError> {
    let auth_time = app.auth_time.ok_or_else(expired)?;
    let expires_at = app
        .expires_at
        .min(auth_time.saturating_add(FRESH_SECS))
        .min(session_deadline);
    if expires_at <= now() {
        return Err(expired());
    }
    let proof = AppCode {
        kind: FlowKind::Reauth,
        confirm: false,
        user: Some(username.to_owned()),
        session_key: Some(secret_key(token)),
        ..app.clone()
    };
    let code = new_token();
    put(
        conn,
        sealer,
        (&secret_key(&code), "code", &app.identity.provider),
        serde_json::to_string(&proof).map_err(ApiError::internal)?,
        expires_at,
    )
    .await?;
    Ok(Confirmation {
        provider: app.identity.provider.clone(),
        code,
        expires_at,
    })
}

pub async fn take_code(db: &Db, code: &str) -> Result<AppCode, ApiError> {
    let id = secret_key(code);
    let (data, expires_at, sealed): (String, i64, Option<Vec<u8>>) = sqlx::query_as(
        "DELETE FROM sso_pending WHERE id=$1 AND kind='code' AND expires_at>$2 RETURNING data, expires_at, data_sealed",
    )
    .bind(&id)
    .bind(now())
    .fetch_optional(db)
    .await?
    .ok_or_else(expired)?;
    let data = pending(db, &id, data, sealed).await?;
    let mut app: AppCode = serde_json::from_str(&data).map_err(ApiError::internal)?;
    app.expires_at = expires_at;
    Ok(app)
}
pub async fn put_back(db: &Db, code: &str, c: &AppCode, expires_at: i64) -> Result<(), ApiError> {
    store(
        db,
        code,
        "code",
        &c.identity.provider,
        c,
        c.expires_at.min(expires_at),
    )
    .await
}

#[derive(Serialize, Deserialize)]
struct Consent {
    origin: String,
    app: AppCode,
}
/// What to do with an outstanding client login.
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ConsentAction {
    Describe,
    Allow,
    Cancel,
}
/// An outstanding client login, with its sign-in code once allowed.
#[derive(Serialize, utoipa::ToSchema)]
pub struct ConsentResult {
    /// Web origin that asked for the login.
    pub origin: String,
    /// S256 challenge the client started the sign-in with.
    pub challenge: String,
    /// Single-use sign-in code, present only after allow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}
pub async fn client_consent(
    db: &Db,
    receipt: &str,
    action: ConsentAction,
) -> Result<ConsentResult, ApiError> {
    if receipt.len() != 64 || !receipt.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(expired());
    }
    let (sealer, id) = (Sealer::of(db).await?, secret_key(receipt));
    let ring = crate::db::ring(db);
    let mut tx = db.begin().await?;
    let sql = match action {
        ConsentAction::Describe => {
            "SELECT data,expires_at,data_sealed FROM sso_pending WHERE id=$1 AND kind='client_consent' AND expires_at>$2"
        }
        _ => {
            "DELETE FROM sso_pending WHERE id=$1 AND kind='client_consent' AND expires_at>$2 RETURNING data,expires_at,data_sealed"
        }
    };
    let (raw, expires, sealed): (String, i64, Option<Vec<u8>>) = sqlx::query_as(sql)
        .bind(&id)
        .bind(now())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(expired)?;
    let raw = open_or_on(&ring, &mut tx, "sso_pending", "data", &id, sealed, raw)
        .await?
        .to_string();
    let consent: Consent = serde_json::from_str(&raw).map_err(ApiError::internal)?;
    let code = if matches!(action, ConsentAction::Allow) {
        let code = new_token();
        let data = serde_json::to_string(&consent.app).map_err(ApiError::internal)?;
        put(
            &mut *tx,
            &sealer,
            (&secret_key(&code), "code", &consent.app.identity.provider),
            data,
            expires,
        )
        .await?;
        Some(code)
    } else {
        None
    };
    tx.commit().await?;
    Ok(ConsentResult {
        origin: consent.origin,
        challenge: consent.app.challenge,
        code,
    })
}
