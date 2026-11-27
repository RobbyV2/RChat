//! `server db ...`: commands on the instance's database.

use std::path::{Path, PathBuf};

use clap::Subcommand;

use crate::config::AppConfig;
use crate::crypt::ring::Ring;
use crate::db::DbOptions;

#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
pub enum DbCommand {
    /// Rewrite the SQLite database so the pages deleted or rewritten text left behind are gone
    /// from the file. Stop the server first. Postgres: run VACUUM FULL (or pg_repack) instead.
    Compact,
    /// Write an encrypted backup of the SQLite database to PATH, for age recipients
    /// (--recipient or BACKUP_RECIPIENTS). The root keys are left out unless --with-keys.
    /// Postgres: use pg_dump.
    Backup {
        path: PathBuf,
        /// An age X25519 recipient (age1...); give it more than once for several.
        #[arg(long = "recipient")]
        recipients: Vec<String>,
        /// Put the root keys inside the encrypted backup too.
        #[arg(long)]
        with_keys: bool,
    },
    /// Check a backup: that it is one, and with --identity that it opens and every file matches
    /// its manifest.
    Verify {
        path: PathBuf,
        /// An age identity file (AGE-SECRET-KEY-1...).
        #[arg(long)]
        identity: Option<PathBuf>,
    },
    /// Restore a backup into the folder --to: the database, and the root keys when it holds
    /// them. It checks that every key the data needs is at hand.
    Restore {
        path: PathBuf,
        /// An age identity file (AGE-SECRET-KEY-1...).
        #[arg(long)]
        identity: PathBuf,
        /// A folder to write into; files there are never written over.
        #[arg(long)]
        to: PathBuf,
    },
}

pub async fn run(config: &AppConfig, command: DbCommand) -> anyhow::Result<String> {
    match command {
        DbCommand::Compact => compact(config).await,
        DbCommand::Backup {
            path,
            recipients,
            with_keys,
        } => backed_up(config, &path, &recipients, with_keys).await,
        DbCommand::Verify { path, identity } => verified(&path, identity.as_deref()),
        DbCommand::Restore { path, identity, to } => restored(config, &path, &identity, &to),
    }
}

fn read(path: &Path, what: &str) -> anyhow::Result<String> {
    std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("the {what} {} can't be read: {e}", path.display()))
}

async fn backed_up(
    config: &AppConfig,
    path: &Path,
    given: &[String],
    with_keys: bool,
) -> anyhow::Result<String> {
    let Some(file) = crate::db::sqlite_file(config.database_url.as_deref()) else {
        anyhow::bail!(
            "db backup works on a SQLite database file. On Postgres use pg_dump: what the database stores encrypted stays encrypted in its dump"
        );
    };
    let named = match given.is_empty() {
        true => config.backup_recipients.to_vec(),
        false => given.to_vec(),
    };
    let recipients = super::backup::recipients(&named)?;
    let keys = match with_keys {
        true => {
            let ring = Ring::load(&config.encryption, config.database_url.as_deref())?;
            let why = match ring.kms_only() {
                true => "--with-keys: the key service holds the root key, so no key can go inside",
                false => "--with-keys: no root key is set here",
            };
            Some(ring.export().ok_or_else(|| anyhow::anyhow!(why))?)
        }
        false => None,
    };
    let made = super::backup::backup(
        &file,
        path,
        &recipients,
        keys.as_deref().map(|k| k.as_str()),
    )
    .await?;
    let inside: Vec<String> = match &keys {
        Some(text) => crate::crypt::parse_keys(text)
            .map_err(|e| anyhow::anyhow!("the root keys can't be read: {e}"))?
            .into_iter()
            .map(|k| k.id)
            .collect(),
        None => Vec::new(),
    };
    let keep: Vec<&str> = made
        .sealed
        .key_ids
        .iter()
        .map(String::as_str)
        .filter(|id| *id != crate::crypt::ring::DATABASE_KEK && !inside.iter().any(|k| k == id))
        .collect();
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let mut said = format!(
        "Wrote {}: {size} bytes, encrypted to {}.",
        path.display(),
        match recipients.len() {
            1 => "1 recipient".to_owned(),
            n => format!("{n} recipients"),
        }
    );
    if !inside.is_empty() {
        said.push_str(&format!(" Root keys inside: {}.", inside.join(", ")));
    }
    if !keep.is_empty() {
        said.push_str(&format!(
            " Keep these root keys to restore it: {}.",
            keep.join(", ")
        ));
    }
    Ok(said)
}

fn verified(path: &Path, identity: Option<&Path>) -> anyhow::Result<String> {
    let Some(identity) = identity else {
        super::backup::is_age(path)?;
        return Ok(format!(
            "{} is an age-encrypted file. Add --identity to check that it is a backup and what it holds.",
            path.display()
        ));
    };
    let identities = super::backup::identities(&read(identity, "identity file")?)?;
    let manifest = super::backup::open(path, &identities, None, &[])?;
    let keys = match manifest.files.iter().any(|f| f.path == super::backup::KEYS) {
        true => ", with the root keys",
        false => "",
    };
    let made = time::OffsetDateTime::from_unix_timestamp(manifest.created_at)
        .ok()
        .and_then(|t| {
            t.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(|| manifest.created_at.to_string());
    Ok(format!(
        "{} opens and every file matches its manifest: made {made}, schema {}{keys}.",
        path.display(),
        manifest.schema_version
    ))
}

fn restored(config: &AppConfig, path: &Path, identity: &Path, to: &Path) -> anyhow::Result<String> {
    let identities = super::backup::identities(&read(identity, "identity file")?)?;
    std::fs::create_dir_all(to)
        .map_err(|e| anyhow::anyhow!("{} can't be made: {e}", to.display()))?;
    let database = to.join(super::backup::DATABASE);
    let held = Ring::load(&config.encryption, database.to_str())?.held_ids();
    let manifest = super::backup::open(path, &identities, Some(to), &held)?;
    let names: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    Ok(format!(
        "Restored {} into {}. Start the server with DATABASE_URL={}.",
        names.join(" and "),
        to.display(),
        database.display()
    ))
}

async fn compact(config: &AppConfig) -> anyhow::Result<String> {
    let Some(file) = crate::db::sqlite_file(config.database_url.as_deref()) else {
        anyhow::bail!(
            "db compact works on SQLite. On Postgres run VACUUM FULL (or pg_repack) on the database instead"
        );
    };
    let size = |path: &std::path::Path| std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let before = size(&file);
    let opts = DbOptions {
        controls: None,
        ..config.db_options()
    };
    let db = crate::db::open_with(config.database_url.as_deref(), &opts).await?;
    let done = async {
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&db)
            .await?;
        sqlx::query("VACUUM").execute(&db).await?;
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&db)
            .await
    }
    .await;
    crate::db::close(&db).await;
    done?;
    Ok(format!(
        "Compacted {}: {} bytes before, {} now.",
        file.display(),
        before,
        size(&file)
    ))
}
