use aws_lc_rs::signature::{
    ECDSA_P256_SHA256_FIXED, RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents, UnparsedPublicKey,
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

use super::{Alg, JoseError, Jwk, JwkSet, SigningKey};

const MAX_TOKEN_BYTES: usize = 16 * 1024;
const P256_COORD_BYTES: usize = 32;

#[derive(Serialize)]
struct SignedHeader<'a> {
    alg: &'a str,
    kid: &'a str,
    typ: &'a str,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    #[serde(default)]
    kid: Option<String>,
    #[serde(default)]
    typ: Option<String>,
    #[serde(default)]
    crit: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub alg: Alg,
    pub kid: Option<String>,
    pub typ: Option<String>,
    pub payload: Vec<u8>,
}

pub fn sign_compact(key: &SigningKey, typ: &str, payload: &[u8]) -> Result<String, JoseError> {
    let header = SignedHeader {
        alg: key.alg().name(),
        kid: key.kid(),
        typ,
    };
    let header = serde_json::to_vec(&header).map_err(|_| JoseError::Sign)?;
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header),
        URL_SAFE_NO_PAD.encode(payload)
    );
    let signature = key.sign(input.as_bytes())?;
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

struct Parsed<'a> {
    header: Header,
    input: &'a str,
    payload: Vec<u8>,
    signature: Vec<u8>,
}

fn parse(token: &str) -> Result<Parsed<'_>, JoseError> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err(JoseError::Token);
    }
    let (input, signature) = token.rsplit_once('.').ok_or(JoseError::Token)?;
    let (header, payload) = input.split_once('.').ok_or(JoseError::Token)?;
    if payload.contains('.') {
        return Err(JoseError::Token);
    }
    let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).map_err(|_| JoseError::Token);
    let header: Header = serde_json::from_slice(&decode(header)?).map_err(|_| JoseError::Token)?;
    if header.crit.is_some() {
        return Err(JoseError::Token);
    }
    Ok(Parsed {
        header,
        input,
        payload: decode(payload)?,
        signature: decode(signature)?,
    })
}

fn coordinate(text: Option<&String>) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text?).ok()
}

fn signature_ok(jwk: &Jwk, alg: Alg, message: &[u8], signature: &[u8]) -> bool {
    match alg {
        Alg::Rs256 => match (coordinate(jwk.n.as_ref()), coordinate(jwk.e.as_ref())) {
            (Some(n), Some(e)) => RsaPublicKeyComponents { n, e }
                .verify(&RSA_PKCS1_2048_8192_SHA256, message, signature)
                .is_ok(),
            (_, _) => false,
        },
        Alg::Es256 => match (coordinate(jwk.x.as_ref()), coordinate(jwk.y.as_ref())) {
            (Some(x), Some(y)) if x.len() == P256_COORD_BYTES && y.len() == P256_COORD_BYTES => {
                let point = [&[4u8][..], &x, &y].concat();
                UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, point)
                    .verify(message, signature)
                    .is_ok()
            }
            (_, _) => false,
        },
    }
}

fn verify_parsed(jwk: &Jwk, parsed: Parsed<'_>) -> Result<Verified, JoseError> {
    let Parsed {
        header,
        input,
        payload,
        signature,
    } = parsed;
    let alg = Alg::parse(&header.alg)
        .filter(|alg| jwk.signing_alg() == Some(*alg))
        .ok_or(JoseError::Alg)?;
    match signature_ok(jwk, alg, input.as_bytes(), &signature) {
        true => Ok(Verified {
            alg,
            kid: header.kid,
            typ: header.typ,
            payload,
        }),
        false => Err(JoseError::Signature),
    }
}

pub fn verify_with(jwk: &Jwk, token: &str) -> Result<Verified, JoseError> {
    verify_parsed(jwk, parse(token)?)
}

pub fn verify_compact(keys: &JwkSet, token: &str, typ: &str) -> Result<Verified, JoseError> {
    let parsed = parse(token)?;
    let jwk = parsed
        .header
        .kid
        .as_deref()
        .and_then(|kid| keys.find(kid))
        .ok_or(JoseError::UnknownKey)?;
    let verified = verify_parsed(jwk, parsed)?;
    match verified.typ.as_deref() == Some(typ) {
        true => Ok(verified),
        false => Err(JoseError::Type),
    }
}
