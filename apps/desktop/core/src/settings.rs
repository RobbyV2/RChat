use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const FILE: &str = "desktop.json";
const VERSION: u32 = 2;

type Fields = serde_json::Map<String, Value>;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    Weekly,
}

impl Channel {
    // Weekly builds set RCHAT_CHANNEL=weekly at compile time and follow that channel by default.
    pub fn built() -> Self {
        match option_env!("RCHAT_CHANNEL") {
            Some("weekly") => Channel::Weekly,
            _ => Channel::Stable,
        }
    }

    // Update manifests on GitHub Releases. Stable reads the latest full release; weekly reads the
    // pre-release under the moving `weekly` tag.
    pub fn endpoint(self) -> &'static str {
        match self {
            Channel::Stable => {
                "https://github.com/RobbyV2/RChat/releases/latest/download/latest.json"
            }
            Channel::Weekly => {
                "https://github.com/RobbyV2/RChat/releases/download/weekly/latest.json"
            }
        }
    }
}

// What a start on login does. `on` mirrors the system's login entry.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(default)]
pub struct Boot {
    pub on: bool,
    pub client: bool,
    pub hidden: bool,
    pub server: bool,
}

impl Default for Boot {
    fn default() -> Self {
        Boot {
            on: false,
            client: true,
            hidden: true,
            server: false,
        }
    }
}

impl Boot {
    fn parse(fields: Option<&Fields>, base: Self) -> Self {
        let Boot {
            on,
            client,
            hidden,
            server,
        } = base;
        Boot {
            on: pick(fields, "on", on),
            client: pick(fields, "client", client),
            hidden: pick(fields, "hidden", hidden),
            server: pick(fields, "server", server),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AccessMode {
    #[default]
    Local,
    Https,
}

// Where the reverse proxy for the HTTPS address runs.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProxyHost {
    #[default]
    Local,
    Device,
}

// Every field is kept whatever the mode, so switching back keeps what was typed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default)]
pub struct Access {
    pub mode: AccessMode,
    pub address: String,
    pub proxy: ProxyHost,
    pub proxy_device: String,
}

impl Access {
    fn parse(fields: Option<&Fields>, base: Self) -> Self {
        let Access {
            mode,
            address,
            proxy,
            proxy_device,
        } = base;
        Access {
            mode: pick(fields, "mode", mode),
            address: pick(fields, "address", address),
            proxy: pick(fields, "proxy", proxy),
            proxy_device: pick(fields, "proxy_device", proxy_device),
        }
    }
}

// The app's own server. Empty `data_dir`, `database_url` and `listen` mean the built-in choice.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(default)]
pub struct ServerSettings {
    pub set_up: bool,
    pub run_on_open: bool,
    pub confirm_quit: bool,
    pub name: String,
    pub port: u16,
    pub data_dir: String,
    pub access: Access,
    pub serve_web: bool,
    pub database_url: String,
    pub listen: String,
    pub relay: bool,
    pub extra: String,
}

impl Default for ServerSettings {
    fn default() -> Self {
        ServerSettings {
            set_up: false,
            run_on_open: true,
            confirm_quit: true,
            name: "My server".into(),
            port: 3470,
            data_dir: String::new(),
            access: Access::default(),
            serve_web: true,
            database_url: String::new(),
            listen: String::new(),
            relay: false,
            extra: String::new(),
        }
    }
}

impl ServerSettings {
    fn parse(fields: Option<&Fields>, base: Self) -> Self {
        let ServerSettings {
            set_up,
            run_on_open,
            confirm_quit,
            name,
            port,
            data_dir,
            access,
            serve_web,
            database_url,
            listen,
            relay,
            extra,
        } = base;
        ServerSettings {
            set_up: pick(fields, "set_up", set_up),
            run_on_open: pick(fields, "run_on_open", run_on_open),
            confirm_quit: pick(fields, "confirm_quit", confirm_quit),
            name: pick(fields, "name", name),
            port: pick(fields, "port", port),
            data_dir: pick(fields, "data_dir", data_dir),
            access: Access::parse(group(fields, "access"), access),
            serve_web: pick(fields, "serve_web", serve_web),
            database_url: pick(fields, "database_url", database_url),
            listen: pick(fields, "listen", listen),
            relay: pick(fields, "relay", relay),
            extra: pick(fields, "extra", extra),
        }
    }
}

// Shell settings the web app can't keep itself, because the shell needs them before the page
// loads or after it closes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(default)]
pub struct Settings {
    pub minimize_to_tray: bool,
    pub mute_notifications: bool,
    pub auto_update: bool,
    pub channel: Channel,
    pub boot: Boot,
    pub server: ServerSettings,
    pub resume_server: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            minimize_to_tray: false,
            mute_notifications: false,
            auto_update: false,
            channel: Channel::built(),
            boot: Boot::default(),
            server: ServerSettings::default(),
            resume_server: false,
        }
    }
}

