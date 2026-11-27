//! Where root keys come from, and the data keys they wrap.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use sqlx::{AnyConnection, Row};
use zeroize::Zeroizing;

use super::{Kek, Key, Purpose, Subkeys, decode_key, parse_keys, random_key};
use crate::db::Db;
use crate::hub::CopyNote;

/// The id a data key names when the key kept in `settings` wraps it. `parse_keys` refuses it, so
/// no root key of the operator or the key file can take it.
pub const DATABASE_KEK: &str = "db";
const ALIAS_PREFIX: &str = "acct:";
const DB_KEK_SETTING: &str = "secrets_db_kek";
const SOURCE_SETTING: &str = "keys_source";
/// The fingerprint of the key the instance wrote into the key file it made.
const MADE_SETTING: &str = "keys_file_print";
pub const BACKED_UP_SETTING: &str = "keys_backed_up_at";
const SEALED_MARK: &str = "!sealed";
/// The `SecretsReset` of the last start that made a stored secret again, as JSON.
pub const RESET_SETTING: &str = "secrets_reset";

/// Whether this build reads and writes sealed records, as its copy announcement says.
pub const SEALS: bool = true;

const ACTIVE: &str = "SELECT id, gen, kek, wrapped FROM data_keys WHERE purpose = $1 AND state = 'active' ORDER BY gen DESC LIMIT 1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `ENCRYPTION_KEYS`, or a file the operator wrote and named in `ENCRYPTION_KEYS_FILE`.
    Operator,
    /// The key file the instance made beside its database.
    File,
}

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Source::Operator => "operator",
            Source::File => "file",
        }
    }
}

/// The encryption settings of the environment.
#[derive(Clone, Default)]
pub struct KeyConfig {
    pub keys: Option<Zeroizing<String>>,
    /// Whether `keys` was read from the file `ENCRYPTION_KEYS_FILE` names.
    pub keys_from_file: bool,
    pub keys_file: Option<PathBuf>,
    pub account_secrets_key: Option<Zeroizing<String>>,
    pub allow_lost: bool,
    /// `ENCRYPTION_REQUIRED`: every server and DM stores new messages encrypted.
    pub required: bool,
    /// `SEARCH_SEALED=scan`: encrypted messages get no search grams.
    pub search_scan: bool,
}

impl std::fmt::Debug for KeyConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyConfig")
            .field("keys_file", &self.keys_file)
            .field("allow_lost", &self.allow_lost)
            .finish_non_exhaustive()
    }
}

impl KeyConfig {
    /// Reads `ENCRYPTION_KEYS`, `ENCRYPTION_KEYS_FILE`, `ACCOUNT_SECRETS_KEY`,
    /// `ENCRYPTION_ALLOW_LOST`, `ENCRYPTION_REQUIRED` and `SEARCH_SEALED`. An unreadable file or a
    /// malformed value is an error naming the variable. `ENCRYPTION_KEYS_FILE` may name a file
    /// that does not exist yet.
    pub fn load(get: &dyn Fn(&str) -> Option<String>) -> anyhow::Result<KeyConfig> {
        let set = |name: &str| {
            get(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let keys_file = set("ENCRYPTION_KEYS_FILE").map(PathBuf::from);
        let keys_from_file = set("ENCRYPTION_KEYS").is_none();
        let keys = match (set("ENCRYPTION_KEYS"), &keys_file) {
            (Some(keys), _) => Some(keys),
            (None, Some(path)) if !path.exists() => None,
            (None, _) => crate::config::read_required_secret(get, "ENCRYPTION_KEYS")?,
        };
        if let Some(keys) = &keys {
            let name = match keys_from_file {
                false => "ENCRYPTION_KEYS",
                true => "ENCRYPTION_KEYS_FILE",
            };
            parse_keys(keys).map_err(|e| anyhow::anyhow!("{name} is malformed: {e}"))?;
        }
        let account_secrets_key = crate::config::read_required_secret(get, "ACCOUNT_SECRETS_KEY")?;
        if let Some(keys) = &account_secrets_key {
            parse_keys(keys)
                .map_err(|e| anyhow::anyhow!("ACCOUNT_SECRETS_KEY is malformed: {e}"))?;
        }
        let allow_lost = match set("ENCRYPTION_ALLOW_LOST").as_deref() {
            None | Some("off") => false,
            Some("on") => true,
            Some(_) => anyhow::bail!("ENCRYPTION_ALLOW_LOST is on or off"),
        };
        let required = match set("ENCRYPTION_REQUIRED").as_deref() {
            None | Some("off") => false,
            Some("on") => true,
            Some(_) => anyhow::bail!("ENCRYPTION_REQUIRED is on or off"),
        };
        let search_scan = match set("SEARCH_SEALED").as_deref() {
            None | Some("keyed") => false,
            Some("scan") => true,
            Some(_) => anyhow::bail!("SEARCH_SEALED is keyed or scan"),
        };
        Ok(KeyConfig {
            keys_from_file: keys_from_file && keys.is_some(),
            keys: keys.map(Zeroizing::new),
            keys_file,
            account_secrets_key: account_secrets_key.map(Zeroizing::new),
            allow_lost,
            required,
            search_scan,
        })
    }
}

/// The instance key file of a database: the file `ENCRYPTION_KEYS_FILE` names, else
/// `<database file>.keys` on SQLite. Postgres has none unless the variable names one.
pub fn instance_key_file(database_url: Option<&str>, keys_file: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = keys_file {
        return Some(path.to_owned());
    }
    let mut file = crate::db::sqlite_file(database_url)?.into_os_string();
    file.push(".keys");
    Some(PathBuf::from(file))
}

fn read_key_file(path: &Path) -> anyhow::Result<Vec<Kek>> {
    let text = Zeroizing::new(
        std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("the key file {} cannot be read: {e}", path.display()))?,
    );
    parse_keys(&text)
        .map_err(|e| anyhow::anyhow!("the key file {} is malformed: {e}", path.display()))
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    if written.is_err() {
        let _ = std::fs::remove_file(path);
    }
    written
}

/// Writes a new file readable by this user only, failing when one is already there. The bytes go
/// to a temporary file beside it first, which is linked into place whole, so the file is never
/// seen half written; a file system without links gets the file written in place.
pub fn write_new_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let Some(name) = path.file_name() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the path names no file",
        ));
    };
    let dir = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temp = name.to_owned();
    temp.push(format!(".{}.tmp", hex::encode(rand::random::<[u8; 8]>())));
    let temp = dir.join(temp);
    write_private(&temp, bytes)?;
    let linked = std::fs::hard_link(&temp, path);
    let _ = std::fs::remove_file(&temp);
    match linked {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Err(e),
        Err(_) => write_private(path, bytes)?,
    }
    #[cfg(unix)]
    std::fs::File::open(dir)?.sync_all()?;
    Ok(())
}

