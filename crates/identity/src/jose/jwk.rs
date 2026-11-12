use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{Alg, SigningKey};

const P256: &str = "P-256";
const SIG: &str = "sig";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Jwk {
    #[serde(default)]
    pub kty: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub e: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alg: Option<String>,
    #[serde(rename = "use", default, skip_serializing_if = "Option::is_none")]
    pub key_use: Option<String>,
}

fn quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

impl Jwk {
    pub fn rsa(n: &[u8], e: &[u8]) -> Jwk {
        Jwk {
            kty: "RSA".to_string(),
            n: Some(URL_SAFE_NO_PAD.encode(n)),
            e: Some(URL_SAFE_NO_PAD.encode(e)),
            ..Jwk::default()
        }
    }

    pub fn p256(x: &[u8], y: &[u8]) -> Jwk {
        Jwk {
            kty: "EC".to_string(),
            crv: Some(P256.to_string()),
            x: Some(URL_SAFE_NO_PAD.encode(x)),
            y: Some(URL_SAFE_NO_PAD.encode(y)),
            ..Jwk::default()
        }
    }

    pub(super) fn published(self, alg: Alg) -> Jwk {
        Jwk {
            kid: self.thumbprint(),
            alg: Some(alg.name().to_string()),
            key_use: Some(SIG.to_string()),
            ..self
        }
    }

    pub fn thumbprint(&self) -> Option<String> {
        let Jwk {
            kty,
            crv,
            x,
            y,
            n,
            e,
            kid: _,
            alg: _,
            key_use: _,
        } = self;
        let canonical = match (kty.as_str(), crv, x, y, n, e) {
            ("RSA", _, _, _, Some(n), Some(e)) => {
                format!(r#"{{"e":{},"kty":"RSA","n":{}}}"#, quoted(e), quoted(n))
            }
            ("EC", Some(crv), Some(x), Some(y), _, _) => format!(
                r#"{{"crv":{},"kty":"EC","x":{},"y":{}}}"#,
                quoted(crv),
                quoted(x),
                quoted(y)
            ),
            (_, _, _, _, _, _) => return None,
        };
        Some(URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes())))
    }

    pub fn signing_alg(&self) -> Option<Alg> {
        let by_shape = match (self.kty.as_str(), self.crv.as_deref()) {
            ("RSA", _) => Alg::Rs256,
            ("EC", Some(P256)) => Alg::Es256,
            (_, _) => return None,
        };
        let named = self.alg.as_deref().is_none_or(|a| a == by_shape.name());
        let for_signing = self.key_use.as_deref().is_none_or(|u| u == SIG);
        (named && for_signing).then_some(by_shape)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct JwkSet {
    pub keys: Vec<Jwk>,
}

impl JwkSet {
    pub fn of(keys: &[&SigningKey]) -> JwkSet {
        JwkSet {
            keys: keys.iter().map(|k| k.public_jwk().clone()).collect(),
        }
    }

    pub fn find(&self, kid: &str) -> Option<&Jwk> {
        let mut found = self.keys.iter().filter(|k| k.kid.as_deref() == Some(kid));
        match (found.next(), found.next()) {
            (Some(key), None) => Some(key),
            (_, _) => None,
        }
    }
}
