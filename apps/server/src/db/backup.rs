//! Encrypted backups of a SQLite database: a tar+zstd archive holding a manifest, the root keys
//! when asked for, and a copy of the database (made with `VACUUM INTO` on a read-only
//! connection), encrypted to age X25519 recipients. Every file is written as an owner-only
//! `.partial` file, then linked into place.

use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Connection;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};

pub const FORMAT: u32 = 1;
pub const DATABASE: &str = "rchat.db";
pub const KEYS: &str = "rchat.db.keys";
const MANIFEST: &str = "manifest.json";
/// The most a manifest or a keys file inside a backup may hold.
const SMALL: u64 = 1 << 20;
/// The files SQLite keeps beside a database; a restore never puts a database beside them.
const BESIDE: [&str; 3] = ["-wal", "-shm", "-journal"];
/// The id of the key kept inside the database for stored secrets: a restore always holds it.
const DATABASE_KEK: &str = crate::crypt::ring::DATABASE_KEK;

/// What a backup holds, as its `manifest.json` says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub format: u32,
    pub created_at: i64,
    pub schema_version: i64,
    pub instance_id: String,
    pub files: Vec<FileEntry>,
    pub sealed: Sealed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// Whether the database holds encrypted data, and the root key ids that open it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sealed {
    /// `sealed` or `plain`.
    pub state: String,
    pub key_ids: Vec<String>,
}

/// The age recipients `texts` name (`age1...`).
pub fn recipients(texts: &[String]) -> anyhow::Result<Vec<age::x25519::Recipient>> {
    texts
        .iter()
        .flat_map(|t| t.split([',', ' ', '\n']))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| {
            t.parse::<age::x25519::Recipient>()
                .map_err(|_| anyhow::anyhow!("{t} is not an age X25519 recipient (age1...)"))
        })
        .collect()
}

/// The identities of an age identity file (`AGE-SECRET-KEY-1...`).
pub fn identities(text: &str) -> anyhow::Result<Vec<Box<dyn age::Identity + Send + Sync>>> {
    age::IdentityFile::from_buffer(text.as_bytes())?
        .into_identities()
        .map_err(|e| anyhow::anyhow!("the identity file can't be read: {e}"))
}

/// A new file only this user can read or write.
fn private(path: &Path) -> anyhow::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|e| anyhow::anyhow!("{} can't be made: {e}", path.display()))
}

/// A new folder only this user can open, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(path: PathBuf) -> anyhow::Result<Scratch> {
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&path)
            .map_err(|e| anyhow::anyhow!("{} can't be made: {e}", path.display()))?;
        Ok(Scratch(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `path` with `suffix` added to its name.
fn beside(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn folder(path: &Path) -> &Path {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

/// Puts the finished file `partial` at `path`, never over a file there: linked, then `partial`
/// removed; renamed on a file system without links.
fn settle(partial: &Path, path: &Path) -> anyhow::Result<()> {
    let linked = std::fs::hard_link(partial, path);
    let taken = match &linked {
        Ok(()) => false,
        Err(e) => e.kind() == std::io::ErrorKind::AlreadyExists || path.exists(),
    };
    if taken {
        let _ = std::fs::remove_file(partial);
        anyhow::bail!("{} exists already", path.display());
    }
    match linked {
        Ok(()) => std::fs::remove_file(partial)?,
        Err(_) => std::fs::rename(partial, path)?,
    }
    #[cfg(unix)]
    std::fs::File::open(folder(path))?.sync_all()?;
    Ok(())
}

/// Copies `reader` into `out` while hashing it: its size and SHA-256.
fn copy_hashed(reader: &mut dyn Read, out: &mut dyn Write) -> std::io::Result<(u64, String)> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n])?;
        size += n as u64;
    }
    Ok((size, hex::encode(hasher.finalize())))
}

async fn read_only(file: &Path) -> sqlx::Result<SqliteConnection> {
    SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(file).read_only(true))
        .await
}