/// The keys in the form `ENCRYPTION_KEYS` and the key file take.
pub fn keys_text(keys: &[Kek]) -> Zeroizing<String> {
    let mut text = Zeroizing::new(String::new());
    for (i, key) in keys.iter().enumerate() {
        if i > 0 {
            text.push(',');
        }
        text.push_str(&key.encoded());
    }
    text
}

/// Writes a new key file, failing when one is already there.
pub fn create_key_file(path: &Path, keys: &[Kek]) -> std::io::Result<()> {
    let mut text = keys_text(keys);
    text.push('\n');
    write_new_file(path, text.as_bytes())
}

#[derive(Clone)]
struct Dek {
    purpose: Purpose,
    generation: i64,
    key: Key,
}

#[derive(Default)]
struct Loaded {
    source: Option<Source>,
    keks: Vec<Kek>,
}

/// One data key as `server keys status` and the admin page list it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DataKeyStatus {
    pub id: i64,
    pub purpose: String,
    pub generation: i64,
    pub kek: String,
    pub state: String,
    /// Whether it unwraps with a key this process holds.
    pub held: bool,
    /// Whether this process holds a key with that id that is not the one that wrapped it.
    pub mismatch: bool,
}

/// What the admin page and `server keys status` show. It never holds key material.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RingStatus {
    /// `operator`, `file`, or `none`.
    pub source: String,
    /// `id:fingerprint` of every root key, the wrapping key first.
    pub fingerprints: Vec<String>,
    pub key_file: Option<String>,
    /// Whether the `secrets` purpose runs on the key kept in the database.
    pub database_key: bool,
    pub backed_up_at: Option<i64>,
    pub secrets_reset: Option<SecretsReset>,
    pub data_keys: Vec<DataKeyStatus>,
}

/// The relay or P2P secrets a start made again because the stored ones could not be opened.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SecretsReset {
    pub at: i64,
    /// The `settings` names, such as `relay_secret`.
    pub secrets: Vec<String>,
}

impl RingStatus {
    /// Whether the page warns to back up the key file.
    pub fn needs_backup(&self) -> bool {
        self.source == Source::File.name() && self.backed_up_at.is_none()
    }
}

/// Why no ring could be made on first need.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoRing {
    /// Postgres without `ENCRYPTION_KEYS_FILE`, or an in-memory database: nowhere to keep a key.
    NoPlace,
    /// Another copy is live, so a key made here would not reach it.
    OtherCopies,
}

