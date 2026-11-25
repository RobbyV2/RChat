use super::{
    ApiError, Authed, NAME_MAX, OkResp,
    auth::{Me, me_payload},
    bad,
    reauth::{AuthedSession, ReAuthBody},
};
use crate::{
    sso::{
        accounts::{NameIssue, SignIn, sign_in},
        flow::{self, CallbackError, FlowKind, NewFlow, Return},
    },
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Deserialize)]
pub(crate) struct StartParams {
    #[serde(rename = "return")]
    ret: Option<String>,
    origin: Option<String>,
    challenge: Option<String>,
    ticket: Option<String>,
}
#[derive(Deserialize)]
pub(crate) struct CallbackParams {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
    iss: Option<String>,
}

fn redirect(url: String) -> Response {
    (
        StatusCode::FOUND,
        [
            (header::LOCATION, url.as_str()),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
    )
        .into_response()
}
fn back(state: &AppState, ret: Return, query: &str) -> Result<Response, ApiError> {
    let public = state
        .instance
        .public_url
        .as_ref()
        .ok_or_else(|| ApiError::internal("Missing SSO public URL"))?;
    Ok(redirect(flow::return_url(ret, public, query)))
}
fn callback_error(
    state: &AppState,
    provider: &str,
    ret: Return,
    error: CallbackError,
) -> Result<Response, ApiError> {
    tracing::warn!(provider, ?error, "OIDC sign-in failed");
    back(state, ret, error.query())
}

/// Which operation the ticket authorizes.
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TicketPurpose {
    Link,
    Reauth,
}

/// Request a one-time ticket for a provider flow.
#[derive(Deserialize, ToSchema)]
pub struct TicketReq {
    /// Configured provider ID.
    pub provider: String,
    /// Operation to authorize.
    pub purpose: TicketPurpose,
    /// Confirmation for linking a new identity.
    pub reauth: Option<ReAuthBody>,
}

/// Single-use ticket to pass to the start endpoint.
#[derive(Serialize, ToSchema)]
pub struct TicketResp {
    /// Opaque ticket valid for five minutes.
    pub ticket: String,
}

/// Obtain a ticket for a signed-in account.
///
/// Pass the ticket to the configured provider's start URL. Linking requires a password, backup phrase or fresh code from an existing link.
/// For a backup phrase, sign the recovery challenge with purpose `link_idp` and the target provider ID as context.
#[utoipa::path(post, path="/api/v1/me/sso/ticket", tag="Account", request_body=TicketReq, responses((status=200,description="Single-use provider ticket",body=TicketResp),(status=400,description="Missing confirmation or unsuitable provider"),(status=401,description="Missing or invalid session")),security(("bearer"=[])))]
pub(crate) async fn ticket(
    State(state): State<AppState>,
    AuthedSession(session): AuthedSession,
    Json(q): Json<TicketReq>,
) -> Result<impl IntoResponse, ApiError> {
    let provider = state
        .sso
        .provider(&q.provider)
        .ok_or_else(|| bad("Not linked"))?;
    let ticket = match q.purpose {
        TicketPurpose::Link => {
            let exists: Option<i32> = sqlx::query_scalar(
                "SELECT 1 FROM sso_links WHERE username=$1 AND (provider=$2 OR issuer=$3) LIMIT 1",
            )
            .bind(&session.user.username)
            .bind(&q.provider)
            .bind(&provider.config.issuer)
            .fetch_optional(&state.db)
            .await?;
            if exists.is_some() {
                return Err(bad("Already linked"));
            }
            let proof = q
                .reauth
                .ok_or_else(|| bad(super::reauth::ONE_WAY))?
                .try_into()?;
            super::reauth::check(
                &state,
                &session,
                proof,
                super::reauth::Purpose::LinkIdp {
                    provider: q.provider.clone(),
                },
            )
            .await?;
            flow::issue_ticket(&state, &session, &q.provider, FlowKind::Link).await?
        }
        TicketPurpose::Reauth => flow::reauth_ticket(&state, &session, &provider).await?,
    };
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(TicketResp { ticket }),
    ))
}

