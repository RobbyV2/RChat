//! `server keys`: making, listing, exporting and importing root keys from the command line.

use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use zeroize::Zeroizing;

use super::ring::{Ring, RingStatus, SecretsReset, create_key_file, write_new_file};
use super::{
    CryptError, KEY_LEN, Kek, NONCE_LEN, Purpose, check_key_id, decrypt, encrypt, parse_keys,
};
use crate::api::seal::jobs::{Direction, Target, begin, run_job, still_sealed};
use crate::config::AppConfig;
use crate::db::DbOptions;

const EXPORT_FORMAT: &str = "rchat-keys1";
const EXPORT_AAD: &[u8] = b"rchat-keys1";
pub const MIN_PASSPHRASE: usize = 12;

/// The Argon2id settings an export is written with; each export names its own.
pub const EXPORT_KDF: Kdf = Kdf {
    version: 0x13,
    m_cost: 19_456,
    t_cost: 2,
    p_cost: 1,
};
/// The most an export may ask for: 4 GiB, 64 passes, 64 lanes.
const KDF_MAX: Kdf = Kdf {
    version: 0x13,
    m_cost: 4 << 20,
    t_cost: 64,
    p_cost: 64,
};

/// What `server keys` does with the instance's encryption keys.
#[derive(Clone, Debug, PartialEq, Eq, clap::Subcommand)]
pub enum KeysCommand {
    /// Print a new key for ENCRYPTION_KEYS. Nothing is stored.
    New {
        /// The id of the key.
        #[arg(long, default_value = "k1")]
        id: String,
    },
    /// Show where the keys come from, their fingerprints and the data keys they wrap.
    Status,
    /// Write the keys to a file protected by a passphrase, to keep off the server.
    Export {
        /// The file to write. It must not exist yet.
        #[arg(long)]
        out: PathBuf,
        /// A file holding the passphrase; it is asked for on the terminal when left out.
        #[arg(long)]
        passphrase_file: Option<PathBuf>,
    },
    /// Open a file written by `keys export`: print its keys for ENCRYPTION_KEYS, or write them
    /// to a new key file.
    Import {
        /// The file `keys export` wrote.
        #[arg(long = "in")]
        input: PathBuf,
        /// A file holding the passphrase; it is asked for on the terminal when left out.
        #[arg(long)]
        passphrase_file: Option<PathBuf>,
        /// A key file to write, for ENCRYPTION_KEYS_FILE. It must not exist yet.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Store encrypted messages, their files, and the encrypted copies plain again: of every
    /// place, or of one server or DM. Stored secrets keep needing the keys.
    Unseal {
        /// Only this server.
        #[arg(long, conflicts_with = "dm")]
        server: Option<String>,
        /// Only this DM, by its id.
        #[arg(long)]
        dm: Option<i64>,
    },
    /// Move every data key under the key in use now: the key service, else the first key of
    /// ENCRYPTION_KEYS. Run it once every copy has that key; copies that announce themselves
    /// (Redis) do it by themselves.
    Rewrap,
    /// Rotate data keys: the next generation becomes active and what the old one sealed is sealed
    /// again; the old one is destroyed a day after. Every purpose, or one.
    Rotate {
        /// content, media, secrets, search or bus.
        #[arg(long)]
        purpose: Option<String>,
    },
}

/// The Argon2id settings that stretch an export's passphrase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Kdf {
    pub version: u32,
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

fn derived(passphrase: &str, salt: &[u8], kdf: Kdf) -> anyhow::Result<super::Key> {
    let Kdf {
        version,
        m_cost,
        t_cost,
        p_cost,
    } = kdf;
    let unusable = |e: argon2::Error| anyhow::anyhow!("the key derivation cannot run: {e}");
    let params = argon2::Params::new(m_cost, t_cost, p_cost, Some(KEY_LEN)).map_err(unusable)?;
    let version = argon2::Version::try_from(version).map_err(unusable)?;
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon2::Argon2::new(argon2::Algorithm::Argon2id, version, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key[..])
        .map_err(|e| anyhow::anyhow!("the passphrase cannot be used: {e}"))?;
    Ok(key)
}

/// The keys as a passphrase file: Argon2id stretches the passphrase and XChaCha20-Poly1305 seals
/// the key list.
pub fn sealed_export(keys: &str, passphrase: &str) -> anyhow::Result<String> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        anyhow::bail!("the passphrase needs at least {MIN_PASSPHRASE} characters");
    }
    let (salt, nonce) = (
        rand::random::<[u8; 16]>(),
        rand::random::<[u8; NONCE_LEN]>(),
    );
    let sealed = encrypt(
        &derived(passphrase, &salt, EXPORT_KDF)?,
        &nonce,
        EXPORT_AAD,
        keys.as_bytes(),
    );
    let Kdf {
        version,
        m_cost,
        t_cost,
        p_cost,
    } = EXPORT_KDF;
    let file = serde_json::json!({
        "format": EXPORT_FORMAT,
        "kdf": "argon2id",
        "kdf_version": version,
        "m_cost": m_cost,
        "t_cost": t_cost,
        "p_cost": p_cost,
        "salt": URL_SAFE_NO_PAD.encode(salt),
        "nonce": URL_SAFE_NO_PAD.encode(nonce),
        "keys": URL_SAFE_NO_PAD.encode(sealed),
    });
    Ok(serde_json::to_string_pretty(&file)? + "\n")
}

