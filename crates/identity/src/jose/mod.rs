use std::fmt;

mod jwk;
mod jws;
mod keys;
mod tokens;

pub use jwk::{Jwk, JwkSet};
pub use jws::{Verified, sign_compact, verify_compact, verify_with};
pub use keys::{Pkcs8, SigningKey};
pub use tokens::{
    ASSERTION_SECS, BACKCHANNEL_EVENT, ID_TOKEN_SECS, IdToken, LOGOUT_TOKEN_SECS, LogoutToken,
    Profile, ProxyAssertion, ServerClaim, TYP_JWT, TYP_LOGOUT, TYP_PROXY, at_hash, id_token,
    id_token_claims, logout_claims, logout_sids, logout_token, proxy_assertion,
    proxy_assertion_claims,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alg {
    Rs256,
    Es256,
}

impl Alg {
    pub fn name(self) -> &'static str {
        match self {
            Alg::Rs256 => "RS256",
            Alg::Es256 => "ES256",
        }
    }

    pub fn parse(name: &str) -> Option<Alg> {
        match name {
            "RS256" => Some(Alg::Rs256),
            "ES256" => Some(Alg::Es256),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoseError {
    Key,
    Sign,
    Token,
    Alg,
    UnknownKey,
    Signature,
    Type,
}

impl JoseError {
    pub fn text(self) -> &'static str {
        match self {
            JoseError::Key => "Not a usable signing key",
            JoseError::Sign => "Signing failed",
            JoseError::Token => "Not a signed token",
            JoseError::Alg => "The token's algorithm does not fit the key",
            JoseError::UnknownKey => "No key with that id",
            JoseError::Signature => "The signature does not match",
            JoseError::Type => "The token is not of the expected type",
        }
    }
}

impl fmt::Display for JoseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.text())
    }
}

impl std::error::Error for JoseError {}