/// An external sign-in method attached to this account.
#[derive(Serialize, ToSchema)]
pub struct LinkedProvider {
    /// Provider identifier.
    pub provider: String,
    /// Configured display name, falling back to the identifier.
    pub name: String,
    /// Unix time in seconds when this sign-in was linked.
    pub linked_at: i64,
    /// Whether this provider can currently be removed while preserving usable sign-in methods.
    pub can_unlink: bool,
}

/// List this account's linked sign-in methods.
///
/// Returns each provider ID, display name, link creation time and current unlink eligibility. DELETE checks eligibility again.
#[utoipa::path(get,path="/api/v1/me/sso", tag="Account", responses((status=200,description="Linked providers",body=Vec<LinkedProvider>),(status=401,description="Missing or invalid session")),security(("bearer"=[])))]
pub(crate) async fn list(
    State(state): State<AppState>,
    Authed(user): Authed,
) -> Result<Json<Vec<LinkedProvider>>, ApiError> {
    let rows = crate::sso::accounts::account_links(&state.db, &state, &user).await?;
    Ok(Json(
        rows.into_iter()
            .map(|link| {
                let provider = link.provider;
                let name = state
                    .sso
                    .provider(&provider)
                    .map_or_else(|| provider.clone(), |p| p.config.name.clone());
                LinkedProvider {
                    provider,
                    name,
                    linked_at: link.linked_at,
                    can_unlink: link.can_unlink,
                }
            })
            .collect(),
    ))
}

/// Remove a linked sign-in method.
///
/// Removing a configured sign-in requires a local password or another link matching a configured provider ID and issuer. Existing sessions stay signed in.
#[utoipa::path(delete,path="/api/v1/me/sso/{provider}",tag="Account",params(("provider"=String,Path,description="Linked provider ID")),responses((status=200,description="Provider removed",body=OkResp),(status=400,description="Another sign-in method is required"),(status=404,description="Provider link missing")),security(("bearer"=[])))]
pub(crate) async fn unlink(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(provider): Path<String>,
) -> Result<Json<OkResp>, ApiError> {
    crate::sso::accounts::unlink(&state, &user, &provider).await?;
    Ok(super::ok())
}

/// Remove the provider with ID `ticket`.
///
/// This is the literal `ticket` case of the provider removal endpoint.
#[utoipa::path(delete,path="/api/v1/me/sso/ticket",tag="Account",responses((status=200,description="Provider removed",body=OkResp),(status=400,description="Another sign-in method is required"),(status=404,description="Provider link missing")),security(("bearer"=[])))]
pub(crate) async fn unlink_ticket_provider(
    state: State<AppState>,
    user: Authed,
) -> Result<Json<OkResp>, ApiError> {
    unlink(state, user, Path("ticket".into())).await
}

/// Begin sign-in with a client-generated S256 challenge.
///
/// Returns are limited to the hosted page and the instance's shell deep link.
#[utoipa::path(get, path = "/api/v1/auth/oidc/{provider}/start", tag = "Auth", params(("provider"=String,Path,description="Configured provider ID"),("return"=String,Query,description="web, app, or client"),("origin"=Option<String>,Query,description="Exact requesting origin for client returns"),("ticket"=Option<String>,Query,description="Single-use account ticket for web or app returns"),("challenge"=String,Query,description="Unpadded base64url SHA-256 digest of the client verifier")), responses((status=302,description="Provider authorization or fixed sign-in return URL"),(status=400,description="Invalid parameters"),(status=404,description="Unknown provider")), security(()))]
pub(crate) async fn start(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<StartParams>,
) -> Result<Response, ApiError> {
    let provider = state
        .sso
        .provider(&id)
        .ok_or_else(super::access::not_found)?;
    let ret = match (q.ret.as_deref(), q.origin) {
        (Some("web"), None) => Return::Web,
        (Some("app"), None) => Return::App,
        (Some("client"), Some(origin)) if valid_client_origin(&origin) => Return::Client { origin },
        _ => return Err(bad("Invalid return origin")),
    };
    let challenge = q
        .challenge
        .filter(|challenge| flow::valid_challenge(challenge))
        .ok_or_else(|| bad("Invalid challenge"))?;
    if matches!(ret, Return::Client { .. }) && q.ticket.is_some() {
        return Err(bad("Account tickets require a web or app return"));
    }
    let (kind, user, session_key) = if let Some(value) = q.ticket {
        let Some(ticket) = flow::take_ticket(&state.db, &value, &id).await? else {
            return callback_error(&state, &id, ret, CallbackError::Expired);
        };
        (ticket.kind, Some(ticket.user), Some(ticket.session_key))
    } else {
        (FlowKind::Login, None, None)
    };
    match flow::begin(
        &state,
        &provider,
        NewFlow {
            kind,
            ret: ret.clone(),
            challenge,
            user,
            session_key,
        },
    )
    .await
    {
        Ok(url) => Ok(redirect(url.into())),
        Err(e) => callback_error(&state, &id, ret, e),
    }
}