#[derive(Serialize)]
struct Stored {
    version: u32,
    #[serde(flatten)]
    changed: Fields,
}

// What differs from `base`, or None when nothing does.
fn changed(value: Value, base: &Value) -> Option<Value> {
    match (value, base) {
        (Value::Object(fields), Value::Object(base)) => {
            let kept: Fields = fields
                .into_iter()
                .filter_map(|(key, value)| match base.get(&key) {
                    Some(base) => changed(value, base).map(|value| (key, value)),
                    None => Some((key, value)),
                })
                .collect();
            (!kept.is_empty()).then_some(Value::Object(kept))
        }
        (value, base) => (value != *base).then_some(value),
    }
}

// The file holds only what differs from this build's defaults, so a default that changes later
// reaches everyone who never chose otherwise. A set-up server is stored whole: other people's
// apps depend on its port and address, so no default may move them.
fn stored(settings: &Settings) -> serde_json::Result<Stored> {
    let defaults = serde_json::to_value(Settings::default())?;
    let mut fields = match changed(serde_json::to_value(settings)?, &defaults) {
        Some(Value::Object(fields)) => fields,
        _ => Fields::new(),
    };
    if settings.server.set_up {
        fields.insert("server".into(), serde_json::to_value(&settings.server)?);
    }
    Ok(Stored {
        version: VERSION,
        changed: fields,
    })
}

fn pick<T: DeserializeOwned>(fields: Option<&Fields>, key: &str, fallback: T) -> T {
    fields
        .and_then(|f| f.get(key))
        .and_then(|v| T::deserialize(v).ok())
        .unwrap_or(fallback)
}

fn group<'a>(fields: Option<&'a Fields>, key: &str) -> Option<&'a Fields> {
    fields.and_then(|f| f.get(key)).and_then(Value::as_object)
}

// Unknown or broken fields fall back to their defaults one by one.
pub fn parse(raw: &str) -> Settings {
    parse_over(raw, Settings::default())
}

fn parse_over(raw: &str, base: Settings) -> Settings {
    let Settings {
        minimize_to_tray,
        mute_notifications,
        auto_update,
        channel,
        boot,
        server,
        resume_server,
    } = base;
    let fields: Option<Fields> = serde_json::from_str(raw).ok();
    let fields = fields.as_ref();
    // Files from before the version field held `close_to_tray`. The old shell saved its default
    // (off) as well, so only a stored "on" is known to be a choice and carries over.
    let minimize_to_tray = if pick(fields, "version", 1) < VERSION {
        pick(fields, "close_to_tray", false) || minimize_to_tray
    } else {
        pick(fields, "minimize_to_tray", minimize_to_tray)
    };
    Settings {
        minimize_to_tray,
        mute_notifications: pick(fields, "mute_notifications", mute_notifications),
        auto_update: pick(fields, "auto_update", auto_update),
        channel: pick(fields, "channel", channel),
        boot: Boot::parse(group(fields, "boot"), boot),
        server: ServerSettings::parse(group(fields, "server"), server),
        resume_server: pick(fields, "resume_server", resume_server),
    }
}

