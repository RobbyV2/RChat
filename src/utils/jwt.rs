use chrono::{Duration, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};

use crate::utils::error::{AppError, AppResult};

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: i64,
    pub iat: i64,
    pub username: String,
}

pub struct JwtService {
    encoding_key: EncodingKey,
    decoding_key: DecodingKey,
}

impl JwtService {
    pub fn new(secret: &str) -> Self {
        Self {
            encoding_key: EncodingKey::from_secret(secret.as_bytes()),
            decoding_key: DecodingKey::from_secret(secret.as_bytes()),
        }
    }

    pub fn from_env() -> AppResult<Self> {
        let secret = std::env::var("SECRET_KEY")
            .map_err(|_| AppError::Internal("SECRET_KEY not set".to_string()))?;
        Ok(Self::new(&secret))
    }

    pub fn generate_token(&self, username: &str) -> AppResult<String> {
        let now = Utc::now();
        let expiration = now + Duration::days(36500);

        let claims = Claims {
            sub: username.to_string(),
            exp: expiration.timestamp(),
            iat: now.timestamp(),
            username: username.to_string(),
        };

        encode(&Header::default(), &claims, &self.encoding_key)
            .map_err(|e| AppError::Internal(format!("Failed to generate token: {}", e)))
    }

    pub fn verify_token(&self, token: &str) -> AppResult<Claims> {
        let validation = Validation::new(Algorithm::HS256);
        decode::<Claims>(token, &self.decoding_key, &validation)
            .map(|data| data.claims)
            .map_err(|e| AppError::Auth(format!("Invalid token: {}", e)))
    }

    pub fn extract_username(&self, token: &str) -> AppResult<String> {
        let claims = self.verify_token(token)?;
        Ok(claims.username)
    }
}
