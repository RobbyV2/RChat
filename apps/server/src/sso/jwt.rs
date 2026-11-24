use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde_json::{Map, Value};
use std::fmt;

pub const SKEW_SECS: i64 = 60;
pub const LOGOUT_EVENT: &str = "http://schemas.openid.net/event/backchannel-logout";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SsoError {
    Unavailable,
    Invalid(&'static str),
}

impl fmt::Display for SsoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => f.write_str("provider unavailable"),
            Self::Invalid(reason) => f.write_str(reason),
        }
    }
}
impl std::error::Error for SsoError {}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Alg {
    Rs256,
    Es256,
    EdDsa,
}

impl From<Alg> for Algorithm {
    fn from(value: Alg) -> Self {
        match value {
            Alg::Rs256 => Self::RS256,
            Alg::Es256 => Self::ES256,
            Alg::EdDsa => Self::EdDSA,
        }
    }
}

pub fn header(token: &str) -> Result<(Alg, Option<String>), SsoError> {
    let h = decode_header(token).map_err(|_| SsoError::Invalid("invalid token header"))?;
    if h.crit.is_some() {
        return Err(SsoError::Invalid("unsupported critical headers"));
    }
    let alg = match h.alg {
        Algorithm::RS256 => Alg::Rs256,
        Algorithm::ES256 => Alg::Es256,
        Algorithm::EdDSA => Alg::EdDsa,
        _ => return Err(SsoError::Invalid("unsupported signing algorithm")),
    };
    Ok((alg, h.kid))
}

pub struct Expect<'a> {
    pub issuer: &'a str,
    pub client_id: &'a str,
    pub nonce: &'a str,
    pub now: i64,
}
pub struct IdClaims {
    pub sub: String,
    pub auth_time: Option<i64>,
    pub sid: Option<String>,
    pub claims: Map<String, Value>,
}
pub struct LogoutClaims {
    pub sub: Option<String>,
    pub sid: Option<String>,
}

type Claims = Map<String, Value>;
fn string<'a>(claims: &'a Claims, name: &'static str) -> Result<Option<&'a str>, SsoError> {
    claims
        .get(name)
        .map(|v| {
            v.as_str()
                .filter(|s| !s.is_empty())
                .ok_or(SsoError::Invalid(name))
        })
        .transpose()
}
fn date(claims: &Claims, name: &'static str) -> Result<Option<i64>, SsoError> {
    claims
        .get(name)
        .map(|v| v.as_i64().ok_or(SsoError::Invalid(name)))
        .transpose()
}

fn verified(
    token: &str,
    key: &DecodingKey,
    alg: Alg,
    issuer: &str,
    client: &str,
    now: i64,
) -> Result<Claims, SsoError> {
    let mut validation = Validation::new(alg.into());
    // Check dates against the caller's clock and validate both audience forms below.
    validation.validate_exp = false;
    validation.validate_aud = false;
    let data = decode::<Claims>(token, key, &validation)
        .map_err(|_| SsoError::Invalid("invalid signed token"))?;
    if data.header.crit.is_some() {
        return Err(SsoError::Invalid("unsupported critical headers"));
    }
    let claims = data.claims;
    if string(&claims, "iss")? != Some(issuer) {
        return Err(SsoError::Invalid("issuer mismatch"));
    }
    let multi = match claims.get("aud") {
        Some(Value::String(aud)) if aud == client => false,
        Some(Value::Array(aud))
            if !aud.is_empty() && aud.iter().all(|v| v.as_str() == Some(client)) =>
        {
            aud.len() > 1
        }
        _ => return Err(SsoError::Invalid("audience mismatch")),
    };
    let azp = string(&claims, "azp")?;
    if (multi || azp.is_some()) && azp != Some(client) {
        return Err(SsoError::Invalid("authorized party mismatch"));
    }
    let latest = now.saturating_add(SKEW_SECS);
    if date(&claims, "iat")?.is_none_or(|iat| iat > latest)
        || date(&claims, "nbf")?.is_some_and(|nbf| nbf > latest)
    {
        return Err(SsoError::Invalid("token not yet valid"));
    }
    if date(&claims, "exp")?.is_none_or(|exp| exp <= now.saturating_sub(SKEW_SECS)) {
        return Err(SsoError::Invalid("token expired"));
    }
    Ok(claims)
}