/// The key list of a passphrase file, as `ENCRYPTION_KEYS` takes it.
pub fn opened_export(file: &str, passphrase: &str) -> anyhow::Result<Zeroizing<String>> {
    let file: serde_json::Value =
        serde_json::from_str(file).map_err(|_| anyhow::anyhow!("not a key export"))?;
    if file["format"] != EXPORT_FORMAT || file["kdf"] != "argon2id" {
        anyhow::bail!("not a key export");
    }
    let part = |name: &str| {
        file[name]
            .as_str()
            .and_then(|v| URL_SAFE_NO_PAD.decode(v).ok())
            .ok_or_else(|| anyhow::anyhow!("not a key export"))
    };
    let (salt, nonce, sealed) = (part("salt")?, part("nonce")?, part("keys")?);
    if nonce.len() != NONCE_LEN {
        anyhow::bail!("not a key export");
    }
    let number = |name: &str, most: u32| {
        file[name]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v <= most)
            .ok_or_else(|| anyhow::anyhow!("not a key export"))
    };
    let kdf = Kdf {
        version: number("kdf_version", KDF_MAX.version)?,
        m_cost: number("m_cost", KDF_MAX.m_cost)?,
        t_cost: number("t_cost", KDF_MAX.t_cost)?,
        p_cost: number("p_cost", KDF_MAX.p_cost)?,
    };
    let plain = decrypt(
        &derived(passphrase, &salt, kdf)?,
        &nonce,
        EXPORT_AAD,
        &sealed,
    )
    .map_err(|error| match error {
        CryptError::Format | CryptError::Open => {
            anyhow::anyhow!("wrong passphrase, or the file was changed")
        }
    })?;
    Ok(Zeroizing::new(String::from_utf8(plain)?))
}

/// A line typed on the terminal, not shown while it is typed.
#[cfg(unix)]
fn hidden_line(prompt: &str) -> anyhow::Result<Zeroizing<String>> {
    use rustix::termios::{LocalModes, OptionalActions, tcgetattr, tcsetattr};
    use std::io::IsTerminal;
    let stdin = std::io::stdin();
    if !stdin.is_terminal() {
        anyhow::bail!("give the passphrase with --passphrase-file");
    }
    let shown = tcgetattr(&stdin)?;
    let mut hidden = shown.clone();
    hidden.local_modes.remove(LocalModes::ECHO);
    eprint!("{prompt}");
    tcsetattr(&stdin, OptionalActions::Flush, &hidden)?;
    let mut line = Zeroizing::new(String::new());
    let typed = stdin.read_line(&mut line);
    tcsetattr(&stdin, OptionalActions::Flush, &shown)?;
    eprintln!();
    typed?;
    Ok(line)
}

#[cfg(not(unix))]
fn hidden_line(_prompt: &str) -> anyhow::Result<Zeroizing<String>> {
    anyhow::bail!("give the passphrase with --passphrase-file")
}

fn trimmed(text: &str) -> Zeroizing<String> {
    Zeroizing::new(text.trim_end_matches(['\r', '\n']).to_owned())
}

/// The passphrase from `file`, else typed on the terminal: twice when `confirm`.
fn passphrase(file: Option<&Path>, confirm: bool) -> anyhow::Result<Zeroizing<String>> {
    if let Some(path) = file {
        let text = Zeroizing::new(
            std::fs::read_to_string(path)
                .map_err(|e| anyhow::anyhow!("{} cannot be read: {e}", path.display()))?,
        );
        return Ok(trimmed(&text));
    }
    let typed = trimmed(&hidden_line("Passphrase: ")?);
    if confirm && trimmed(&hidden_line("Passphrase again: ")?) != typed {
        anyhow::bail!("the passphrases differ");
    }
    Ok(typed)
}

fn written(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    write_new_file(path, bytes)
        .map_err(|e| anyhow::anyhow!("{} cannot be written: {e}", path.display()))
}

