//! The secrets the instance keeps in its database, sealed under the `secrets` data key.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sqlx::{AnyConnection, Row};
use zeroize::Zeroizing;

use super::ring::{RESET_SETTING, Ring, SecretsReset};
use super::{Key, Purpose, header, open, row_aad, seal};
use crate::db::Db;

pub const SIGNING_KEY: &str = "instance_signing_key";
pub const PEPPER: &str = "password_pepper";
pub const RELAY_SECRET: &str = "relay_secret";
pub const P2P_SECRET: &str = "p2p_secret";
/// The `settings` rows that hold a secret. Each is stored sealed under `<key>.sealed`.
pub const SETTINGS: [&str; 4] = [SIGNING_KEY, PEPPER, RELAY_SECRET, P2P_SECRET];
const SETTINGS_TABLE: &str = "settings";
const SETTINGS_COLUMN: &str = "value";
/// The table and column of the outgoing webhook secrets, sealed into `secret_sealed`.
pub const HOOK_TABLE: &str = "outgoing_webhooks";
pub const HOOK_COLUMN: &str = "secret";
const HOOK_BATCH: i64 = 500;

pub fn sealed_name(key: &str) -> String {
    format!("{key}.sealed")
}

/// Which stored secrets the env replaces, so a start does not need them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Supplied {
    pub pepper: bool,
    pub signing_key: bool,
}

fn fresh(key: &str) -> String {
    match key {
        SIGNING_KEY => crate::identity::new_seed(),
        _ => crate::api::auth::new_token(),
    }
}

fn opened(
    key: &Key,
    id: u32,
    table: &str,
    column: &str,
    binding: &str,
    record: &[u8],
) -> anyhow::Result<Zeroizing<String>> {
    let plain = Zeroizing::new(open(key, &row_aad(table, column, binding, id), record)?);
    Ok(Zeroizing::new(std::str::from_utf8(&plain)?.to_owned()))
}

/// Seals new secrets under the active `secrets` data key. Taken before a transaction begins,
/// it seals inside it without asking the database for the key.
pub struct Sealer(Option<(u32, Key)>);

impl Sealer {
    pub async fn of(db: &Db) -> anyhow::Result<Sealer> {
        let ring = crate::db::ring(db);
        Ok(Sealer(ring.data_key(db, Purpose::Secrets).await?))
    }

    /// Whether a key seals secrets here.
    pub fn seals(&self) -> bool {
        let Sealer(held) = self;
        held.is_some()
    }

    /// The record of `plain` bound to its row, or `None` when no key seals secrets and the
    /// caller stores it plain.
    pub fn seal(&self, table: &str, column: &str, binding: &str, plain: &str) -> Option<Vec<u8>> {
        let Sealer(held) = self;
        let (id, key) = held.as_ref()?;
        Some(seal(
            *id,
            key,
            &row_aad(table, column, binding, *id),
            plain.as_bytes(),
        ))
    }
}

/// The secret of a row: its plain column when that holds one, else its sealed record opened.
/// A row stored sealed keeps its plain column empty, so a plain value is the newer one.
pub async fn open_or(
    db: &Db,
    table: &str,
    column: &str,
    binding: &str,
    sealed: Option<Vec<u8>>,
    plain: String,
) -> anyhow::Result<Zeroizing<String>> {
    let record = match (sealed, plain.is_empty()) {
        (Some(record), true) => record,
        (Some(_), false) | (None, _) => return Ok(Zeroizing::new(plain)),
    };
    let id = header(&record)?.key_id;
    let held = crate::db::ring(db).key_by_id(db, id).await?;
    opened_under(held, id, table, column, binding, &record)
}

/// `open_or` on one connection with the key ring of its database, for a caller inside a
/// transaction.
pub async fn open_or_on(
    ring: &Ring,
    conn: &mut AnyConnection,
    table: &str,
    column: &str,
    binding: &str,
    sealed: Option<Vec<u8>>,
    plain: String,
) -> anyhow::Result<Zeroizing<String>> {
    let record = match (sealed, plain.is_empty()) {
        (Some(record), true) => record,
        (Some(_), false) | (None, _) => return Ok(Zeroizing::new(plain)),
    };
    let id = header(&record)?.key_id;
    let held = ring.key_by_id_on(conn, id).await?;
    opened_under(held, id, table, column, binding, &record)
}

