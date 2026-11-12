use std::fmt;

use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der};
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::rsa::{KeyPair as RsaKeyPair, KeySize};
use aws_lc_rs::signature::{
    ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair, RSA_PKCS1_SHA256,
};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use super::{Alg, JoseError, Jwk};

const PEM_BEGIN: &str = "-----BEGIN PRIVATE KEY-----";
const PEM_END: &str = "-----END PRIVATE KEY-----";
const PEM_MAX_BYTES: usize = 16 * 1024;
const P256_POINT_BYTES: usize = 65;

const DER_SEQUENCE: u8 = 0x30;
const DER_INTEGER: u8 = 0x02;

fn der_item(input: &[u8], tag: u8) -> Option<(&[u8], &[u8])> {
    let rest = input.strip_prefix(&[tag][..])?;
    let (&first, rest) = rest.split_first()?;
    let (len, rest) = match first {
        0..=0x7f => (usize::from(first), rest),
        0x81 | 0x82 => {
            let (bytes, rest) = rest.split_at_checked(usize::from(first & 0x7f))?;
            (bytes.iter().fold(0, |n, b| n << 8 | usize::from(*b)), rest)
        }
        _ => return None,
    };
    rest.split_at_checked(len)
}

// RFC 8017's RSAPublicKey: a SEQUENCE of the modulus and the exponent.
fn rsa_public_parts(der: &[u8]) -> Option<(&[u8], &[u8])> {
    let (body, _) = der_item(der, DER_SEQUENCE)?;
    let (n, rest) = der_item(body, DER_INTEGER)?;
    let (e, _) = der_item(rest, DER_INTEGER)?;
    Some((unsigned(n), unsigned(e)))
}

fn unsigned(value: &[u8]) -> &[u8] {
    let zeros = value.iter().take_while(|b| **b == 0).count();
    value.get(zeros..).unwrap_or(&[])
}

enum Pair {
    Rsa(RsaKeyPair),
    Ec(EcdsaKeyPair),
}

pub struct SigningKey {
    pair: Pair,
    jwk: Jwk,
    kid: String,
}

#[derive(Clone)]
pub struct Pkcs8(Vec<u8>);

impl Pkcs8 {
    pub fn bytes(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for Pkcs8 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Pkcs8(..)")
    }
}

impl fmt::Debug for SigningKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SigningKey")
            .field("alg", &self.alg())
            .field("kid", &self.kid)
            .finish()
    }
}

impl SigningKey {
    fn new(pair: Pair) -> Result<SigningKey, JoseError> {
        let (alg, shape) = match &pair {
            Pair::Rsa(rsa) => {
                let (n, e) = rsa_public_parts(rsa.public_key().as_ref()).ok_or(JoseError::Key)?;
                (Alg::Rs256, Jwk::rsa(n, e))
            }
            Pair::Ec(ec) => {
                let point = ec.public_key().as_ref();
                let (x, y) = match (
                    point.len(),
                    point.first(),
                    point.get(1..33),
                    point.get(33..),
                ) {
                    (P256_POINT_BYTES, Some(4), Some(x), Some(y)) => (x, y),
                    (_, _, _, _) => return Err(JoseError::Key),
                };
                (Alg::Es256, Jwk::p256(x, y))
            }
        };
        let jwk = shape.published(alg);
        let kid = jwk.kid.clone().ok_or(JoseError::Key)?;
        Ok(SigningKey { pair, jwk, kid })
    }

    pub fn generate(alg: Alg) -> Result<SigningKey, JoseError> {
        let pair = match alg {
            Alg::Rs256 => RsaKeyPair::generate(KeySize::Rsa2048).map(Pair::Rsa),
            Alg::Es256 => EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).map(Pair::Ec),
        };
        SigningKey::new(pair.map_err(|_| JoseError::Key)?)
    }

    pub fn from_pkcs8(der: &[u8]) -> Result<SigningKey, JoseError> {
        let rsa = RsaKeyPair::from_pkcs8(der).map(Pair::Rsa);
        let pair = rsa.or_else(|_| {
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, der).map(Pair::Ec)
        });
        SigningKey::new(pair.map_err(|_| JoseError::Key)?)
    }

    pub fn from_pkcs8_pem(pem: &str) -> Result<SigningKey, JoseError> {
        if pem.len() > PEM_MAX_BYTES {
            return Err(JoseError::Key);
        }
        let body = pem
            .trim()
            .strip_prefix(PEM_BEGIN)
            .and_then(|rest| rest.strip_suffix(PEM_END))
            .ok_or(JoseError::Key)?;
        let packed: String = body.chars().filter(|c| !c.is_ascii_whitespace()).collect();
        let der = STANDARD.decode(packed).map_err(|_| JoseError::Key)?;
        SigningKey::from_pkcs8(&der)
    }

    pub fn to_pkcs8(&self) -> Result<Pkcs8, JoseError> {
        let der = match &self.pair {
            Pair::Rsa(rsa) => {
                let der: Result<Pkcs8V1Der, _> = rsa.as_der();
                der.map(|d| d.as_ref().to_vec())
            }
            Pair::Ec(ec) => ec.to_pkcs8v1().map(|d| d.as_ref().to_vec()),
        };
        der.map(Pkcs8).map_err(|_| JoseError::Key)
    }

    pub fn alg(&self) -> Alg {
        match self.pair {
            Pair::Rsa(_) => Alg::Rs256,
            Pair::Ec(_) => Alg::Es256,
        }
    }

    pub fn kid(&self) -> &str {
        &self.kid
    }

    pub fn public_jwk(&self) -> &Jwk {
        &self.jwk
    }

    pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>, JoseError> {
        let rng = SystemRandom::new();
        match &self.pair {
            Pair::Rsa(rsa) => {
                let mut signature = vec![0u8; rsa.public_modulus_len()];
                rsa.sign(&RSA_PKCS1_SHA256, &rng, message, &mut signature)
                    .map(|()| signature)
            }
            Pair::Ec(ec) => ec.sign(&rng, message).map(|s| s.as_ref().to_vec()),
        }
        .map_err(|_| JoseError::Sign)
    }
}