/// Redeem the provider response.
///
/// Only a verifier-bound single-use code or an error appears in the return URL.
#[utoipa::path(get, path = "/api/v1/auth/oidc/{provider}/callback", tag = "Auth", params(("provider"=String,Path,description="Configured provider ID"),("state"=String,Query,description="State value from the authorization request"),("code"=Option<String>,Query,description="Provider authorization code"),("error"=Option<String>,Query,description="Provider authorization error"),("iss"=Option<String>,Query,description="Authorization response issuer, when supplied by the provider")), responses((status=302,description="Redirect to sign-in return URL"),(status=404,description="Unknown provider")), security(()))]
pub(crate) async fn callback(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CallbackParams>,
) -> Result<Response, ApiError> {
    let provider = state
        .sso
        .provider(&id)
        .ok_or_else(super::access::not_found)?;
    let state_param = q.state.as_deref().unwrap_or_default();
    let result = if q
        .iss
        .as_ref()
        .is_some_and(|iss| *iss != provider.config.issuer)
    {
        Err(CallbackError::Failed)
    } else {
        match (q.error.as_deref(), q.code.as_deref()) {
            (Some("access_denied"), None) => Err(CallbackError::Denied),
            (None, Some(code)) if !code.is_empty() => Ok(code),
            _ => Err(CallbackError::Failed),
        }
    };
    let result = match result {
        Ok(code) => flow::finish(&state, &provider, state_param, code).await,
        Err(e) => flow::finish_response(&state, &provider, state_param, Err(e)).await,
    };
    match result {
        Ok((ret, value)) => {
            let key = if matches!(ret, Return::Client { .. }) {
                "consent"
            } else {
                "code"
            };
            back(&state, ret, &format!("{key}={value}"))
        }
        Err((ret, e)) => callback_error(&state, &id, ret, e),
    }
}

/// Proof of possession for a returned sign-in code.
#[derive(Deserialize, ToSchema)]
pub struct ExchangeReq {
    /// Single-use sign-in code received by the client.
    pub code: String,
    /// Original client-generated PKCE verifier.
    pub verifier: String,
    /// Chosen local username when retrying a username selection.
    pub username: Option<String>,
}
/// Result of exchanging a verifier-bound sign-in code.
#[derive(Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExchangeResp {
    /// A session is ready for the verified account.
    Session {
        /// Bearer token for the signed-in account.
        token: String,
        /// Profile of the signed-in account.
        user: Box<Me>,
        /// Whether this provider supports configured sign-out.
        end_session: bool,
    },
    /// A local account name is required to finish this exchange.
    PickUsername {
        /// Suggested local username, when available.
        suggestion: Option<String>,
        /// Reason for selecting a username, either taken or invalid.
        #[schema(value_type=String)]
        reason: NameIssue,
    },
    /// A provider identity has been attached to an existing local account.
    Linked {
        /// Configured provider ID of the linked identity.
        provider: String,
    },
}