/// The lines `server keys status` prints.
pub fn printed(status: &RingStatus) -> String {
    let RingStatus {
        source,
        kms,
        fingerprints,
        kept,
        key_file,
        database_key,
        backed_up_at,
        secrets_reset,
        data_keys,
    } = status;
    let mut out = vec![match (source.as_str(), key_file) {
        ("kms", _) => format!(
            "Keys: the key service {}",
            kms.as_deref().unwrap_or_default()
        ),
        ("operator", Some(path)) => format!("Keys: ENCRYPTION_KEYS_FILE {path}"),
        ("operator", None) => "Keys: ENCRYPTION_KEYS".to_owned(),
        ("file", Some(path)) => format!("Keys: the instance key file {path}"),
        ("file", None) => "Keys: the instance key file".to_owned(),
        (_, _) => "Keys: none".to_owned(),
    }];
    for print in fingerprints {
        out.push(format!("  {}", print.trim_end_matches(':')));
    }
    for print in kept {
        let id = print.split_once(':').map_or(print.as_str(), |(id, _)| id);
        let used = data_keys
            .iter()
            .any(|k| k.kek == id && k.state != "destroyed");
        let note = match (source.as_str(), used) {
            ("kms", true) => "kept until its data keys move under the key service",
            ("kms", false) => "no data key needs it now",
            (_, true) => "kept from the key file until its data keys are wrapped again",
            (_, false) => "kept from the key file, which no data key needs now: it can be deleted",
        };
        out.push(format!("  {print} ({note})"));
    }
    if *database_key {
        out.push("Secrets are stored with a key in the database.".to_owned());
    }
    if status.needs_backup() {
        out.push(
            "Back up the key file. Without it, encrypted messages can't be opened.".to_owned(),
        );
    }
    if let Some(at) = backed_up_at {
        out.push(format!("Key copy saved at {at}."));
    }
    if let Some(SecretsReset { at, secrets }) = secrets_reset {
        out.push(format!(
            "Stored secrets that could not be opened were made again at {at}: {}.",
            secrets.join(", ")
        ));
    }
    for key in data_keys {
        let held = match (key.state == "destroyed", key.held, key.mismatch) {
            (true, _, _) | (false, true, _) => String::new(),
            (false, false, true) if key.kek.starts_with(crate::crypt::kms::PREFIX) => {
                " (the key service does not open it)".to_owned()
            }
            (false, false, true) => format!(" (the key {} here is a different key)", key.kek),
            (false, false, false) => " (its key is missing)".to_owned(),
        };
        out.push(format!(
            "  data key {} {} generation {} under {}: {}{held}",
            key.id, key.purpose, key.generation, key.kek, key.state
        ));
    }
    out.join("\n")
}

/// Runs `command` against the keys and database of `config` and answers what to print.
pub async fn run(config: &AppConfig, command: KeysCommand) -> anyhow::Result<String> {
    let ring = || Ring::load(&config.encryption, config.database_url.as_deref());
    match command {
        KeysCommand::New { id } => {
            check_key_id(&id).map_err(|e| anyhow::anyhow!("--id: {e}"))?;
            Ok(Kek::generate(&id).encoded().to_string())
        }
        KeysCommand::Status => {
            let ring = ring()?;
            let opts = DbOptions {
                controls: None,
                ..config.db_options()
            };
            let db = crate::db::open_with(config.database_url.as_deref(), &opts).await?;
            let status = ring.status(&db).await;
            crate::db::close(&db).await;
            Ok(printed(&status?))
        }
        KeysCommand::Export {
            out,
            passphrase_file,
        } => {
            let ring = ring()?;
            let Some(keys) = ring.export() else {
                match ring.kms_only() {
                    true => anyhow::bail!(
                        "the key service holds this site's root key, so there is nothing to export: back it up there"
                    ),
                    false => anyhow::bail!("this site has no encryption key yet"),
                }
            };
            let text = sealed_export(&keys, &passphrase(passphrase_file.as_deref(), true)?)?;
            written(&out, text.as_bytes())?;
            Ok(format!(
                "Wrote the keys to {}. Keep it and its passphrase off the server.",
                out.display()
            ))
        }
        KeysCommand::Import {
            input,
            passphrase_file,
            out,
        } => imported(&input, passphrase_file.as_deref(), out.as_deref()),
        KeysCommand::Rewrap => {
            let ring = std::sync::Arc::new(ring()?);
            let opts = DbOptions {
                controls: None,
                ring: Some(ring.clone()),
                ..config.db_options()
            };
            let db = crate::db::open_with(config.database_url.as_deref(), &opts).await?;
            let moved = ring.rewrap(&db, true).await;
            crate::db::close(&db).await;
            let first = ring
                .first_kek()
                .ok_or_else(|| anyhow::anyhow!("no root key is set: set ENCRYPTION_KEYS"))?;
            Ok(format!("Moved {} data keys under the key {first}.", moved?))
        }
        KeysCommand::Rotate { purpose } => {
            let purposes = match purpose.as_deref() {
                None => Purpose::ALL.to_vec(),
                Some(name) => vec![Purpose::parse(name).ok_or_else(|| {
                    anyhow::anyhow!("--purpose must be content, media, secrets, search or bus")
                })?],
            };
            rotated(config, &purposes).await
        }
        KeysCommand::Unseal { server, dm } => {
            let target = match (server, dm) {
                (Some(name), _) => Target::Server(name.to_lowercase()),
                (None, Some(id)) => Target::Dm(id),
                (None, None) => Target::All,
            };
            unsealed(config, &target).await
        }
    }
}

