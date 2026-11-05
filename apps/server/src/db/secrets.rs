use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use sha2::{Digest, Sha256};
use sqlx::Row;

use super::pool::{Db, pool_key};

pub(super) static PEPPERS: LazyLock<Mutex<HashMap<String, Vec<u8>>>> =
    LazyLock::new(Default::default);

/// The pepper of server password lookups: `PASSWORD_PEPPER` when it is set, else the value
/// stored in the database at first start.
pub async fn pepper(db: &Db) -> sqlx::Result<Vec<u8>> {
    pepper_with(db, None).await
}

/// `pepper`, taking `configured` (`PASSWORD_PEPPER`) over the stored value when it is not
/// cached yet.
pub(super) async fn pepper_with(db: &Db, configured: Option<&str>) -> sqlx::Result<Vec<u8>> {
    let key = pool_key(db);
    if let Some(pepper) = PEPPERS.lock().ok().and_then(|m| m.get(&key).cloned()) {
        return Ok(pepper);
    }
    let value: String = match configured {
        Some(value) => value.to_string(),
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