/// Describe the discriminator that utoipa synthesizes from the serde tag.
pub(crate) struct ExchangeDiscriminator;

impl utoipa::Modify for ExchangeDiscriminator {
    fn modify(&self, doc: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::{RefOr, Schema};
        let schema = doc
            .components
            .as_mut()
            .and_then(|c| c.schemas.get_mut("ExchangeResp"));
        if let Some(RefOr::T(Schema::OneOf(variants))) = schema {
            for variant in &mut variants.items {
                if let RefOr::T(Schema::Object(object)) = variant
                    && let Some(RefOr::T(Schema::Object(kind))) = object.properties.get_mut("kind")
                {
                    kind.description = Some("Identifies the exchange result.".into());
                }
            }
        }
    }
}

/// Exchange the single-use code with the original verifier.
///
/// Unknown, expired, consumed, and mismatched codes give the same error. Session tokens appear only in the JSON response.
#[utoipa::path(post, path = "/api/v1/auth/oidc/exchange", tag = "Auth",request_body=ExchangeReq, responses((status=200,description="Session, linked provider or username selection",body=ExchangeResp),(status=400,description="Sign-in expired. Try again, or invalid username"),(status=403,description="Account or registration policy denied sign-in")), security(()))]
pub(crate) async fn exchange(
    State(state): State<AppState>,
    Json(q): Json<ExchangeReq>,
) -> Result<Response, ApiError> {
    if q.code.len() > 64 || !(43..=128).contains(&q.verifier.len()) {
        return Err(flow::expired());
    }
    let app = flow::take_code(&state.db, &q.code).await?;
    if !flow::verifier_ok(&q.verifier, &app.challenge) {
        return Err(flow::expired());
    }
    let provider = state
        .sso
        .provider(&app.identity.provider)
        .filter(|provider| app.matches_provider(&provider.config))
        .ok_or_else(flow::expired)?;
    match (app.kind, app.user.as_deref(), app.session_key.as_deref()) {
        (FlowKind::Link, Some(user), Some(key)) => {
            crate::sso::accounts::link(&state, user, key, &app.identity).await?;
            return Ok((
                [(header::CACHE_CONTROL, "no-store")],
                Json(ExchangeResp::Linked {
                    provider: app.identity.provider,
                }),
            )
                .into_response());
        }
        (FlowKind::Login, None, None) => (),
        _ => return Err(flow::expired()),
    }
    let result = async {
        if let Some(name) = &q.username {
            super::check_len(name, NAME_MAX, "Username")?;
        }
        sign_in(&state, &app.identity, q.username.as_deref()).await
    }
    .await;
    let response = match result {
        Ok(SignIn::Session { user, token, .. }) => {
            let me = me_payload(&state.db, &user).await?;
            let end_session = provider.config.end_session
                && provider
                    .metadata(state.sso.http())
                    .await
                    .is_ok_and(|m| m.end_session_endpoint.is_some());
            ExchangeResp::Session {
                token,
                user: Box::new(me),
                end_session,
            }
        }
        Ok(SignIn::NeedsUsername { suggestion, reason }) => {
            flow::put_back(&state.db, &q.code, &app, app.expires_at).await?;
            ExchangeResp::PickUsername { suggestion, reason }
        }
        Err(e) => {
            if q.username.is_some() && e.0 == StatusCode::BAD_REQUEST {
                flow::put_back(&state.db, &q.code, &app, app.expires_at).await?;
            }
            return Err(e);
        }
    };
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(response)).into_response())
}

/// Signed notification from the configured identity provider.
#[derive(Deserialize, ToSchema)]
pub struct LogoutForm {
    /// Provider-signed back-channel logout JWT.
    logout_token: String,
}