/// Whether sealing may be turned on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Readiness {
    Ready,
    /// No root key is loaded yet; the first switch makes the instance key file.
    FirstNeed,
    /// No root key is loaded and none can be made here.
    NoKeys,
    /// A live copy runs a build without sealing, or lacks a root key.
    Updating,
}

impl Readiness {
    pub fn name(self) -> &'static str {
        match self {
            Readiness::Ready => "ready",
            Readiness::FirstNeed => "first_need",
            Readiness::NoKeys => "keys",
            Readiness::Updating => "updating",
        }
    }
}

/// The readiness of a copy holding `keks` beside `others`, the last announcement of every other
/// live copy. `can_make` is whether the first switch may make the instance key file here.
pub fn readiness(keks: &[String], can_make: bool, others: &[Option<CopyNote>]) -> Readiness {
    let level = |other: &Option<CopyNote>| {
        other
            .as_ref()
            .is_some_and(|note| note.seal && keks.iter().all(|id| note.keks.contains(id)))
    };
    match (keks.is_empty(), can_make, others.iter().all(level)) {
        (true, false, _) => Readiness::NoKeys,
        (_, _, false) => Readiness::Updating,
        (true, true, true) => Readiness::FirstNeed,
        (false, _, true) => Readiness::Ready,
    }
}

/// How often a copy announces itself.
pub const COPY_EVERY: std::time::Duration = std::time::Duration::from_secs(30);

pub struct Ring {
    loaded: RwLock<Loaded>,
    alias: Vec<Kek>,
    key_file: Option<PathBuf>,
    /// Whether the keys were read from the file `ENCRYPTION_KEYS_FILE` names, which the instance
    /// may have made itself.
    named_file: bool,
    allow_lost: bool,
    required: bool,
    search_scan: bool,
    making: tokio::sync::Mutex<()>,
    deks: RwLock<HashMap<u32, Dek>>,
    active: RwLock<HashMap<Purpose, u32>>,
    unreadable: std::sync::atomic::AtomicU64,
    grams_from: std::sync::Mutex<Option<(i64, i64)>>,
    pub subkeys: Subkeys,
}

impl std::fmt::Debug for Ring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ring")
            .field("key_file", &self.key_file)
            .finish_non_exhaustive()
    }
}

impl Default for Ring {
    fn default() -> Ring {
        Ring::none()
    }
}

fn read<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|e| e.into_inner())
}

fn write<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|e| e.into_inner())
}

async fn setting(conn: &mut AnyConnection, key: &str) -> sqlx::Result<Option<String>> {
    sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(&mut *conn)
        .await?
        .map(|r| r.try_get(0))
        .transpose()
}