/// Rotates the data keys of `purposes` and seals what the old ones sealed again, here, to the
/// end.
async fn rotated(config: &AppConfig, purposes: &[Purpose]) -> anyhow::Result<String> {
    let opts = DbOptions {
        controls: None,
        ring: Some(std::sync::Arc::new(Ring::load(
            &config.encryption,
            config.database_url.as_deref(),
        )?)),
        ..config.db_options()
    };
    let db = crate::db::open_with(config.database_url.as_deref(), &opts).await?;
    let instance = crate::instance::Instance::load(&db, &config.instance()).await?;
    let state =
        crate::state::AppState::new(db, crate::ws::Hub::new(), config.s3()?, None, instance);
    let fail = |e| anyhow::anyhow!("{e}");
    let rotation = crate::api::seal::rotate::begin(&state, purposes)
        .await
        .map_err(fail)?;
    if rotation.purposes.is_empty() {
        crate::db::close(&state.db).await;
        return Ok("No data key to rotate: nothing is encrypted with one yet.".to_owned());
    }
    let ran = crate::api::seal::rotate::run(&state).await.map_err(fail)?;
    let left = crate::api::seal::rotate::current(&state.db)
        .await
        .map_err(fail)?;
    crate::db::close(&state.db).await;
    let names = rotation.purposes.join(", ");
    Ok(match (ran, left) {
        (false, _) => {
            format!("A running server is rotating the data keys of {names}; it goes on there.")
        }
        (true, None) => {
            format!("Rotated the data keys of {names}. The old ones are destroyed a day from now.")
        }
        (true, Some(r)) => format!(
            "{} records could not be sealed again; the old data keys of {names} stay.",
            r.left
        ),
    })
}

/// Runs the decrypting job of `target` here, to its end.
async fn unsealed(config: &AppConfig, target: &Target) -> anyhow::Result<String> {
    let opts = DbOptions {
        controls: None,
        ring: Some(std::sync::Arc::new(Ring::load(
            &config.encryption,
            config.database_url.as_deref(),
        )?)),
        ..config.db_options()
    };
    let db = crate::db::open_with(config.database_url.as_deref(), &opts).await?;
    let instance = crate::instance::Instance::load(&db, &config.instance()).await?;
    let state =
        crate::state::AppState::new(db, crate::ws::Hub::new(), config.s3()?, None, instance);
    let job = begin(&state, target, Direction::Unseal, None)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    if !run_job(&state, job.id).await {
        crate::db::close(&state.db).await;
        anyhow::bail!(
            "a running server is decrypting {} already; it goes on there",
            target.key()
        );
    }
    let ended: Option<String> = sqlx::query_scalar("SELECT state FROM seal_jobs WHERE id = $1")
        .bind(job.id)
        .fetch_optional(&state.db)
        .await?;
    let left = still_sealed(&state.db, target)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    crate::db::close(&state.db).await;
    if ended.as_deref() != Some("done") {
        anyhow::bail!("decrypting {} stopped; run it again to go on", target.key());
    }
    let secrets = match target {
        Target::All => " Stored secrets stay encrypted with these keys, so keep them.",
        Target::Server(_) | Target::Dm(_) => "",
    };
    Ok(match left {
        0 => format!(
            "Everything {} stored encrypted is stored plain now.{secrets}",
            target.key()
        ),
        n => format!(
            "{n} records of {} are still stored encrypted: these keys don't open them, or they were written since.{secrets}",
            target.key()
        ),
    })
}

fn imported(
    input: &Path,
    passphrase_file: Option<&Path>,
    out: Option<&Path>,
) -> anyhow::Result<String> {
    let file = std::fs::read_to_string(input)
        .map_err(|e| anyhow::anyhow!("{} cannot be read: {e}", input.display()))?;
    let keys = opened_export(&file, &passphrase(passphrase_file, false)?)?;
    let parsed = parse_keys(&keys).map_err(|e| anyhow::anyhow!("the export is malformed: {e}"))?;
    let Some(out) = out else {
        return Ok(keys.to_string());
    };
    create_key_file(out, &parsed)
        .map_err(|e| anyhow::anyhow!("{} cannot be written: {e}", out.display()))?;
    Ok(format!(
        "Wrote the keys to {}. Name it in ENCRYPTION_KEYS_FILE.",
        out.display()
    ))
}