async fn setting(conn: &mut SqliteConnection, key: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(key.to_owned())
        .fetch_optional(conn)
        .await
}

/// The schema version, instance id and root key ids of the database copy at `copy`.
async fn facts(copy: &Path) -> anyhow::Result<(i64, String, Vec<String>)> {
    let mut conn = read_only(copy).await?;
    let schema_version = setting(&mut conn, "schema_version")
        .await?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let instance_id = setting(&mut conn, "instance_id").await?.unwrap_or_default();
    let keyed: bool = sqlx::query_scalar(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'data_keys'",
    )
    .fetch_one(&mut conn)
    .await?;
    let key_ids = match keyed {
        true => {
            sqlx::query_scalar(
                "SELECT DISTINCT kek FROM data_keys WHERE state <> 'destroyed' ORDER BY kek",
            )
            .fetch_all(&mut conn)
            .await?
        }
        false => Vec::new(),
    };
    conn.close().await?;
    Ok((schema_version, instance_id, key_ids))
}

/// Writes an encrypted backup of the SQLite database `file` to `out` for `recipients`, with
/// `keys` (the root keys in their file form) inside when given. The database is only read; its
/// copy waits in an owner-only folder beside it.
pub async fn backup(
    file: &Path,
    out: &Path,
    recipients: &[age::x25519::Recipient],
    keys: Option<&str>,
) -> anyhow::Result<Manifest> {
    if recipients.is_empty() {
        anyhow::bail!("name who can open it: --recipient age1... or BACKUP_RECIPIENTS");
    }
    if !file.is_file() {
        anyhow::bail!("{} is not a database file", file.display());
    }
    if out.exists() {
        anyhow::bail!("{} exists already", out.display());
    }
    if !folder(out).is_dir() {
        anyhow::bail!("{} is not a folder", folder(out).display());
    }
    let partial = beside(out, ".partial");
    if partial.exists() {
        anyhow::bail!(
            "{} exists: a backup is being written there, or one stopped. Remove it when none is running",
            partial.display()
        );
    }
    let scratch = Scratch::new(folder(file).join(format!(
        ".{}.backup-{}",
        file.file_name().and_then(|n| n.to_str()).unwrap_or("db"),
        hex::encode(rand::random::<[u8; 6]>())
    )))?;
    let copy = scratch.0.join(DATABASE);
    drop(private(&copy)?);
    let mut source = read_only(file).await?;
    let quoted = copy.display().to_string().replace('\'', "''");
    sqlx::query(sqlx::AssertSqlSafe(format!("VACUUM INTO '{quoted}'")))
        .execute(&mut source)
        .await?;
    source.close().await?;
    let (schema_version, instance_id, key_ids) = facts(&copy).await?;
    let sealed = Sealed {
        state: match key_ids.iter().any(|k| k != DATABASE_KEK) {
            true => "sealed",
            false => "plain",
        }
        .to_owned(),
        key_ids,
    };
    let mut files = Vec::new();
    if let Some(keys) = keys {
        files.push(FileEntry {
            path: KEYS.to_owned(),
            size: keys.len() as u64,
            sha256: hex::encode(Sha256::digest(keys.as_bytes())),
        });
    }
    let (size, sha256) = copy_hashed(&mut std::fs::File::open(&copy)?, &mut std::io::sink())?;
    files.push(FileEntry {
        path: DATABASE.to_owned(),
        size,
        sha256,
    });
    let manifest = Manifest {
        format: FORMAT,
        created_at: crate::db::now(),
        schema_version,
        instance_id,
        files,
        sealed,
    };
    let written = (|| -> anyhow::Result<()> {
        let file = private(&partial)?;
        let encryptor =
            age::Encryptor::with_recipients(recipients.iter().map(|r| r as &dyn age::Recipient))?;
        let sealed = encryptor.wrap_output(std::io::BufWriter::new(file))?;
        let packed = zstd::Encoder::new(sealed, 3)?;
        let mut archive = tar::Builder::new(packed);
        let add = |archive: &mut tar::Builder<_>, path: &str, size: u64, data: &mut dyn Read| {
            let mut header = tar::Header::new_gnu();
            header.set_size(size);
            header.set_mode(0o600);
            header.set_mtime(manifest.created_at.max(0) as u64);
            header.set_cksum();
            archive.append_data(&mut header, path, data)
        };
        let text = serde_json::to_vec_pretty(&manifest)?;
        add(
            &mut archive,
            MANIFEST,
            text.len() as u64,
            &mut text.as_slice(),
        )?;
        if let Some(keys) = keys {
            add(&mut archive, KEYS, keys.len() as u64, &mut keys.as_bytes())?;
        }
        add(
            &mut archive,
            DATABASE,
            size,
            &mut std::fs::File::open(&copy)?,
        )?;
        let packed = archive.into_inner()?;
        let sealed = packed.finish()?;
        let file = sealed.finish()?.into_inner().map_err(|e| e.into_error())?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&partial);
        return Err(e);
    }
    settle(&partial, out)?;
    Ok(manifest)
}

