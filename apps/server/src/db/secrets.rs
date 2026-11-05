use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use sha2::{Digest, Sha256};
use sqlx::Row;

use super::pool::{Db, pool_key};

pub(super) static PEPPERS: LazyLock<Mutex<HashMap<String, Vec<u8>>>> =
    LazyLock::new(Default::default);

/// A secret from the environment: `NAME`, or the contents of the file named by `NAME_FILE`.
/// Blank values count as unset.
pub fn env_secret(name: &str) -> Option<String> {
    let direct = std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let file = std::env::var(format!("{name}_FILE"))
        .ok()
        .filter(|p| !p.trim().is_empty())
        .and_then(|p| match std::fs::read_to_string(p.trim()) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::error!("{name}_FILE can not be read: {e}");
                None
            }
        });
    direct
        .or(file)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The pepper of server password lookups: `PASSWORD_PEPPER` when it is set, else the value
/// stored in the database at first start.
pub async fn pepper(db: &Db) -> sqlx::Result<Vec<u8>> {
    let key = pool_key(db);
    if let Some(pepper) = PEPPERS.lock().ok().and_then(|m| m.get(&key).cloned()) {
        return Ok(pepper);
    }
    let value: String = match env_secret("PASSWORD_PEPPER") {
        Some(value) => value,
        None => sqlx::query("SELECT value FROM settings WHERE key = 'password_pepper'")
            .fetch_one(db)
            .await?
            .try_get(0)?,
    };
    let pepper = value.into_bytes();
    if let Ok(mut peppers) = PEPPERS.lock() {
        peppers.insert(key, pepper.clone());
    }
    Ok(pepper)
}

/// Stored form of a bearer secret (session token or guest grant): `h:` and the hex SHA-256.
/// The database never holds the secret itself.
pub fn secret_key(raw: &str) -> String {
    format!("h:{}", hex::encode(Sha256::digest(raw.as_bytes())))
}
