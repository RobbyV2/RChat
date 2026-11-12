use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::{Alg, JoseError, SigningKey, sign_compact};

pub const ID_TOKEN_SECS: i64 = 300;
pub const LOGOUT_TOKEN_SECS: i64 = 120;
pub const ASSERTION_SECS: i64 = 60;
pub const BACKCHANNEL_EVENT: &str = "http://schemas.openid.net/event/backchannel-logout";
pub const TYP_JWT: &str = "JWT";
pub const TYP_LOGOUT: &str = "logout+jwt";
pub const TYP_PROXY: &str = "rchat-proxy+jwt";

pub fn at_hash(alg: Alg, access_token: &str) -> String {
    let digest = match alg {
        Alg::Rs256 | Alg::Es256 => Sha256::digest(access_token.as_bytes()),
    };
    let half = digest.len() / 2;
    URL_SAFE_NO_PAD.encode(digest.get(..half).unwrap_or(&[]))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    pub preferred_username: String,
    pub name: String,
    pub picture: String,
    pub updated_at: i64,
    pub rchat_instance: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerClaim {
    pub server: String,
    pub name: String,
    pub roles: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdToken {
    pub iss: String,
    pub sub: String,
    pub aud: String,
    pub iat: i64,
    pub auth_time: i64,
    pub nonce: Option<String>,
    pub sid: String,
    pub amr: Vec<String>,
    pub acr: String,
    pub profile: Option<Profile>,
    pub groups: Option<Vec<String>>,
    pub rchat_servers: Option<Vec<ServerClaim>>,
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

pub fn id_token_claims(alg: Alg, token: &IdToken, access_token: Option<&str>) -> Value {
    let IdToken {
        iss,
        sub,
        aud,
        iat,
        auth_time,
        nonce,
        sid,
        amr,
        acr,
        profile,
        groups,
        rchat_servers,
    } = token;
    let mut claims = object(json!({
        "iss": iss,
        "sub": sub,
        "aud": aud,
        "azp": aud,
        "exp": iat.saturating_add(ID_TOKEN_SECS),
        "iat": iat,
        "auth_time": auth_time,
        "sid": sid,
        "amr": amr,
        "acr": acr,
    }));
    if let Some(nonce) = nonce {
        claims.insert("nonce".to_string(), json!(nonce));
    }
    if let Some(access_token) = access_token {
        claims.insert("at_hash".to_string(), json!(at_hash(alg, access_token)));
    }
    if let Some(Profile {
        preferred_username,
        name,
        picture,
        updated_at,
        rchat_instance,
    }) = profile
    {
        claims.extend(object(json!({
            "preferred_username": preferred_username,
            "name": name,
            "picture": picture,
            "updated_at": updated_at,
            "rchat_instance": rchat_instance,
        })));
    }
    if let Some(groups) = groups {
        claims.insert("groups".to_string(), json!(groups));
    }
    if let Some(servers) = rchat_servers {
        let servers: Vec<Value> = servers
            .iter()
            .map(
                |ServerClaim {
                     server,
                     name,
                     roles,
                 }| { json!({"server": server, "name": name, "roles": roles}) },
            )
            .collect();
        claims.insert("rchat_servers".to_string(), Value::Array(servers));
    }
    Value::Object(claims)
}

fn sign_claims(key: &SigningKey, typ: &str, claims: &Value) -> Result<String, JoseError> {
    let payload = serde_json::to_vec(claims).map_err(|_| JoseError::Sign)?;
    sign_compact(key, typ, &payload)
}

pub fn id_token(
    key: &SigningKey,
    token: &IdToken,
    access_token: Option<&str>,
) -> Result<String, JoseError> {
    sign_claims(
        key,
        TYP_JWT,
        &id_token_claims(key.alg(), token, access_token),
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogoutToken {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub sid: Option<String>,
    pub iat: i64,
    pub jti: String,
}

pub fn logout_claims(token: &LogoutToken) -> Value {
    let LogoutToken {
        iss,
        aud,
        sub,
        sid,
        iat,
        jti,
    } = token;
    let mut claims = object(json!({
        "iss": iss,
        "aud": aud,
        "iat": iat,
        "exp": iat.saturating_add(LOGOUT_TOKEN_SECS),
        "jti": jti,
        "sub": sub,
        "events": {BACKCHANNEL_EVENT: {}},
    }));
    if let Some(sid) = sid {
        claims.insert("sid".to_string(), json!(sid));
    }
    Value::Object(claims)
}

pub fn logout_token(key: &SigningKey, token: &LogoutToken) -> Result<String, JoseError> {
    sign_claims(key, TYP_LOGOUT, &logout_claims(token))
}

pub fn logout_sids<S: AsRef<str>>(sids: &[S], session_required: bool) -> Vec<Option<String>> {
    let per_session = sids.iter().map(|s| Some(s.as_ref().to_string()));
    match session_required {
        true => per_session.collect(),
        false => per_session.chain([None]).collect(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyAssertion {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub preferred_username: String,
    pub name: String,
    pub groups: Vec<String>,
    pub iat: i64,
    pub sid: String,
}

pub fn proxy_assertion_claims(assertion: &ProxyAssertion) -> Value {
    let ProxyAssertion {
        iss,
        aud,
        sub,
        preferred_username,
        name,
        groups,
        iat,
        sid,
    } = assertion;
    json!({
        "iss": iss,
        "aud": aud,
        "sub": sub,
        "preferred_username": preferred_username,
        "name": name,
        "groups": groups,
        "iat": iat,
        "exp": iat.saturating_add(ASSERTION_SECS),
        "sid": sid,
    })
}

pub fn proxy_assertion(key: &SigningKey, assertion: &ProxyAssertion) -> Result<String, JoseError> {
    sign_claims(key, TYP_PROXY, &proxy_assertion_claims(assertion))
}