/// Whether `input` is an age file: its header reads.
pub fn is_age(input: &Path) -> anyhow::Result<()> {
    let file = BufReader::new(std::fs::File::open(input)?);
    age::Decryptor::new_buffered(file)
        .map(|_| ())
        .map_err(|e| anyhow::anyhow!("{} is not a backup this can read: {e}", input.display()))
}

/// A manifest as a backup may hold it: format 1, the database once, the keys at most once,
/// nothing else.
fn checked(text: &[u8]) -> anyhow::Result<Manifest> {
    let manifest: Manifest = serde_json::from_slice(text)?;
    if manifest.format != FORMAT {
        anyhow::bail!(
            "the backup has format {}, this build reads {FORMAT}",
            manifest.format
        );
    }
    let named = |name: &str| manifest.files.iter().filter(|f| f.path == name).count();
    let known = named(DATABASE) + named(KEYS);
    if named(DATABASE) != 1 || named(KEYS) > 1 || known != manifest.files.len() {
        anyhow::bail!("the backup's manifest lists files a backup never holds");
    }
    Ok(manifest)
}

/// Opens `input` with `identities` and reads it through: the manifest, and every file checked
/// against it. With `to`, the files are written there (each new and owner-only, never beside
/// SQLite files left there), once `held` (the root key ids at hand) and the keys inside cover
/// every key the data needs. On any error nothing it wrote is left.
pub fn open(
    input: &Path,
    identities: &[Box<dyn age::Identity + Send + Sync>],
    to: Option<&Path>,
    held: &[String],
) -> anyhow::Result<Manifest> {
    let file = BufReader::new(std::fs::File::open(input)?);
    let decryptor = age::Decryptor::new_buffered(file)
        .map_err(|e| anyhow::anyhow!("{} is not a backup this can read: {e}", input.display()))?;
    let plain = decryptor
        .decrypt(identities.iter().map(|i| i.as_ref() as &dyn age::Identity))
        .map_err(|e| anyhow::anyhow!("the backup does not open with this identity: {e}"))?;
    let mut archive = tar::Archive::new(zstd::Decoder::new(plain)?);
    let mut written: Vec<PathBuf> = Vec::new();
    let result = (|| -> anyhow::Result<Manifest> {
        let mut entries = archive.entries()?;
        let manifest = {
            let first = entries
                .next()
                .ok_or_else(|| anyhow::anyhow!("the backup holds no manifest"))??;
            if first.path_bytes().as_ref() != MANIFEST.as_bytes()
                || !first.header().entry_type().is_file()
            {
                anyhow::bail!("the backup does not start with its manifest");
            }
            let mut text = Vec::new();
            first.take(SMALL + 1).read_to_end(&mut text)?;
            if text.len() as u64 > SMALL {
                anyhow::bail!("the backup's manifest is too large");
            }
            checked(&text)?
        };
        if let Some(dir) = to {
            let listed = manifest.files.iter().map(|f| f.path.as_str());
            let names = listed
                .clone()
                .map(str::to_owned)
                .chain(listed.map(|name| format!("{name}.partial")))
                .chain(BESIDE.iter().map(|s| format!("{DATABASE}{s}")));
            for name in names {
                let there = dir.join(name);
                if there.exists() {
                    anyhow::bail!("{} exists already", there.display());
                }
            }
        }
        let mut seen: Vec<&str> = Vec::new();
        let mut keys_inside: Vec<String> = Vec::new();
        for entry in entries {
            let mut entry = entry?;
            let listed = manifest
                .files
                .iter()
                .find(|f| f.path.as_bytes() == entry.path_bytes().as_ref())
                .ok_or_else(|| {
                    anyhow::anyhow!("the backup holds a file its manifest does not list")
                })?;
            let name = listed.path.as_str();
            if seen.contains(&name) {
                anyhow::bail!("the backup holds {name} twice");
            }
            if !entry.header().entry_type().is_file() {
                anyhow::bail!("the backup's {name} is not a file");
            }
            if name == DATABASE && to.is_some() {
                let missing: Vec<&str> = manifest
                    .sealed
                    .key_ids
                    .iter()
                    .map(String::as_str)
                    .filter(|id| {
                        *id != DATABASE_KEK
                            && !held.iter().any(|h| h == id)
                            && !keys_inside.iter().any(|k| k == id)
                    })
                    .collect();
                if !missing.is_empty() {
                    anyhow::bail!(
                        "the backup needs the key {}: set it in ENCRYPTION_KEYS or ENCRYPTION_KEYS_FILE, or restore a backup made with --with-keys",
                        missing.join(", ")
                    );
                }
            }
            let mut kept = Vec::new();
            let target = to.map(|dir| (beside(&dir.join(name), ".partial"), dir.join(name)));
            let (size, sha256) = match (&target, name == KEYS) {
                (_, true) => {
                    entry.by_ref().take(SMALL + 1).read_to_end(&mut kept)?;
                    if kept.len() as u64 > SMALL {
                        anyhow::bail!("the backup's {name} is too large");
                    }
                    if let Some((partial, _)) = &target {
                        let mut out = private(partial)?;
                        written.push(partial.clone());
                        out.write_all(&kept)?;
                        out.sync_all()?;
                    }
                    (kept.len() as u64, hex::encode(Sha256::digest(&kept)))
                }
                (Some((partial, _)), false) => {
                    let out = private(partial)?;
                    written.push(partial.clone());
                    let mut out = std::io::BufWriter::new(out);
                    let hashed = copy_hashed(&mut entry, &mut out)?;
                    out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
                    hashed
                }
                (None, false) => copy_hashed(&mut entry, &mut std::io::sink())?,
            };
            if size != listed.size || sha256 != listed.sha256 {
                anyhow::bail!("the backup's {name} does not match its manifest");
            }
            if name == KEYS {
                let text = String::from_utf8(kept)?;
                keys_inside = crate::crypt::parse_keys(&text)
                    .map_err(|e| anyhow::anyhow!("the keys in the backup are malformed: {e}"))?
                    .into_iter()
                    .map(|k| k.id)
                    .collect();
            }
            if let Some((partial, path)) = &target {
                settle(partial, path)?;
                written.pop();
                written.push(path.clone());
            }
            seen.push(name);
        }
        if let Some(gone) = manifest
            .files
            .iter()
            .find(|f| !seen.contains(&f.path.as_str()))
        {
            anyhow::bail!("the backup lacks {}, which its manifest lists", gone.path);
        }
        Ok(manifest)
    })();
    if result.is_err() {
        for path in written {
            let _ = std::fs::remove_file(path);
        }
    }
    result
}

#[cfg(test)]
mod tests;
