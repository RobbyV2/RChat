// The desktop settings as the settings the server reads, under the names of its env file.

use crate::server::{dirs, ports};
use crate::settings::{AccessMode, ProxyHost, ServerSettings};
use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

pub type Env = BTreeMap<String, String>;

pub const DB_FILE: &str = "rchat.db";
const LOOPBACK: &str = "127.0.0.1";
const EVERY_ADDRESS: &str = "0.0.0.0";
const NAME_MAX: usize = 64;
const BAD_ADDRESS: &str = "Enter an address like https://chat.example.com";

// Settings the form owns, each with what to do instead of naming it in the extra settings.
const MANAGED: [(&str, &str); 9] = [
    ("APP_MODE", "APP_MODE can't be changed here."),
    ("HOST", "Set the listen address in the form above."),
    ("SERVER_PORT", "Set the port in the form above."),
    ("DATABASE_URL", "Set the database in the form above."),
    ("INSTANCE_NAME", "Set the name in the form above."),
    ("PUBLIC_URL", "Set the address under Access above."),
    ("TRUSTED_PROXIES", "Set the proxy under Access above."),
    ("PEERJS_BUILTIN", "PEERJS_BUILTIN can't be changed here."),
    ("RELAY_ENABLED", "Use the relay switch above."),
];

fn plain(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/' | b':')
}

// The address of the SQLite database in `dir`, with forward slashes and everything else that
// means something in an address percent-encoded (spaces, `?`, `#`, `%`). There is no `//`, so a
// URL parser never reads a drive letter as a host.
pub fn sqlite_url(dir: &str) -> String {
    let dir = dir.replace('\\', "/");
    let path: String = dir
        .trim_end_matches('/')
        .bytes()
        .map(|byte| match plain(byte) {
            true => char::from(byte).to_string(),
            false => format!("%{byte:02X}"),
        })
        .collect();
    format!("sqlite:{path}/{DB_FILE}?mode=rwc")
}

pub fn is_postgres(settings: &ServerSettings) -> bool {
    !settings.database_url.trim().is_empty()
}

fn is_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// `KEY=value` lines. Empty lines and lines that start with `#` are skipped.
pub fn parse_extra(text: &str) -> Result<Vec<(String, String)>, String> {
    text.lines()
        .enumerate()
        .map(|(at, line)| (at + 1, line.trim()))
        .filter(|(_, line)| !line.is_empty() && !line.starts_with('#'))
        .map(|(n, line)| {
            let (key, value) = line
                .split_once('=')
                .map(|(key, value)| (key.trim().to_ascii_uppercase(), value.trim()))
                .filter(|(key, _)| is_key(key))
                .ok_or_else(|| format!("Line {n} is not KEY=value."))?;
            match MANAGED.iter().find(|(managed, _)| *managed == key) {
                Some((_, advice)) => Err(format!("Line {n}: {advice}")),
                None => Ok((key, value.to_string())),
            }
        })
        .collect()
}

fn is_authority(text: &str) -> bool {
    let (host, port) = match text.rsplit_once(':') {
        Some((host, port)) if !port.contains(']') => (host, Some(port)),
        _ => (text, None),
    };
    let named = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    let bracketed = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .is_some_and(|h| h.parse::<std::net::Ipv6Addr>().is_ok());
    (named || bracketed) && port.is_none_or(|p| p.parse::<u16>().is_ok())
}

// The origin of an HTTPS address, without a trailing slash.
pub fn https_origin(address: &str) -> Result<String, String> {
    let address = address.trim().to_ascii_lowercase();
    address
        .strip_prefix("https://")
        .map(|rest| rest.strip_suffix('/').unwrap_or(rest))
        .filter(|authority| is_authority(authority))
        .map(|authority| format!("https://{authority}"))
        .ok_or_else(|| BAD_ADDRESS.to_string())
}