pub fn verify_id_token(
    token: &str,
    key: &DecodingKey,
    alg: Alg,
    expect: &Expect<'_>,
) -> Result<IdClaims, SsoError> {
    let claims = verified(token, key, alg, expect.issuer, expect.client_id, expect.now)?;
    if string(&claims, "nonce")? != Some(expect.nonce) {
        return Err(SsoError::Invalid("nonce mismatch"));
    }
    let auth_time = date(&claims, "auth_time")?;
    if auth_time.is_some_and(|t| t > expect.now.saturating_add(SKEW_SECS)) {
        return Err(SsoError::Invalid("future authentication time"));
    }
    Ok(IdClaims {
        sub: string(&claims, "sub")?
            .ok_or(SsoError::Invalid("missing subject"))?
            .to_owned(),
        sid: string(&claims, "sid")?.map(str::to_owned),
        auth_time,
        claims,
    })
}

pub fn verify_logout_token(
    token: &str,
    key: &DecodingKey,
    alg: Alg,
    issuer: &str,
    client_id: &str,
    now: i64,
) -> Result<LogoutClaims, SsoError> {
    let claims = verified(token, key, alg, issuer, client_id, now)?;
    if claims.contains_key("nonce")
        || string(&claims, "jti")?.is_none()
        || !claims
            .get("events")
            .and_then(|v| v.get(LOGOUT_EVENT))
            .is_some_and(Value::is_object)
    {
        return Err(SsoError::Invalid("invalid logout claims"));
    }
    let sub = string(&claims, "sub")?.map(str::to_owned);
    let sid = string(&claims, "sid")?.map(str::to_owned);
    if sub.is_none() && sid.is_none() {
        return Err(SsoError::Invalid("missing logout subject or session"));
    }
    Ok(LogoutClaims { sub, sid })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sso::{Sso, fake_idp::FakeIdp, provider::Provider};
    use serde_json::json;

    const NOW: i64 = 1_000_000;

    fn expect(idp: &FakeIdp) -> Expect<'_> {
        Expect {
            issuer: &idp.issuer,
            client_id: &idp.client_id,
            nonce: "fixture-nonce",
            now: NOW,
        }
    }
    fn claims(idp: &FakeIdp) -> Value {
        json!({"iss":idp.issuer,"aud":idp.client_id,"sub":"subject","sid":"session","auth_time":NOW,"iat":NOW,"exp":NOW+300,"nonce":"fixture-nonce"})
    }

    async fn key(idp: &FakeIdp, claims: &Value) -> (Alg, DecodingKey) {
        let (alg, kid) = header(&idp.sign(claims.clone())).unwrap();
        let provider = Provider::new(idp.provider_config("test"));
        (
            alg,
            provider
                .key(Sso::off().http(), alg, kid.as_deref())
                .await
                .unwrap(),
        )
    }

    #[tokio::test]
    async fn id_tokens_pass_with_each_allowed_alg() {
        for alg in [Alg::Rs256, Alg::Es256, Alg::EdDsa] {
            let idp = FakeIdp::start(alg).await;
            let claims = claims(&idp);
            let (observed, key) = key(&idp, &claims).await;
            assert_eq!(observed, alg);
            let token = idp.sign(claims.clone());
            let verified = verify_id_token(&token, &key, alg, &expect(&idp)).unwrap();
            assert_eq!(verified.sub, "subject");
            assert_eq!(verified.sid.as_deref(), Some("session"));
            assert_eq!(verified.auth_time, Some(NOW));
            idp.rotate_key();
            assert!(verify_id_token(&idp.sign(claims), &key, alg, &expect(&idp)).is_err());
        }
    }

    #[tokio::test]
    async fn id_tokens_fail_on_bad_claims() {
        let idp = FakeIdp::start(Alg::EdDsa).await;
        let base = claims(&idp);
        let (alg, key) = key(&idp, &base).await;
        let check = |v| verify_id_token(&idp.sign(v), &key, alg, &expect(&idp));
        for (name, value) in [
            ("iss", json!("other")),
            ("aud", json!("other")),
            ("aud", json!(["other", idp.client_id])),
            ("aud", json!([idp.client_id, 42])),
            ("azp", json!("other")),
            ("azp", Value::Null),
            ("exp", json!(NOW - 60)),
            ("iat", json!(NOW + 61)),
            ("nbf", json!(NOW + 61)),
            ("nonce", json!("other")),
            ("sub", json!("")),
            ("sid", json!(false)),
            ("auth_time", json!("text")),
        ] {
            let mut v = base.clone();
            v[name] = value;
            assert!(check(v).is_err(), "{name}");
        }
        for name in ["iss", "aud", "sub", "exp", "iat", "nonce"] {
            let mut v = base.clone();
            v.as_object_mut().unwrap().remove(name);
            assert!(check(v).is_err(), "{name}");
        }
        let mut v = base;
        v["exp"] = json!(NOW - 59);
        v["iat"] = json!(NOW + 60);
        v["aud"] = json!(["other", idp.client_id]);
        v["azp"] = json!(idp.client_id);
        assert!(check(v.clone()).is_err());
        v["aud"] = json!([idp.client_id]);
        assert!(check(v).is_ok());
    }

    #[tokio::test]
    async fn forbidden_algs_are_refused() {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        use jsonwebtoken::{EncodingKey, Header, encode};
        let idp = FakeIdp::start(Alg::Rs256).await;
        let secret = idp.provider_config("test").client_secret.unwrap();
        let hmac = encode(
            &Header::new(Algorithm::HS256),
            &claims(&idp),
            &EncodingKey::from_secret(secret.0.as_bytes()),
        )
        .unwrap();
        assert!(header(&hmac).is_err());
        for alg in ["none", "RS384"] {
            let h = URL_SAFE_NO_PAD.encode(json!({"alg":alg}).to_string());
            assert!(header(&format!("{h}.e30.")).is_err());
        }
        assert_eq!(idp.jwks_fetches(), 0);
    }

    #[tokio::test]
    async fn logout_tokens_are_checked() {
        let idp = FakeIdp::start(Alg::Es256).await;
        let mut base = claims(&idp);
        base.as_object_mut().unwrap().remove("nonce");
        base["events"] = json!({LOGOUT_EVENT:{}});
        base["jti"] = json!("logout-id");
        let (alg, key) = key(&idp, &base).await;
        let check =
            |v| verify_logout_token(&idp.sign(v), &key, alg, &idp.issuer, &idp.client_id, NOW);
        let claims = check(base.clone()).unwrap();
        assert_eq!(claims.sub.as_deref(), Some("subject"));
        assert_eq!(claims.sid.as_deref(), Some("session"));
        for (name, value) in [
            ("nonce", Value::Null),
            ("events", json!({})),
            ("events", json!({LOGOUT_EVENT:true})),
            ("aud", json!("other")),
            ("exp", json!(NOW - 61)),
            ("iat", json!(NOW + 61)),
        ] {
            let mut v = base.clone();
            v[name] = value;
            assert!(check(v).is_err(), "{name}");
        }
        for name in ["exp", "jti", "events", "iat"] {
            let mut v = base.clone();
            v.as_object_mut().unwrap().remove(name);
            assert!(check(v).is_err(), "{name}");
        }
        base.as_object_mut().unwrap().remove("sub");
        assert!(check(base.clone()).is_ok());
        base.as_object_mut().unwrap().remove("sid");
        assert!(check(base).is_err());
    }
}
