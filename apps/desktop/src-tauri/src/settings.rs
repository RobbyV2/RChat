use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const FILE: &str = "desktop.json";

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
    #[cfg_attr(mobile, allow(dead_code))]
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

// Shell settings the web app can't keep itself, because the shell needs them before the page
// loads or after it closes.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    pub close_to_tray: bool,
    pub auto_update: bool,
    pub channel: Channel,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            close_to_tray: false,
            auto_update: false,
            channel: Channel::built(),
        }
    }
}

// Unknown or broken fields fall back to their defaults one by one.
pub fn parse(raw: &str) -> Settings {
    let Settings {
        close_to_tray,
        auto_update,
        channel,
    } = Settings::default();
    let fields: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(raw).unwrap_or_default();
    let flag = |key: &str| fields.get(key).and_then(serde_json::Value::as_bool);
    Settings {
        close_to_tray: flag("close_to_tray").unwrap_or(close_to_tray),
        auto_update: flag("auto_update").unwrap_or(auto_update),
        channel: fields
            .get("channel")
            .and_then(|v| Channel::deserialize(v).ok())
            .unwrap_or(channel),
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

pub fn save(dir: &Path, settings: &Settings) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let body = serde_json::to_string_pretty(settings).map_err(std::io::Error::other)?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    fs::write(&tmp, body)?;
    fs::rename(tmp, path(dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_settings() {
        let s = parse(r#"{"close_to_tray":true,"auto_update":true,"channel":"weekly"}"#);
        assert_eq!(
            s,
            Settings {
                close_to_tray: true,
                auto_update: true,
                channel: Channel::Weekly
            }
        );
    }

    #[test]
    fn bad_input_falls_back_per_field() {
        assert_eq!(parse("not json"), Settings::default());
        assert_eq!(parse("[1,2]"), Settings::default());
        let s = parse(r#"{"close_to_tray":"yes","auto_update":true,"channel":"nightly"}"#);
        assert_eq!(
            s,
            Settings {
                close_to_tray: false,
                auto_update: true,
                channel: Channel::built()
            }
        );
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("rchat-desktop-test-{}", std::process::id()));
        let want = Settings {
            close_to_tray: true,
            auto_update: false,
            channel: Channel::Weekly,
        };
        save(&dir, &want).unwrap();
        assert_eq!(load(&dir), want);
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(load(&dir), Settings::default());
    }
}