// An address or a range of addresses (`192.168.1.0/24`).
fn is_proxy(text: &str) -> bool {
    let (address, bits) = match text.split_once('/') {
        Some((address, bits)) => (address, Some(bits)),
        None => (text, None),
    };
    address.parse::<IpAddr>().is_ok() && bits.is_none_or(|b| b.parse::<u8>().is_ok())
}

pub fn listen_host(settings: &ServerSettings) -> String {
    let ServerSettings { listen, access, .. } = settings;
    match (listen.trim(), access.mode, access.proxy) {
        ("", AccessMode::Https, ProxyHost::Device) => EVERY_ADDRESS.into(),
        ("", AccessMode::Local | AccessMode::Https, _) => LOOPBACK.into(),
        (listen, _, _) => listen.into(),
    }
}

// Where this computer reaches a server listening on `addr`.
pub fn own_origin(addr: SocketAddr) -> String {
    let ip = match addr.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    format!("http://{}", SocketAddr::new(ip, addr.port()))
}

// Where this app's own client reaches the server listening on `addr`.
pub fn client_url(settings: &ServerSettings, addr: SocketAddr) -> String {
    match settings.access.mode {
        AccessMode::Local => own_origin(addr),
        AccessMode::Https => {
            https_origin(&settings.access.address).unwrap_or_else(|_| own_origin(addr))
        }
    }
}

fn check(ok: bool, text: &str) -> Result<(), String> {
    ok.then_some(()).ok_or_else(|| text.to_string())
}

pub fn validate(settings: &ServerSettings) -> Result<(), String> {
    let ServerSettings {
        set_up: _,
        run_on_open: _,
        confirm_quit: _,
        name,
        port,
        data_dir,
        access,
        serve_web: _,
        database_url,
        listen,
        relay: _,
        extra,
    } = settings;
    ports::validate(*port)?;
    let name = name.trim();
    check(!name.is_empty(), "Give the server a name.")?;
    check(
        name.chars().count() <= NAME_MAX,
        "The name can be up to 64 characters.",
    )?;
    check(
        !name.chars().any(char::is_control),
        "The name can't hold line breaks.",
    )?;
    dirs::validate(data_dir)?;
    let listen = listen.trim();
    check(
        listen.is_empty() || listen.parse::<IpAddr>().is_ok(),
        "The listen address must be an IP address.",
    )?;
    let database_url = database_url.trim();
    check(
        database_url.is_empty()
            || ["postgres://", "postgresql://"]
                .iter()
                .any(|scheme| database_url.starts_with(scheme)),
        "The database URL must start with postgres://",
    )?;
    parse_extra(extra)?;
    match access.mode {
        AccessMode::Local => Ok(()),
        AccessMode::Https => {
            https_origin(&access.address)?;
            match access.proxy {
                ProxyHost::Local => Ok(()),
                ProxyHost::Device => check(
                    is_proxy(access.proxy_device.trim()),
                    "Enter the proxy device's IP address.",
                ),
            }
        }
    }
}

// Everything the server is started with. `dir` is the data folder.
pub fn env_map(settings: &ServerSettings, dir: &str) -> Result<Env, String> {
    validate(settings)?;
    unchecked_env(settings, dir)
}