// What the page sent, without the fields that belong to the shell's own commands: the server
// setup, the resume flag and the login entry. The page sends back the whole copy it read when it
// opened, which would otherwise undo what the shell wrote since.
pub fn from_page(current: &Settings, sent: Settings) -> Settings {
    let Settings {
        minimize_to_tray,
        mute_notifications,
        auto_update,
        channel,
        boot:
            Boot {
                on: _,
                client,
                hidden,
                server,
            },
        server: _,
        resume_server: _,
    } = sent;
    Settings {
        minimize_to_tray,
        mute_notifications,
        auto_update,
        channel,
        boot: Boot {
            on: current.boot.on,
            client,
            hidden,
            server,
        },
        server: current.server.clone(),
        resume_server: current.resume_server,
    }
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

pub fn load(dir: &Path) -> Settings {
    fs::read_to_string(path(dir))
        .map(|raw| parse(&raw))
        .unwrap_or_default()
}

// The file can hold the server's database address and secrets, so on Unix only its owner may
// read it. Windows keeps it under the user's own profile.
fn private_file(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

pub fn save(dir: &Path, settings: &Settings) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let body = stored(settings)
        .and_then(|stored| serde_json::to_string_pretty(&stored))
        .map_err(std::io::Error::other)?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    let _ = fs::remove_file(&tmp);
    {
        let mut file = private_file(&tmp)?;
        file.write_all(body.as_bytes())?;
        // On disk before the rename, so a power cut can't leave an empty file in its place.
        file.sync_all()?;
    }
    fs::rename(tmp, path(dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom() -> Settings {
        Settings {
            minimize_to_tray: true,
            mute_notifications: true,
            auto_update: true,
            channel: Channel::Weekly,
            boot: Boot {
                on: true,
                client: false,
                hidden: false,
                server: true,
            },
            server: ServerSettings {
                set_up: true,
                run_on_open: false,
                confirm_quit: false,
                name: "Home".into(),
                port: 4000,
                data_dir: "/home/a b/server".into(),
                access: Access {
                    mode: AccessMode::Https,
                    address: "https://chat.example.com".into(),
                    proxy: ProxyHost::Device,
                    proxy_device: "192.168.1.5".into(),
                },
                serve_web: false,
                database_url: "postgres://u:p@db/rchat".into(),
                listen: "0.0.0.0".into(),
                relay: true,
                extra: "MAX_UPLOAD_MIB=64\nGUESTS_ENABLED=false".into(),
            },
            resume_server: true,
        }
    }

    #[test]
    fn defaults() {
        assert_eq!(
            Settings::default(),
            Settings {
                minimize_to_tray: false,
                mute_notifications: false,
                auto_update: false,
                channel: Channel::built(),
                boot: Boot {
                    on: false,
                    client: true,
                    hidden: true,
                    server: false,
                },
                server: ServerSettings {
                    set_up: false,
                    run_on_open: true,
                    confirm_quit: true,
                    name: "My server".into(),
                    port: 3470,
                    data_dir: String::new(),
                    access: Access {
                        mode: AccessMode::Local,
                        address: String::new(),
                        proxy: ProxyHost::Local,
                        proxy_device: String::new(),
                    },
                    serve_web: true,
                    database_url: String::new(),
                    listen: String::new(),
                    relay: false,
                    extra: String::new(),
                },
                resume_server: false,
            }
        );
    }

    #[test]
    fn v1_close_to_tray_carries_over_when_on() {
        let s = parse(r#"{"close_to_tray":true,"auto_update":true,"channel":"weekly"}"#);
        assert_eq!(
            s,
            Settings {
                minimize_to_tray: true,
                auto_update: true,
                channel: Channel::Weekly,
                ..Settings::default()
            }
        );
    }

    // The old shell saved its defaults too, so a stored false says nothing about a choice.
    #[test]
    fn v1_close_to_tray_off_or_missing_takes_the_default() {
        for default in [false, true] {
            let base = Settings {
                minimize_to_tray: default,
                ..Settings::default()
            };
            for raw in [
                r#"{"close_to_tray":false,"auto_update":false,"channel":"stable"}"#,
                r#"{"auto_update":false,"channel":"stable"}"#,
                r#"{"close_to_tray":"yes"}"#,
                r#"{"close_to_tray":false,"minimize_to_tray":false}"#,
                "{}",
            ] {
                assert_eq!(
                    parse_over(raw, base.clone()).minimize_to_tray,
                    default,
                    "{raw}"
                );
            }
            let on = r#"{"close_to_tray":true}"#;
            assert!(parse_over(on, base).minimize_to_tray);
        }
    }

    #[test]
    fn v2_keeps_the_stored_choice() {
        for default in [false, true] {
            let base = Settings {
                minimize_to_tray: default,
                ..Settings::default()
            };
            let off = r#"{"version":2,"minimize_to_tray":false,"close_to_tray":true}"#;
            assert!(!parse_over(off, base.clone()).minimize_to_tray);
            let on = r#"{"version":2,"minimize_to_tray":true}"#;
            assert!(parse_over(on, base.clone()).minimize_to_tray);
            let missing = r#"{"version":2,"close_to_tray":true}"#;
            assert_eq!(parse_over(missing, base.clone()).minimize_to_tray, default);
            let newer = r#"{"version":3,"minimize_to_tray":true}"#;
            assert!(parse_over(newer, base).minimize_to_tray);
        }
    }

    #[test]
    fn parses_every_v2_field() {
        let raw = r#"{
            "version": 2,
            "minimize_to_tray": true,
            "mute_notifications": true,
            "auto_update": true,
            "channel": "weekly",
            "boot": {"on": true, "client": false, "hidden": false, "server": true},
            "server": {
                "set_up": true,
                "run_on_open": false,
                "confirm_quit": false,
                "name": "Home",
                "port": 4000,
                "data_dir": "/home/a b/server",
                "access": {
                    "mode": "https",
                    "address": "https://chat.example.com",
                    "proxy": "device",
                    "proxy_device": "192.168.1.5"
                },
                "serve_web": false,
                "database_url": "postgres://u:p@db/rchat",
                "listen": "0.0.0.0",
                "relay": true,
                "extra": "MAX_UPLOAD_MIB=64\nGUESTS_ENABLED=false"
            },
            "resume_server": true
        }"#;
        assert_eq!(parse(raw), custom());
    }

    #[test]
    fn bad_input_falls_back_per_field() {
        assert_eq!(parse("not json"), Settings::default());
        assert_eq!(parse("[1,2]"), Settings::default());
        let raw = r#"{
            "version": 2,
            "minimize_to_tray": "yes",
            "mute_notifications": true,
            "auto_update": 1,
            "channel": "nightly",
            "boot": {"on": true, "client": "no", "hidden": false, "server": null},
            "server": {
                "set_up": true,
                "run_on_open": "later",
                "name": 7,
                "port": 70000,
                "data_dir": ["x"],
                "access": {"mode": "lan", "address": "https://a.example", "proxy": 5},
                "serve_web": false,
                "extra": {}
            },
            "resume_server": "true"
        }"#;
        assert_eq!(
            parse(raw),
            Settings {
                mute_notifications: true,
                boot: Boot {
                    on: true,
                    hidden: false,
                    ..Boot::default()
                },
                server: ServerSettings {
                    set_up: true,
                    access: Access {
                        address: "https://a.example".into(),
                        ..Access::default()
                    },
                    serve_web: false,
                    ..ServerSettings::default()
                },
                ..Settings::default()
            }
        );
        for raw in [
            r#"{"version":2,"auto_update":true,"boot":"on","server":[1]}"#,
            r#"{"version":2,"auto_update":true,"server":{"port":"3470","access":"https"}}"#,
            r#"{"version":2,"auto_update":true,"server":{"port":3470.5}}"#,
            r#"{"version":"two","auto_update":true}"#,
        ] {
            assert_eq!(
                parse(raw),
                Settings {
                    auto_update: true,
                    ..Settings::default()
                },
                "{raw}"
            );
        }
    }

    // What the page sends: missing fields take their defaults.
    #[test]
    fn partial_objects_deserialize() {
        let s: Settings = serde_json::from_str(
            r#"{"auto_update":true,"boot":{"on":true},"server":{"port":4000}}"#,
        )
        .unwrap();
        assert_eq!(
            s,
            Settings {
                auto_update: true,
                boot: Boot {
                    on: true,
                    ..Boot::default()
                },
                server: ServerSettings {
                    port: 4000,
                    ..ServerSettings::default()
                },
                ..Settings::default()
            }
        );
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("rchat-desktop-test-{}", std::process::id()));
        let want = custom();
        save(&dir, &want).unwrap();
        assert_eq!(load(&dir), want);
        let stored: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(path(&dir)).unwrap()).unwrap();
        assert_eq!(stored["version"], 2);
        assert_eq!(stored["minimize_to_tray"], true);
        assert_eq!(stored["server"]["access"]["mode"], "https");
        assert!(stored.get("close_to_tray").is_none());
        let left: Vec<_> = fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(left.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(load(&dir), Settings::default());
    }

    #[test]
    fn an_upgraded_file_is_rewritten_as_v2() {
        let dir =
            std::env::temp_dir().join(format!("rchat-desktop-upgrade-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            path(&dir),
            r#"{"close_to_tray":true,"auto_update":false,"channel":"weekly"}"#,
        )
        .unwrap();
        let loaded = load(&dir);
        assert!(loaded.minimize_to_tray);
        save(&dir, &loaded).unwrap();
        assert_eq!(load(&dir), loaded);
        assert_eq!(load(&dir).channel, Channel::Weekly);
        fs::remove_dir_all(&dir).unwrap();
    }

    fn saved(name: &str, settings: &Settings) -> String {
        let dir = std::env::temp_dir().join(format!("rchat-desktop-{name}-{}", std::process::id()));
        save(&dir, settings).unwrap();
        let text = fs::read_to_string(path(&dir)).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        text
    }

    fn json(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap()
    }

    fn other_channel() -> Channel {
        match Channel::built() {
            Channel::Stable => Channel::Weekly,
            Channel::Weekly => Channel::Stable,
        }
    }

    // Defaults a later build might ship.
    fn later_defaults() -> Settings {
        Settings {
            minimize_to_tray: true,
            auto_update: true,
            boot: Boot {
                hidden: false,
                ..Boot::default()
            },
            server: ServerSettings {
                name: "Server".into(),
                port: 5000,
                serve_web: false,
                access: Access {
                    mode: AccessMode::Https,
                    ..Access::default()
                },
                ..ServerSettings::default()
            },
            ..Settings::default()
        }
    }

    #[test]
    fn an_unchanged_file_holds_only_the_version() {
        let text = saved("unchanged", &Settings::default());
        assert_eq!(json(&text), serde_json::json!({"version": 2}));
        assert_eq!(parse(&text), Settings::default());
    }

    #[test]
    fn a_saved_file_follows_later_defaults() {
        let text = saved("follows", &Settings::default());
        assert_eq!(parse_over(&text, later_defaults()), later_defaults());
        let upgraded = parse(r#"{"close_to_tray":false,"auto_update":false,"channel":"stable"}"#);
        let text = saved("follows-v1", &upgraded);
        assert!(parse_over(&text, later_defaults()).minimize_to_tray);
    }

    #[test]
    fn chosen_values_survive_later_defaults() {
        let chosen = Settings {
            mute_notifications: true,
            channel: other_channel(),
            boot: Boot {
                client: false,
                ..Boot::default()
            },
            server: ServerSettings {
                name: "Home".into(),
                port: 4000,
                ..ServerSettings::default()
            },
            ..Settings::default()
        };
        let text = saved("chosen", &chosen);
        assert_eq!(
            json(&text),
            serde_json::json!({
                "version": 2,
                "mute_notifications": true,
                "channel": other_channel(),
                "boot": {"client": false},
                "server": {"name": "Home", "port": 4000},
            })
        );
        assert_eq!(parse(&text), chosen);
        let later = later_defaults();
        assert_eq!(
            parse_over(&text, later.clone()),
            Settings {
                mute_notifications: true,
                channel: other_channel(),
                boot: Boot {
                    client: false,
                    ..later.boot
                },
                server: ServerSettings {
                    name: "Home".into(),
                    port: 4000,
                    ..later.server.clone()
                },
                ..later
            }
        );
    }

    // Other people's apps depend on a running server's port and address.
    #[test]
    fn a_set_up_server_is_stored_whole() {
        let set_up = Settings {
            server: ServerSettings {
                set_up: true,
                ..ServerSettings::default()
            },
            ..Settings::default()
        };
        let text = saved("server", &set_up);
        assert_eq!(
            json(&text),
            serde_json::json!({
                "version": 2,
                "server": serde_json::to_value(&set_up.server).unwrap(),
            })
        );
        assert_eq!(json(&text)["server"].as_object().unwrap().len(), 12);
        assert_eq!(
            json(&text)["server"]["access"].as_object().unwrap().len(),
            4
        );
        let read = parse_over(&text, later_defaults());
        assert_eq!(read.server, set_up.server);
        assert!(read.minimize_to_tray);
    }

    // The file can hold the server's database address and secrets.
    #[cfg(unix)]
    #[test]
    fn only_the_owner_can_read_the_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("rchat-desktop-mode-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let stale = dir.join(format!("{FILE}.tmp"));
        fs::write(&stale, "left by a crash").unwrap();
        fs::set_permissions(&stale, fs::Permissions::from_mode(0o644)).unwrap();
        save(&dir, &custom()).unwrap();
        let mode = fs::metadata(path(&dir)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(load(&dir), custom());
        assert!(!stale.exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_page_changes_only_its_own_choices() {
        let current = Settings::default();
        let sent = custom();
        assert_eq!(
            from_page(&current, sent.clone()),
            Settings {
                minimize_to_tray: sent.minimize_to_tray,
                mute_notifications: sent.mute_notifications,
                auto_update: sent.auto_update,
                channel: sent.channel,
                boot: Boot {
                    on: current.boot.on,
                    ..sent.boot
                },
                server: current.server.clone(),
                resume_server: current.resume_server,
            }
        );
        assert_eq!(from_page(&sent, sent.clone()), sent);
    }

    #[test]
    fn the_page_cannot_write_shell_fields() {
        let current = custom();
        let server = |change: fn(&mut ServerSettings)| {
            let mut sent = current.clone();
            change(&mut sent.server);
            sent
        };
        let tries = [
            server(|s| s.set_up = false),
            server(|s| s.run_on_open = true),
            server(|s| s.confirm_quit = true),
            server(|s| s.name = "Mine".into()),
            server(|s| s.port = 0),
            server(|s| s.data_dir = "../../x".into()),
            server(|s| s.access.mode = AccessMode::Local),
            server(|s| s.access.address = "https://evil.example".into()),
            server(|s| s.access.proxy = ProxyHost::Local),
            server(|s| s.access.proxy_device = "10.0.0.1".into()),
            server(|s| s.serve_web = true),
            server(|s| s.database_url = String::new()),
            server(|s| s.listen = "::".into()),
            server(|s| s.relay = false),
            server(|s| s.extra = "ALLOWED_HOSTS=*".into()),
            Settings {
                resume_server: false,
                ..current.clone()
            },
            Settings {
                boot: Boot {
                    on: false,
                    ..current.boot
                },
                ..current.clone()
            },
        ];
        for sent in tries {
            assert_ne!(sent, current);
            assert_eq!(from_page(&current, sent), current);
        }
        let fresh = Settings::default();
        let grab = Settings {
            boot: Boot {
                on: true,
                ..fresh.boot
            },
            server: ServerSettings {
                set_up: true,
                listen: "0.0.0.0".into(),
                ..ServerSettings::default()
            },
            resume_server: true,
            ..fresh.clone()
        };
        assert_eq!(from_page(&fresh, grab), fresh);
        let empty: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(from_page(&current, empty).server, current.server);
    }

    // The page keeps the copy it read when it opened and sends all of it back on each change.
    #[test]
    fn a_stale_page_copy_keeps_what_the_shell_wrote() {
        let copy = Settings::default();
        let current = Settings {
            boot: Boot {
                on: true,
                ..copy.boot
            },
            server: custom().server,
            resume_server: true,
            ..copy.clone()
        };
        let sent = Settings {
            auto_update: true,
            ..copy
        };
        assert_eq!(
            from_page(&current, sent),
            Settings {
                auto_update: true,
                ..current.clone()
            }
        );
    }

    #[test]
    fn channels_have_endpoints() {
        assert!(
            Channel::Stable
                .endpoint()
                .ends_with("/releases/latest/download/latest.json")
        );
        assert!(
            Channel::Weekly
                .endpoint()
                .ends_with("/releases/download/weekly/latest.json")
        );
    }
}