fn opened_under(
    held: Option<(Purpose, Key)>,
    id: u32,
    table: &str,
    column: &str,
    binding: &str,
    record: &[u8],
) -> anyhow::Result<Zeroizing<String>> {
    match held {
        Some((Purpose::Secrets, key)) => opened(&key, id, table, column, binding, record),
        Some(_) | None => anyhow::bail!("the data key {id} of {table}.{column} is not held"),
    }
}

async fn stored(conn: &mut AnyConnection, key: &str) -> sqlx::Result<Option<String>> {
    sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(&mut *conn)
        .await?
        .map(|r| r.try_get(0))
        .transpose()
}

async fn store(conn: &mut AnyConnection, key: &str, value: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

async fn store_sealed(
    conn: &mut AnyConnection,
    key: &str,
    (id, dek): &(u32, Key),
    plain: &str,
) -> sqlx::Result<()> {
    let aad = row_aad(SETTINGS_TABLE, SETTINGS_COLUMN, key, *id);
    let record = URL_SAFE_NO_PAD.encode(seal(*id, dek, &aad, plain.as_bytes()));
    store(conn, &sealed_name(key), &record).await?;
    sqlx::query("DELETE FROM settings WHERE key = $1")
        .bind(key)
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

async fn open_setting(
    ring: &Ring,
    conn: &mut AnyConnection,
    key: &str,
    record: &str,
) -> anyhow::Result<Zeroizing<String>> {
    let record = URL_SAFE_NO_PAD.decode(record.trim())?;
    let id = header(&record)?.key_id;
    match ring.key_by_id_on(conn, id).await? {
        Some((Purpose::Secrets, dek)) => {
            opened(&dek, id, SETTINGS_TABLE, SETTINGS_COLUMN, key, &record)
        }
        Some(_) | None => anyhow::bail!("the data key {id} is not held"),
    }
}

/// Seals the outgoing webhook secrets stored plain, a batch at a time, over any older sealed
/// record of the same row. A row is written only while it still holds the secret that was read.
async fn seal_hook_secrets(conn: &mut AnyConnection, (id, dek): &(u32, Key)) -> sqlx::Result<()> {
    let (mut after, mut sealed) = (0_i64, 0);
    loop {
        let rows: Vec<(i64, String)> = sqlx::query_as("SELECT id, secret FROM outgoing_webhooks WHERE secret <> '' AND id > $1 ORDER BY id LIMIT $2")
            .bind(after)
            .bind(HOOK_BATCH)
            .fetch_all(&mut *conn)
            .await?;
        let Some((last, _)) = rows.last() else {
            break;
        };
        after = *last;
        for (hook, secret) in rows {
            let secret = Zeroizing::new(secret);
            let aad = row_aad(HOOK_TABLE, HOOK_COLUMN, &hook.to_string(), *id);
            sealed += sqlx::query("UPDATE outgoing_webhooks SET secret = '', secret_sealed = $1 WHERE id = $2 AND secret = $3")
                .bind(seal(*id, dek, &aad, secret.as_bytes()))
                .bind(hook)
                .bind(secret.as_str())
                .execute(&mut *conn)
                .await?
                .rows_affected();
        }
    }
    if sealed > 0 {
        tracing::info!("sealed the stored secrets of {sealed} outgoing webhooks");
    }
    Ok(())
}

/// One of the `SETTINGS` secrets: its sealed row opened, else its plain row.
pub async fn secret_setting(db: &Db, key: &str) -> anyhow::Result<Zeroizing<String>> {
    let mut conn = db.acquire().await?;
    let rows = sqlx::query("SELECT key, value FROM settings WHERE key = $1 OR key = $2")
        .bind(key)
        .bind(sealed_name(key))
        .fetch_all(&mut *conn)
        .await?;
    let (mut sealed, mut plain) = (None, None);
    for row in rows {
        let (name, value): (String, String) = (row.try_get(0)?, row.try_get(1)?);
        match name == key {
            true => plain = Some(value),
            false => sealed = Some(value),
        }
    }
    match (sealed, plain) {
        (Some(record), _) => open_setting(&crate::db::ring(db), &mut conn, key, &record)
            .await
            .map_err(|e| {
                anyhow::anyhow!("the stored {key} is encrypted and cannot be opened: {e}")
            }),
        (None, Some(plain)) => Ok(Zeroizing::new(plain)),
        (None, None) => anyhow::bail!("settings.{key} is missing"),
    }
}

/// Brings the stored secrets in line at a start. A tool that opens the database without keys
/// (`ring` is `None`) only makes the ones a new database lacks. A server start checks the data
/// keys, then seals every plain secret and removes its plain row, makes missing ones sealed,
/// and seals the outgoing webhook secrets still stored plain. A sealed secret is never made
/// again while its record opens.
///
/// A sealed pepper or signing key that cannot be opened refuses the start unless the env
/// supplies that secret. A sealed relay or P2P secret that cannot be opened refuses it too,
/// unless `ENCRYPTION_ALLOW_LOST=on`: then a new one is made, and which ones and when is
/// recorded under `RESET_SETTING`.
pub async fn settle(
    conn: &mut AnyConnection,
    ring: Option<&Ring>,
    supplied: Supplied,
) -> anyhow::Result<()> {
    let Some(ring) = ring else {
        for key in SETTINGS {
            if stored(conn, &sealed_name(key)).await?.is_none() {
                sqlx::query(
                    "INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING",
                )
                .bind(key)
                .bind(fresh(key))
                .execute(&mut *conn)
                .await?;
            }
        }
        return Ok(());
    };
    ring.check_on(conn).await?;
    let dek = match ring.data_key_on(conn, Purpose::Secrets).await {
        Ok(dek) => dek,
        Err(_) if ring.allow_lost() => ring.renew_on(conn, Purpose::Secrets).await?,
        Err(e) => return Err(e),
    };
    let mut reset = Vec::new();
    for key in SETTINGS {
        let sealed = stored(conn, &sealed_name(key)).await?;
        let plain = stored(conn, key).await?.map(Zeroizing::new);
        let lost = match &sealed {
            Some(record) => open_setting(ring, conn, key, record).await.err(),
            None => None,
        };
        let replaced = match key {
            PEPPER => supplied.pepper,
            SIGNING_KEY => supplied.signing_key,
            _ => false,
        };
        match (sealed, lost, plain, &dek) {
            (Some(_), None, None, _) => {}
            (Some(_), None, Some(_), _) => {
                sqlx::query("DELETE FROM settings WHERE key = $1")
                    .bind(key)
                    .execute(&mut *conn)
                    .await?;
            }
            (Some(_), Some(e), _, _) => match key {
                PEPPER | SIGNING_KEY if replaced => {
                    tracing::error!("the stored {key} is encrypted and cannot be opened: {e}");
                }
                PEPPER | SIGNING_KEY => anyhow::bail!(
                    "the stored {key} is encrypted and cannot be opened: {e}. Restore the encryption key. ENCRYPTION_ALLOW_LOST does not cover it"
                ),
                _ => match (ring.allow_lost(), &dek) {
                    (true, Some(dek)) => {
                        tracing::error!(
                            "the stored {key} is encrypted and cannot be opened: {e}. Made a new one"
                        );
                        store_sealed(conn, key, dek, &fresh(key)).await?;
                        reset.push(key.to_owned());
                    }
                    (true, None) | (false, _) => anyhow::bail!(
                        "the stored {key} is encrypted and cannot be opened: {e}. Restore the encryption key, or set ENCRYPTION_ALLOW_LOST=on to make a new one"
                    ),
                },
            },
            (None, _, Some(plain), Some(dek)) => store_sealed(conn, key, dek, &plain).await?,
            (None, _, Some(_), None) => {}
            (None, _, None, Some(dek)) => store_sealed(conn, key, dek, &fresh(key)).await?,
            (None, _, None, None) => store(conn, key, &fresh(key)).await?,
        }
    }
    if !reset.is_empty() {
        let reset = SecretsReset {
            at: crate::db::now(),
            secrets: reset,
        };
        store(conn, RESET_SETTING, &serde_json::to_string(&reset)?).await?;
    }
    if let Some(dek) = &dek {
        seal_hook_secrets(conn, dek).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