// `env_map` for settings that passed `validate`: it reads nothing from the disk.
pub fn unchecked_env(settings: &ServerSettings, dir: &str) -> Result<Env, String> {
    let database = match settings.database_url.trim() {
        "" => sqlite_url(dir),
        url => url.to_string(),
    };
    let mut env: Env = [
        ("APP_MODE", "api-only".to_string()),
        ("HOST", listen_host(settings)),
        ("SERVER_PORT", settings.port.to_string()),
        ("DATABASE_URL", database),
        ("INSTANCE_NAME", settings.name.trim().to_string()),
        ("PEERJS_BUILTIN", "true".to_string()),
        ("RELAY_ENABLED", settings.relay.to_string()),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value))
    .collect();
    if settings.access.mode == AccessMode::Https {
        let trusted = match settings.access.proxy {
            ProxyHost::Local => "127.0.0.1,::1".to_string(),
            ProxyHost::Device => settings.access.proxy_device.trim().to_string(),
        };
        env.insert("PUBLIC_URL".into(), https_origin(&settings.access.address)?);
        env.insert("TRUSTED_PROXIES".into(), trusted);
    }
    env.extend(parse_extra(&settings.extra)?);
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Access;

    const DIR: &str = "/data";

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn https(proxy: ProxyHost, proxy_device: &str) -> ServerSettings {
        ServerSettings {
            access: Access {
                mode: AccessMode::Https,
                address: "https://chat.example.com/".into(),
                proxy,
                proxy_device: proxy_device.into(),
            },
            ..ServerSettings::default()
        }
    }

    fn with_extra(extra: &str) -> ServerSettings {
        ServerSettings {
            extra: extra.into(),
            ..ServerSettings::default()
        }
    }

    const LOCAL: [(&str, &str); 7] = [
        ("APP_MODE", "api-only"),
        ("DATABASE_URL", "sqlite:/data/rchat.db?mode=rwc"),
        ("HOST", "127.0.0.1"),
        ("INSTANCE_NAME", "My server"),
        ("PEERJS_BUILTIN", "true"),
        ("RELAY_ENABLED", "false"),
        ("SERVER_PORT", "3470"),
    ];

    fn local_with(more: &[(&str, &str)]) -> Env {
        let mut all = env(&LOCAL);
        all.extend(env(more));
        all
    }

    #[test]
    fn only_this_computer_listens_on_loopback_with_no_public_address() {
        assert_eq!(env_map(&ServerSettings::default(), DIR), Ok(env(&LOCAL)));
    }

    #[test]
    fn a_typed_address_is_unused_outside_the_https_mode() {
        let mut settings = https(ProxyHost::Device, "192.168.1.5");
        settings.access.mode = AccessMode::Local;
        assert_eq!(env_map(&settings, DIR), Ok(env(&LOCAL)));
        assert_eq!(
            client_url(&settings, at("127.0.0.1")),
            "http://127.0.0.1:3470"
        );
    }

    fn at(ip: &str) -> SocketAddr {
        SocketAddr::new(ip.parse().expect("ip"), 3470)
    }

    #[test]
    fn this_computer_reaches_the_address_the_server_listens_on() {
        for (listen, origin) in [
            ("127.0.0.1", "http://127.0.0.1:3470"),
            ("127.0.0.2", "http://127.0.0.2:3470"),
            ("192.168.1.5", "http://192.168.1.5:3470"),
            ("0.0.0.0", "http://127.0.0.1:3470"),
            ("::1", "http://[::1]:3470"),
            ("::", "http://[::1]:3470"),
            ("fe80::1", "http://[fe80::1]:3470"),
        ] {
            assert_eq!(own_origin(at(listen)), origin, "{listen}");
            let settings = ServerSettings {
                listen: listen.into(),
                ..ServerSettings::default()
            };
            assert_eq!(client_url(&settings, at(listen)), origin, "{listen}");
        }
    }

    #[test]
    fn an_https_address_with_the_proxy_here_trusts_loopback() {
        let settings = https(ProxyHost::Local, "192.168.1.5");
        assert_eq!(
            env_map(&settings, DIR),
            Ok(local_with(&[
                ("PUBLIC_URL", "https://chat.example.com"),
                ("TRUSTED_PROXIES", "127.0.0.1,::1"),
            ]))
        );
        assert_eq!(
            client_url(&settings, at("127.0.0.1")),
            "https://chat.example.com"
        );
    }

    #[test]
    fn a_proxy_on_another_device_is_trusted_and_can_reach_the_port() {
        assert_eq!(
            env_map(&https(ProxyHost::Device, " 192.168.1.5 "), DIR),
            Ok(local_with(&[
                ("HOST", "0.0.0.0"),
                ("PUBLIC_URL", "https://chat.example.com"),
                ("TRUSTED_PROXIES", "192.168.1.5"),
            ]))
        );
    }

    #[test]
    fn the_listen_address_wins() {
        let local = ServerSettings {
            listen: " 0.0.0.0 ".into(),
            ..ServerSettings::default()
        };
        assert_eq!(env_map(&local, DIR), Ok(local_with(&[("HOST", "0.0.0.0")])));
        let device = ServerSettings {
            listen: "10.0.0.2".into(),
            ..https(ProxyHost::Device, "192.168.1.5")
        };
        assert_eq!(env_map(&device, DIR).expect("env")["HOST"], "10.0.0.2");
    }

    #[test]
    fn the_form_fields_reach_the_server() {
        let settings = ServerSettings {
            name: "Home".into(),
            port: 4000,
            database_url: " postgres://u:p@db/rchat ".into(),
            relay: true,
            ..ServerSettings::default()
        };
        assert!(is_postgres(&settings));
        assert!(!is_postgres(&ServerSettings::default()));
        assert_eq!(
            env_map(&settings, DIR),
            Ok(local_with(&[
                ("DATABASE_URL", "postgres://u:p@db/rchat"),
                ("INSTANCE_NAME", "Home"),
                ("RELAY_ENABLED", "true"),
                ("SERVER_PORT", "4000"),
            ]))
        );
    }

    #[test]
    fn extra_lines_are_added() {
        let extra =
            "MAX_UPLOAD_MIB=64\n\n  # a note\r\nguests_enabled = false \nWEBHOOK_ALLOWED_HOSTS=a=b";
        assert_eq!(
            parse_extra(extra),
            Ok(vec![
                ("MAX_UPLOAD_MIB".to_string(), "64".to_string()),
                ("GUESTS_ENABLED".to_string(), "false".to_string()),
                ("WEBHOOK_ALLOWED_HOSTS".to_string(), "a=b".to_string()),
            ])
        );
        assert_eq!(
            env_map(&with_extra(extra), DIR),
            Ok(local_with(&[
                ("MAX_UPLOAD_MIB", "64"),
                ("GUESTS_ENABLED", "false"),
                ("WEBHOOK_ALLOWED_HOSTS", "a=b"),
            ]))
        );
        assert_eq!(parse_extra(""), Ok(Vec::new()));
    }

    #[test]
    fn a_setting_the_form_owns_is_refused_in_the_extra_lines() {
        assert_eq!(
            parse_extra("MAX_UPLOAD_MIB=64\nSERVER_PORT=1"),
            Err("Line 2: Set the port in the form above.".to_string())
        );
        assert_eq!(
            parse_extra("server_port=1"),
            Err("Line 1: Set the port in the form above.".to_string())
        );
        for (key, advice) in MANAGED {
            let line = format!("{key}=x");
            assert_eq!(parse_extra(&line), Err(format!("Line 1: {advice}")));
            assert_eq!(
                env_map(&with_extra(&line), DIR),
                Err(format!("Line 1: {advice}"))
            );
        }
    }

    #[test]
    fn a_line_that_is_no_setting_is_refused() {
        for bad in ["nonsense", "=x", "A B=1", "1A=2", "A-B=1", "KEY"] {
            assert_eq!(
                parse_extra(&format!("OK=1\n{bad}")),
                Err("Line 2 is not KEY=value.".to_string()),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_database_address_encodes_the_folder() {
        for (dir, url) in [
            ("/data", "sqlite:/data/rchat.db?mode=rwc"),
            ("/data/", "sqlite:/data/rchat.db?mode=rwc"),
            ("/home/a b/x", "sqlite:/home/a%20b/x/rchat.db?mode=rwc"),
            (
                r"C:\Users\A B\x",
                "sqlite:C:/Users/A%20B/x/rchat.db?mode=rwc",
            ),
            (
                r"C:\Users\A B\x\",
                "sqlite:C:/Users/A%20B/x/rchat.db?mode=rwc",
            ),
            (
                "/x/50%?#&=+",
                "sqlite:/x/50%25%3F%23%26%3D%2B/rchat.db?mode=rwc",
            ),
            ("/x/caf\u{e9}", "sqlite:/x/caf%C3%A9/rchat.db?mode=rwc"),
            (
                "/Users/a/Library/Application Support/io.github.robbyv2.rchat/server",
                "sqlite:/Users/a/Library/Application%20Support/io.github.robbyv2.rchat/server/rchat.db?mode=rwc",
            ),
        ] {
            assert_eq!(sqlite_url(dir), url, "{dir}");
            assert_eq!(url::Url::parse(url).expect("parses").as_str(), url, "{dir}");
        }
    }

    #[test]
    fn an_https_address_is_an_origin() {
        for (typed, origin) in [
            ("https://chat.example.com", "https://chat.example.com"),
            (" https://chat.example.com/ ", "https://chat.example.com"),
            (
                "HTTPS://Chat.Example.com:8443",
                "https://chat.example.com:8443",
            ),
            ("https://[2001:db8::1]:8443/", "https://[2001:db8::1]:8443"),
        ] {
            assert_eq!(https_origin(typed), Ok(origin.to_string()), "{typed}");
        }
        for bad in [
            "",
            "chat.example.com",
            "http://chat.example.com",
            "https://",
            "https:///",
            "https://chat.example.com/path",
            "https://chat.example.com?x=1",
            "https://user@chat.example.com",
            "https://chat example.com",
            "https://chat.example.com:port",
        ] {
            assert_eq!(
                https_origin(bad),
                Err("Enter an address like https://chat.example.com".to_string()),
                "{bad}"
            );
        }
    }

    #[test]
    fn settings_are_checked_before_they_are_saved() {
        let ok = ServerSettings::default();
        assert_eq!(validate(&ok), Ok(()));
        assert_eq!(
            validate(&https(ProxyHost::Device, "192.168.1.0/24")),
            Ok(())
        );
        let refused = |change: fn(&mut ServerSettings), text: &str| {
            let mut settings = ServerSettings::default();
            change(&mut settings);
            assert_eq!(validate(&settings), Err(text.to_string()));
            assert_eq!(env_map(&settings, DIR), Err(text.to_string()));
        };
        refused(|s| s.port = 80, "Pick a port from 1024 to 65535.");
        refused(|s| s.name = "  ".into(), "Give the server a name.");
        refused(
            |s| s.name = "n".repeat(65),
            "The name can be up to 64 characters.",
        );
        refused(
            |s| s.name = "two\nlines".into(),
            "The name can't hold line breaks.",
        );
        refused(
            |s| s.data_dir = "relative".into(),
            "The data folder must be a full path.",
        );
        refused(
            |s| s.listen = "everywhere".into(),
            "The listen address must be an IP address.",
        );
        refused(
            |s| s.database_url = "mysql://db/x".into(),
            "The database URL must start with postgres://",
        );
        refused(|s| s.extra = "PORT".into(), "Line 1 is not KEY=value.");
        refused(
            |s| {
                s.access.mode = AccessMode::Https;
                s.access.address = "http://chat.example.com".into();
            },
            "Enter an address like https://chat.example.com",
        );
        refused(
            |s| {
                s.access = Access {
                    mode: AccessMode::Https,
                    address: "https://chat.example.com".into(),
                    proxy: ProxyHost::Device,
                    proxy_device: "the router".into(),
                };
            },
            "Enter the proxy device's IP address.",
        );
    }

    #[test]
    fn unused_access_fields_are_not_checked() {
        let mut settings = https(ProxyHost::Local, "the router");
        assert_eq!(validate(&settings), Ok(()));
        settings.access.mode = AccessMode::Local;
        settings.access.address = "not an address".into();
        assert_eq!(validate(&settings), Ok(()));
    }
}
