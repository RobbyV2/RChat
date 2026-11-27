//! `server keys`: making, listing, exporting and importing root keys from the command line.

use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use zeroize::Zeroizing;

use super::ring::{Ring, RingStatus, create_key_file, write_new_file};
use super::{CryptError, KEY_LEN, Kek, NONCE_LEN, check_key_id, decrypt, encrypt, parse_keys};
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
        fingerprints,
        key_file,
        database_key,
        backed_up_at,
        data_keys,
    } = status;
    let mut out = vec![match (source.as_str(), key_file) {
        ("operator", Some(path)) => format!("Keys: ENCRYPTION_KEYS_FILE {path}"),
        ("operator", None) => "Keys: ENCRYPTION_KEYS".to_owned(),
        ("file", Some(path)) => format!("Keys: the instance key file {path}"),
        ("file", None) => "Keys: the instance key file".to_owned(),
        (_, _) => "Keys: none".to_owned(),
    }];
    for print in fingerprints {
        out.push(format!("  {print}"));
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
    for key in data_keys {
        let held = match (key.held, key.mismatch) {
            (true, _) => String::new(),
            (false, true) => format!(" (the key {} here is a different key)", key.kek),
            (false, false) => " (its key is missing)".to_owned(),
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
            let Some(keys) = ring()?.export() else {
                anyhow::bail!("this site has no encryption key yet");
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
    }
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