/// End the provider sessions identified by a verified logout notification.
///
/// Accepts a signed logout token as form data. A session ID selects matching sessions from this
/// provider. A subject alone selects this provider's sessions for the linked account.
#[utoipa::path(post, path = "/api/v1/auth/oidc/{provider}/backchannel_logout", tag = "Auth", params(("provider"=String,Path,description="Configured provider ID")), request_body(content=LogoutForm,content_type="application/x-www-form-urlencoded"), responses((status=200,description="Matching sessions ended"),(status=400,description="Invalid logout request"),(status=404,description="Unknown provider")), security(()))]
pub(crate) async fn backchannel_logout(
    State(state): State<AppState>,
    Path(id): Path<String>,
    form: Result<axum::Form<LogoutForm>, axum::extract::rejection::FormRejection>,
) -> Result<Response, ApiError> {
    use crate::sso::{accounts::oidc_key, audit, jwt};
    let provider = state
        .sso
        .provider(&id)
        .ok_or_else(super::access::not_found)?;
    let invalid = |_| bad("invalid_request");
    let token = form.map_err(|_| bad("invalid_request"))?.0.logout_token;
    let (alg, kid) = jwt::header(&token).map_err(invalid)?;
    let key = provider
        .key(state.sso.http(), alg, kid.as_deref())
        .await
        .map_err(invalid)?;
    let cfg = &provider.config;
    let claims = jwt::verify_logout_token(
        &token,
        &key,
        alg,
        &cfg.issuer,
        &cfg.client_id,
        crate::db::now(),
    )
    .map_err(invalid)?;
    let users: Vec<String> = if let Some(sid) = claims.sid {
        sqlx::query_scalar(
            "DELETE FROM tokens WHERE sso_provider=$1 AND sso_sid=$2 RETURNING username",
        )
        .bind(&id)
        .bind(oidc_key(&sid).as_str())
        .fetch_all(&state.db)
        .await?
    } else {
        let sub = claims.sub.ok_or_else(|| bad("invalid_request"))?;
        sqlx::query_scalar(
            "DELETE FROM tokens WHERE sso_provider=$1 AND username IN
             (SELECT username FROM sso_links WHERE issuer=$2 AND subject=$3)
             RETURNING username",
        )
        .bind(&id)
        .bind(&cfg.issuer)
        .bind(oidc_key(&sub).as_str())
        .fetch_all(&state.db)
        .await?
    };
    let count = users.len();
    for username in users.into_iter().collect::<std::collections::BTreeSet<_>>() {
        state
            .hub
            .broadcast(crate::ws::WsEvent::TokensRevoked { username });
    }
    audit::note(
        &state.db,
        "sso",
        "sso.backchannel_logout",
        Some(&id),
        serde_json::json!({"sessions": count}),
    )
    .await;
    Ok(([(header::CACHE_CONTROL, "no-store")], ()).into_response())
}

#[cfg(test)]
mod tests;

fn valid_client_origin(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    url.origin().ascii_serialization() == origin
        && (url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
}

/// A client login receipt and the decision on it.
#[derive(Deserialize, ToSchema)]
pub struct ConsentRequest {
    /// Receipt from the consent return of the sign-in.
    receipt: String,
    /// Describe the login, allow it, or cancel it.
    action: flow::ConsentAction,
}
/// Describe or decide an outstanding client login from the instance's own consent page.
///
/// No authentication. The `Origin` header must be this instance's public origin. Allow and
/// cancel use up the receipt.
#[utoipa::path(post,path="/api/v1/auth/oidc/client-consent",tag="Auth",request_body=ConsentRequest,
 responses((status=200,description="Recorded destination and approved code, if any",body=flow::ConsentResult),(status=400,description="Invalid or expired receipt"),(status=403,description="Consent must come from this instance")),security(()))]
pub(crate) async fn client_consent(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(q): Json<ConsentRequest>,
) -> Result<Response, ApiError> {
    let public = state
        .instance
        .public_url
        .as_ref()
        .ok_or_else(|| bad("Missing public URL"))?
        .origin()
        .ascii_serialization();
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(public.as_str()) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Consent must come from this instance".into(),
            None,
        ));
    }
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(flow::client_consent(&state.db, &q.receipt, q.action).await?),
    )
        .into_response())
}