async fn put_setting(conn: &mut AnyConnection, key: &str, value: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

/// Refuses `kek` for a new data key while a data key in use names its id but does not unwrap
/// with it. An id names one key only, so the key that wrapped that data key can come back.
async fn id_is_free(conn: &mut AnyConnection, kek: &Kek) -> anyhow::Result<()> {
    let rows = sqlx::query(
        "SELECT id, purpose, gen, wrapped FROM data_keys WHERE kek = $1 AND state <> 'destroyed' ORDER BY id",
    )
    .bind(&kek.id)
    .fetch_all(&mut *conn)
    .await?;
    for row in rows {
        let (id, purpose, generation): (i64, String, i64) =
            (row.try_get(0)?, row.try_get(1)?, row.try_get(2)?);
        let wrapped: String = row.try_get(3)?;
        if Purpose::parse(&purpose).is_some_and(|p| kek.unwrap(p, generation, &wrapped).is_ok()) {
            continue;
        }
        let restore = match kek.id.as_str() {
            DATABASE_KEK => format!(
                "which the settings key {DB_KEK_SETTING} does not hold. Restore {DB_KEK_SETTING}, or set ENCRYPTION_KEYS or ACCOUNT_SECRETS_KEY"
            ),
            id => format!(
                "but the key {id} here is a different key. Restore that key, or give the new key another id"
            ),
        };
        anyhow::bail!(
            "the data key {id} ({purpose}) needs the key {}, {restore}. A new data key is never wrapped under an id that names another key",
            kek.id
        );
    }
    Ok(())
}

impl Ring {
    /// A ring with no root key and nowhere to make one.
    pub fn none() -> Ring {
        Ring::with(Loaded::default(), Vec::new(), None, false)
    }

    fn with(loaded: Loaded, alias: Vec<Kek>, key_file: Option<PathBuf>, allow_lost: bool) -> Ring {
        Ring {
            loaded: RwLock::new(loaded),
            alias,
            key_file,
            named_file: false,
            allow_lost,
            required: false,
            search_scan: false,
            making: tokio::sync::Mutex::new(()),
            deks: RwLock::default(),
            active: RwLock::default(),
            unreadable: std::sync::atomic::AtomicU64::new(0),
            grams_from: std::sync::Mutex::new(None),
            subkeys: Subkeys::default(),
        }
    }

    /// The ring of this start, by precedence: operator keys, then the instance key file when it
    /// exists. Touches no database, so it runs before the schema does.
    pub fn load(config: &KeyConfig, database_url: Option<&str>) -> anyhow::Result<Ring> {
        let KeyConfig {
            keys,
            keys_from_file,
            keys_file,
            account_secrets_key,
            allow_lost,
            required,
            search_scan,
        } = config;
        let alias = match account_secrets_key {
            Some(text) => parse_keys(text)
                .map_err(|e| anyhow::anyhow!("ACCOUNT_SECRETS_KEY is malformed: {e}"))?
                .into_iter()
                .map(|k| Kek::new(&format!("{ALIAS_PREFIX}{}", k.id), k.key.clone()))
                .collect(),
            None => Vec::new(),
        };
        let key_file = instance_key_file(database_url, keys_file.as_deref());
        let loaded = match keys {
            Some(text) => Loaded {
                source: Some(Source::Operator),
                keks: parse_keys(text)
                    .map_err(|e| anyhow::anyhow!("ENCRYPTION_KEYS is malformed: {e}"))?,
            },
            None => match key_file.as_deref().filter(|p| p.exists()) {
                Some(path) => Loaded {
                    source: Some(Source::File),
                    keks: read_key_file(path)?,
                },
                None => Loaded::default(),
            },
        };
        Ok(Ring {
            named_file: *keys_from_file,
            required: *required,
            search_scan: *search_scan,
            ..Ring::with(loaded, alias, key_file, *allow_lost)
        })
    }

    /// Whether a root key is loaded.
    pub fn ready(&self) -> bool {
        !read(&self.loaded).keks.is_empty()
    }

    pub fn key_file(&self) -> Option<&Path> {
        self.key_file.as_deref()
    }

    /// The ids of the root keys this process holds, for the copy announcement.
    pub fn kek_ids(&self) -> Vec<String> {
        read(&self.loaded)
            .keks
            .iter()
            .map(|k| k.id.clone())
            .collect()
    }

    /// The loaded root keys in their file form, for `server keys export`.
    pub fn export(&self) -> Option<Zeroizing<String>> {
        let text = keys_text(&read(&self.loaded).keks);
        (!text.is_empty()).then_some(text)
    }

    /// Where the first need may make the instance key file: nowhere without a path, and on
    /// Postgres nowhere while another copy is live.
    fn place(&self, sqlite: bool, other_copies: bool) -> Result<&Path, NoRing> {
        let path = self.key_file.as_deref().ok_or(NoRing::NoPlace)?;
        match !sqlite && other_copies {
            true => Err(NoRing::OtherCopies),
            false => Ok(path),
        }
    }

    /// Whether a switch may turn sealing on, beside `others`, the last announcement of every other
    /// live copy.
    pub fn readiness(&self, sqlite: bool, others: &[Option<CopyNote>]) -> Readiness {
        let can_make = self.place(sqlite, !others.is_empty()).is_ok();
        readiness(&self.kek_ids(), can_make, others)
    }

    /// Makes the instance key file when no root key is loaded: one new key, written with
    /// `O_EXCL` and mode 0600 and never stored in the database. `other_copies` is whether
    /// another copy of this instance is live; Postgres makes a key only when none is.
    pub async fn ensure_ring(
        &self,
        db: &Db,
        other_copies: bool,
    ) -> anyhow::Result<Result<(), NoRing>> {
        if self.ready() {
            return Ok(Ok(()));
        }
        let _making = self.making.lock().await;
        if self.ready() {
            return Ok(Ok(()));
        }
        let path = match self.place(crate::db::is_sqlite(db), other_copies) {
            Ok(path) => path,
            Err(no) => return Ok(Err(no)),
        };
        let mut conn = db.acquire().await?;
        let conn = &mut *conn;
        let made = Kek::generate("k1");
        let keks = match create_key_file(path, std::slice::from_ref(&made)) {
            Ok(()) => {
                tracing::warn!(
                    "created the key file {}. Back it up: without it, encrypted messages can't be opened",
                    path.display()
                );
                put_setting(conn, MADE_SETTING, &made.fingerprint()).await?;
                read_key_file(path)?
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => read_key_file(path)?,
            Err(e) => anyhow::bail!("the key file {} cannot be written: {e}", path.display()),
        };
        put_setting(conn, SOURCE_SETTING, Source::File.name()).await?;
        *write(&self.loaded) = Loaded {
            source: Some(Source::File),
            keks,
        };
        Ok(Ok(()))
    }

    /// The source in use. A file named in `ENCRYPTION_KEYS_FILE` is the instance key file when
    /// it holds the key the instance wrote into the file it made; `made` is that key's
    /// fingerprint.
    fn source(&self, made: Option<&str>) -> Option<Source> {
        let loaded = read(&self.loaded);
        let made_here = self.named_file
            && made.is_some_and(|print| loaded.keks.iter().any(|k| k.fingerprint() == print));
        match loaded.source {
            Some(Source::Operator) if made_here => Some(Source::File),
            other => other,
        }
    }

    /// Records the source in use in `settings`.
    pub async fn note_source(&self, db: &Db) -> sqlx::Result<()> {
        let mut conn = db.acquire().await?;
        let conn = &mut *conn;
        let made = setting(conn, MADE_SETTING).await?;
        let Some(source) = self.source(made.as_deref()) else {
            return Ok(());
        };
        if setting(conn, SOURCE_SETTING).await?.as_deref() == Some(source.name()) {
            return Ok(());
        }
        put_setting(conn, SOURCE_SETTING, source.name()).await
    }

    /// Where the root keys this process holds were read, as a start refusal names it.
    fn keks_from(&self) -> String {
        let source = read(&self.loaded).source;
        match (source, self.key_file.as_deref()) {
            (Some(Source::Operator), Some(path)) if self.named_file => {
                format!("ENCRYPTION_KEYS_FILE ({})", path.display())
            }
            (Some(Source::Operator), _) | (Some(Source::File) | None, None) => {
                "ENCRYPTION_KEYS".to_owned()
            }
            (Some(Source::File) | None, Some(path)) => format!("the key file {}", path.display()),
        }
    }

    fn kek(&self, id: &str, purpose: Purpose) -> Option<Kek> {
        if let Some(found) = read(&self.loaded).keks.iter().find(|k| k.id == id) {
            return Some(found.clone());
        }
        match purpose {
            Purpose::Secrets => self.alias.iter().find(|k| k.id == id).cloned(),
            Purpose::Content | Purpose::Media | Purpose::Search | Purpose::Bus => None,
        }
    }

    async fn database_kek(
        &self,
        conn: &mut AnyConnection,
        create: bool,
    ) -> anyhow::Result<Option<Kek>> {
        if create {
            let fresh = Kek::generate(DATABASE_KEK);
            let value = fresh.encoded();
            let value = value
                .split_once(':')
                .map(|(_, key)| key)
                .unwrap_or_default();
            sqlx::query(
                "INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING",
            )
            .bind(DB_KEK_SETTING)
            .bind(value)
            .execute(&mut *conn)
            .await?;
        }
        let Some(stored) = setting(conn, DB_KEK_SETTING).await?.map(Zeroizing::new) else {
            return Ok(None);
        };
        if stored.as_str() == SEALED_MARK {
            return Ok(None);
        }
        let key = decode_key(DATABASE_KEK, &stored)
            .map_err(|e| anyhow::anyhow!("the settings key {DB_KEK_SETTING} is malformed: {e}"))?;
        Ok(Some(Kek::new(DATABASE_KEK, key)))
    }

    async fn wrapping_kek(
        &self,
        conn: &mut AnyConnection,
        purpose: Purpose,
    ) -> anyhow::Result<Option<Kek>> {
        if let Some(first) = read(&self.loaded).keks.first() {
            return Ok(Some(first.clone()));
        }
        match purpose {
            Purpose::Secrets => match self.alias.first() {
                Some(alias) => Ok(Some(alias.clone())),
                None => self.database_kek(conn, true).await,
            },
            Purpose::Content | Purpose::Media | Purpose::Search | Purpose::Bus => Ok(None),
        }
    }

    /// The data key of a row, or why it does not unwrap here: `None` when this process holds no
    /// key under the id that wrapped it, else the fingerprint of the key it holds under that id.
    async fn unwrap_row(
        &self,
        conn: &mut AnyConnection,
        purpose: Purpose,
        generation: i64,
        kek: &str,
        wrapped: &str,
    ) -> anyhow::Result<Result<Key, Option<String>>> {
        let found = match kek {
            DATABASE_KEK => self.database_kek(conn, false).await?,
            id => self.kek(id, purpose),
        };
        let Some(found) = found else {
            return Ok(Err(None));
        };
        Ok(found
            .unwrap(purpose, generation, wrapped)
            .map_err(|_| Some(found.fingerprint())))
    }

    /// The active data key of `purpose`, made on first use: inserted if absent and read back,
    /// so copies starting together agree. `None` when no key may wrap this purpose yet.
    pub async fn data_key(&self, db: &Db, purpose: Purpose) -> anyhow::Result<Option<(u32, Key)>> {
        if let Some(held) = self.held_data_key(purpose) {
            return Ok(Some(held));
        }
        self.data_key_on(&mut *db.acquire().await?, purpose).await
    }

    fn held_data_key(&self, purpose: Purpose) -> Option<(u32, Key)> {
        let id = read(&self.active).get(&purpose).copied()?;
        let key = read(&self.deks).get(&id)?.key.clone();
        Some((id, key))
    }

    /// `data_key` on one connection, for a caller inside a transaction that forgets the held
    /// keys when it rolls back.
    pub async fn data_key_on(
        &self,
        conn: &mut AnyConnection,
        purpose: Purpose,
    ) -> anyhow::Result<Option<(u32, Key)>> {
        if let Some(held) = self.held_data_key(purpose) {
            return Ok(Some(held));
        }
        let mut row = sqlx::query(ACTIVE)
            .bind(purpose.name())
            .fetch_optional(&mut *conn)
            .await?;
        if row.is_none() {
            let Some(kek) = self.wrapping_kek(conn, purpose).await? else {
                return Ok(None);
            };
            id_is_free(conn, &kek).await?;
            let wrapped = kek.wrap(purpose, 1, &random_key());
            sqlx::query("INSERT INTO data_keys(purpose, gen, kek, wrapped, created_at) VALUES($1, 1, $2, $3, $4) ON CONFLICT(purpose, gen) DO NOTHING")
                .bind(purpose.name())
                .bind(&kek.id)
                .bind(wrapped)
                .bind(crate::db::now())
                .execute(&mut *conn)
                .await?;
            row = sqlx::query(ACTIVE)
                .bind(purpose.name())
                .fetch_optional(&mut *conn)
                .await?;
        }
        match row {
            Some(row) => self.hold_active(conn, purpose, row).await.map(Some),
            None => Ok(None),
        }
    }

    /// The active data key of `purpose` as stored, read on the caller's connection. It never
    /// makes one, so a write transaction holds only a key that a committed write made: a key
    /// made inside a transaction that rolls back would stay held for records nothing opens.
    pub async fn stored_data_key_on(
        &self,
        conn: &mut AnyConnection,
        purpose: Purpose,
    ) -> anyhow::Result<Option<(u32, Key)>> {
        if let Some(held) = self.held_data_key(purpose) {
            return Ok(Some(held));
        }
        let row = sqlx::query(ACTIVE)
            .bind(purpose.name())
            .fetch_optional(&mut *conn)
            .await?;
        match row {
            Some(row) => self.hold_active(conn, purpose, row).await.map(Some),
            None => Ok(None),
        }
    }

    /// `stored_data_key_on` on a connection of the pool.
    pub async fn stored_data_key(
        &self,
        db: &Db,
        purpose: Purpose,
    ) -> anyhow::Result<Option<(u32, Key)>> {
        if let Some(held) = self.held_data_key(purpose) {
            return Ok(Some(held));
        }
        self.stored_data_key_on(&mut *db.acquire().await?, purpose)
            .await
    }

    async fn hold_active(
        &self,
        conn: &mut AnyConnection,
        purpose: Purpose,
        row: sqlx::any::AnyRow,
    ) -> anyhow::Result<(u32, Key)> {
        let (id, generation): (i64, i64) = (row.try_get(0)?, row.try_get(1)?);
        let (kek, wrapped): (String, String) = (row.try_get(2)?, row.try_get(3)?);
        let Ok(key) = self
            .unwrap_row(conn, purpose, generation, &kek, &wrapped)
            .await?
        else {
            anyhow::bail!("the data key {id} cannot be unwrapped with the key {kek}");
        };
        let id = u32::try_from(id)?;
        write(&self.deks).insert(
            id,
            Dek {
                purpose,
                generation,
                key: key.clone(),
            },
        );
        write(&self.active).insert(purpose, id);
        Ok((id, key))
    }

    /// The data key a record names, whatever its state, unless it was destroyed or its root key
    /// is not held.
    pub async fn key_by_id(&self, db: &Db, id: u32) -> anyhow::Result<Option<(Purpose, Key)>> {
        if let Some(dek) = read(&self.deks).get(&id) {
            return Ok(Some((dek.purpose, dek.key.clone())));
        }
        self.key_by_id_on(&mut *db.acquire().await?, id).await
    }

    /// `key_by_id` on one connection, for a caller inside a transaction.
    pub async fn key_by_id_on(
        &self,
        conn: &mut AnyConnection,
        id: u32,
    ) -> anyhow::Result<Option<(Purpose, Key)>> {
        if let Some(dek) = read(&self.deks).get(&id) {
            return Ok(Some((dek.purpose, dek.key.clone())));
        }
        let row = sqlx::query(
            "SELECT purpose, gen, kek, wrapped FROM data_keys WHERE id = $1 AND state <> 'destroyed'",
        )
        .bind(i64::from(id))
        .fetch_optional(&mut *conn)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let (purpose, generation): (String, i64) = (row.try_get(0)?, row.try_get(1)?);
        let (kek, wrapped): (String, String) = (row.try_get(2)?, row.try_get(3)?);
        let Some(purpose) = Purpose::parse(&purpose) else {
            return Ok(None);
        };
        let Ok(key) = self
            .unwrap_row(conn, purpose, generation, &kek, &wrapped)
            .await?
        else {
            return Ok(None);
        };
        write(&self.deks).insert(
            id,
            Dek {
                purpose,
                generation,
                key: key.clone(),
            },
        );
        Ok(Some((purpose, key)))
    }

    /// Whether the server configuration requires encrypted storage everywhere.
    pub fn required(&self) -> bool {
        self.required
    }

    /// Whether encrypted messages get no search grams (`SEARCH_SEALED=scan`), so a search
    /// reads them one by one.
    pub fn scans(&self) -> bool {
        self.search_scan
    }

    /// A data key this process already holds.
    pub fn held(&self, id: u32) -> Option<(Purpose, Key)> {
        read(&self.deks)
            .get(&id)
            .map(|dek| (dek.purpose, dek.key.clone()))
    }

    /// Counts a stored record that did not open.
    pub fn note_unreadable(&self) {
        self.unreadable
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    /// How many stored records did not open since this process started.
    pub fn unreadable(&self) -> u64 {
        self.unreadable.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Where the grams fill goes on, as `(channel, id)`: it read the encrypted rows before it
    /// since this start. A record that did not open opens only with keys a later start loads.
    pub fn grams_from(&self) -> Option<(i64, i64)> {
        *self.grams_from.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_grams_from(&self, at: Option<(i64, i64)>) {
        *self.grams_from.lock().unwrap_or_else(|e| e.into_inner()) = at;
    }

    /// Whether a start goes on with records it cannot open (`ENCRYPTION_ALLOW_LOST=on`).
    pub fn allow_lost(&self) -> bool {
        self.allow_lost
    }

    /// Drops the held data keys, as after a transaction that made one was rolled back.
    pub fn forget_data_keys(&self) {
        write(&self.active).clear();
        write(&self.deks).clear();
        self.subkeys.forget(None);
    }

    /// Makes the next generation of the data key of `purpose` the active one, for a purpose
    /// whose active key does not unwrap here. The key it replaces stays listed for its records.
    /// `None` when no key may wrap this purpose.
    pub async fn renew_on(
        &self,
        conn: &mut AnyConnection,
        purpose: Purpose,
    ) -> anyhow::Result<Option<(u32, Key)>> {
        let Some(kek) = self.wrapping_kek(conn, purpose).await? else {
            return Ok(None);
        };
        id_is_free(conn, &kek).await?;
        let last: i64 =
            sqlx::query("SELECT COALESCE(MAX(gen), 0) FROM data_keys WHERE purpose = $1")
                .bind(purpose.name())
                .fetch_one(&mut *conn)
                .await?
                .try_get(0)?;
        let generation = last + 1;
        sqlx::query(
            "UPDATE data_keys SET state = 'retiring' WHERE purpose = $1 AND state = 'active'",
        )
        .bind(purpose.name())
        .execute(&mut *conn)
        .await?;
        sqlx::query("INSERT INTO data_keys(purpose, gen, kek, wrapped, created_at) VALUES($1, $2, $3, $4, $5)")
            .bind(purpose.name())
            .bind(generation)
            .bind(&kek.id)
            .bind(kek.wrap(purpose, generation, &random_key()))
            .bind(crate::db::now())
            .execute(&mut *conn)
            .await?;
        write(&self.active).remove(&purpose);
        self.data_key_on(conn, purpose).await
    }

    /// The generation of a cached data key.
    pub fn generation(&self, id: u32) -> Option<i64> {
        read(&self.deks).get(&id).map(|dek| dek.generation)
    }

    /// The scope subkey of the active data key of `purpose`.
    pub async fn scope_key(
        &self,
        db: &Db,
        purpose: Purpose,
        scope: &str,
    ) -> anyhow::Result<Option<(u32, Key)>> {
        let Some((id, dek)) = self.data_key(db, purpose).await? else {
            return Ok(None);
        };
        Ok(Some((id, self.subkeys.get(id, &dek, scope))))
    }

    /// The start check: every data key still in use unwraps with a key this process holds.
    /// A missing key refuses the start and names the data key and the root key, unless
    /// `ENCRYPTION_ALLOW_LOST=on`; then the ids are returned and their records read as
    /// unreadable.
    pub async fn check(&self, db: &Db) -> anyhow::Result<Vec<i64>> {
        self.check_on(&mut *db.acquire().await?).await
    }

    /// `check` on one connection. The data keys that unwrap stay held, so reading a record
    /// under one of them asks the database nothing.
    pub async fn check_on(&self, conn: &mut AnyConnection) -> anyhow::Result<Vec<i64>> {
        let rows = sqlx::query(
            "SELECT id, purpose, gen, kek, wrapped FROM data_keys WHERE state <> 'destroyed' ORDER BY id",
        )
        .fetch_all(&mut *conn)
        .await?;
        let mut lost = Vec::new();
        for row in rows {
            let (id, purpose, generation): (i64, String, i64) =
                (row.try_get(0)?, row.try_get(1)?, row.try_get(2)?);
            let (kek, wrapped): (String, String) = (row.try_get(3)?, row.try_get(4)?);
            let parsed = Purpose::parse(&purpose);
            let held = match parsed {
                Some(purpose) => {
                    self.unwrap_row(conn, purpose, generation, &kek, &wrapped)
                        .await?
                }
                None => Err(None),
            };
            let found = match (held, parsed, u32::try_from(id)) {
                (Ok(key), Some(purpose), Ok(id)) => {
                    write(&self.deks).insert(
                        id,
                        Dek {
                            purpose,
                            generation,
                            key,
                        },
                    );
                    continue;
                }
                (Ok(_), _, _) => continue,
                (Err(found), _, _) => found,
            };
            let whence = match kek.as_str() {
                DATABASE_KEK => format!("the settings key {DB_KEK_SETTING}"),
                id if id.starts_with(ALIAS_PREFIX) => "ACCOUNT_SECRETS_KEY".to_owned(),
                _ => self.keks_from(),
            };
            let why = match found {
                None => format!(
                    "the data key {id} ({purpose}) needs the key {kek}, which {whence} does not hold"
                ),
                Some(print) => format!(
                    "the data key {id} ({purpose}) needs the key {kek}, but the key {kek} in {whence} (fingerprint {print}) is a different key"
                ),
            };
            if !self.allow_lost {
                anyhow::bail!(
                    "{why}. Restore the key, or set ENCRYPTION_ALLOW_LOST=on to start with its records unreadable"
                );
            }
            tracing::error!("{why}: its records are unreadable");
            lost.push(id);
        }
        Ok(lost)
    }

    pub async fn status(&self, db: &Db) -> anyhow::Result<RingStatus> {
        let mut conn = db.acquire().await?;
        let conn = &mut *conn;
        let made = setting(conn, MADE_SETTING).await?;
        let source = self.source(made.as_deref());
        let (source, fingerprints) = {
            let loaded = read(&self.loaded);
            let source = match source {
                Some(source) => source.name(),
                None => "none",
            };
            let prints = loaded
                .keks
                .iter()
                .map(|k| format!("{}:{}", k.id, k.fingerprint()))
                .collect();
            (source.to_owned(), prints)
        };
        let rows =
            sqlx::query("SELECT id, purpose, gen, kek, wrapped, state FROM data_keys ORDER BY id")
                .fetch_all(&mut *conn)
                .await?;
        let mut data_keys = Vec::with_capacity(rows.len());
        let mut database_key = false;
        for row in rows {
            let (purpose, generation): (String, i64) = (row.try_get(1)?, row.try_get(2)?);
            let (kek, wrapped, state): (String, String, String) =
                (row.try_get(3)?, row.try_get(4)?, row.try_get(5)?);
            let held = match Purpose::parse(&purpose) {
                Some(purpose) => {
                    self.unwrap_row(conn, purpose, generation, &kek, &wrapped)
                        .await?
                }
                None => Err(None),
            };
            database_key |= kek == DATABASE_KEK && state != "destroyed";
            data_keys.push(DataKeyStatus {
                id: row.try_get(0)?,
                purpose,
                generation,
                kek,
                state,
                mismatch: matches!(held, Err(Some(_))),
                held: held.is_ok(),
            });
        }
        let backed_up_at = setting(conn, BACKED_UP_SETTING)
            .await?
            .and_then(|v| v.trim().parse().ok());
        let secrets_reset = setting(conn, RESET_SETTING)
            .await?
            .and_then(|v| serde_json::from_str(&v).ok());
        let named = self.named_file || source == Source::File.name();
        Ok(RingStatus {
            key_file: named
                .then(|| self.key_file.as_ref().map(|p| p.display().to_string()))
                .flatten(),
            source,
            fingerprints,
            database_key,
            backed_up_at,
            secrets_reset,
            data_keys,
        })
    }
}
