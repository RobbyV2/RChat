// What the settings page sends to change the server's setup.

use crate::server::env;
use crate::settings::{Access, ServerSettings};
use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Form {
    pub set_up: bool,
    pub run_on_open: bool,
    pub confirm_quit: bool,
    pub name: String,
    pub port: u16,
    pub data_dir: String,
    pub access: Access,
    pub serve_web: bool,
    pub listen: String,
    pub relay: bool,
    // The page never holds the database address or the extra settings: it reads them blank, each
    // with a flag that says whether one is set. A value sent back replaces the stored one. A
    // blank one keeps it, unless its flag comes back off: that clears it.
    #[serde(default)]
    pub database_url: String,
    #[serde(default)]
    pub database_url_set: Option<bool>,
    #[serde(default)]
    pub extra: String,
    #[serde(default)]
    pub extra_set: Option<bool>,
}

fn secret(sent: String, set: Option<bool>, stored: &str) -> String {
    match (sent.trim().is_empty(), set) {
        (false, _) => sent,
        (true, Some(false)) => String::new(),
        (true, Some(true) | None) => stored.to_string(),
    }
}

impl Form {
    // The settings to save, or what is wrong with the form. A set-up server keeps its data
    // folder (moving it also moves the data) and stays set up (removing it also stops it). A
    // server set up with no folder named gets `built_in`, so it stays where its data is.
    pub fn apply(
        self,
        current: &ServerSettings,
        built_in: &Path,
    ) -> Result<ServerSettings, String> {
        let Form {
            set_up,
            run_on_open,
            confirm_quit,
            name,
            port,
            data_dir,
            access,
            serve_web,
            listen,
            relay,
            database_url,
            database_url_set,
            extra,
            extra_set,
        } = self;
        let set_up = set_up || current.set_up;
        let data_dir = match current.set_up {
            true => current.data_dir.trim().to_string(),
            false => data_dir.trim().to_string(),
        };
        let next = ServerSettings {
            set_up,
            run_on_open,
            confirm_quit,
            name: name.trim().to_string(),
            port,
            data_dir: match (set_up, data_dir.is_empty()) {
                (true, true) => built_in.display().to_string(),
                _ => data_dir,
            },
            access,
            serve_web,
            database_url: secret(database_url, database_url_set, &current.database_url)
                .trim()
                .to_string(),
            listen: listen.trim().to_string(),
            relay,
            extra: secret(extra, extra_set, &current.extra),
        };
        env::validate(&next)?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{self, AccessMode, ProxyHost, Settings};

    // A full path on every system.
    fn folder(name: &str) -> String {
        std::env::temp_dir().join(name).display().to_string()
    }

    fn built_in() -> std::path::PathBuf {
        std::env::temp_dir().join("built in")
    }

    fn stored() -> ServerSettings {
        ServerSettings {
            set_up: true,
            data_dir: folder("kept"),
            database_url: "postgres://u:secret@db/rchat".into(),
            extra: "SECRET_KEY=hunter2".into(),
            ..ServerSettings::default()
        }
    }

    // What the page holds after it read the settings: the two secrets are blank.
    fn read(settings: &ServerSettings) -> serde_json::Value {
        let all = Settings {
            server: settings.clone(),
            ..Settings::default()
        };
        settings::for_page(&all)["server"].clone()
    }

    fn form(page: serde_json::Value) -> Form {
        serde_json::from_value(page).expect("form")
    }

    #[test]
    fn a_form_sent_back_as_read_changes_nothing() {
        let current = stored();
        assert_eq!(
            form(read(&current)).apply(&current, &built_in()),
            Ok(current)
        );
    }

    #[test]
    fn blank_secrets_from_the_page_are_not_values() {
        let current = stored();
        let mut page = read(&current);
        assert_eq!(page["database_url"], "");
        assert_eq!(page["extra"], "");
        page["name"] = "Home".into();
        let saved = form(page.clone())
            .apply(&current, &built_in())
            .expect("saved");
        assert_eq!(saved.name, "Home");
        assert_eq!(saved.database_url, current.database_url);
        assert_eq!(saved.extra, current.extra);
        for key in ["database_url", "database_url_set", "extra", "extra_set"] {
            page.as_object_mut().expect("object").remove(key);
        }
        assert_eq!(form(page).apply(&current, &built_in()), Ok(saved));
    }

    #[test]
    fn a_sent_secret_replaces_the_stored_one() {
        let current = stored();
        let mut page = read(&current);
        page["database_url"] = " postgres://u:new@db/rchat ".into();
        page["extra"] = "MAX_UPLOAD_MIB=64".into();
        let saved = form(page).apply(&current, &built_in()).expect("saved");
        assert_eq!(saved.database_url, "postgres://u:new@db/rchat");
        assert_eq!(saved.extra, "MAX_UPLOAD_MIB=64");
    }

    #[test]
    fn a_secret_is_cleared_by_turning_its_flag_off() {
        let current = stored();
        let mut page = read(&current);
        assert_eq!(page["database_url_set"], true);
        assert_eq!(page["extra_set"], true);
        page["database_url_set"] = false.into();
        let saved = form(page.clone())
            .apply(&current, &built_in())
            .expect("saved");
        assert_eq!(saved.database_url, "");
        assert_eq!(saved.extra, current.extra);
        page["extra_set"] = false.into();
        let saved = form(page).apply(&current, &built_in()).expect("saved");
        assert_eq!(
            (saved.database_url.as_str(), saved.extra.as_str()),
            ("", "")
        );
        // A fresh setup reads both flags off and sends them back so.
        let fresh = ServerSettings::default();
        assert_eq!(form(read(&fresh)).apply(&fresh, &built_in()), Ok(fresh));
    }

    #[test]
    fn the_first_save_sets_the_server_up_with_its_folder() {
        let current = ServerSettings::default();
        let mut page = read(&current);
        page["set_up"] = true.into();
        page["name"] = "  Home ".into();
        page["port"] = 3480.into();
        page["data_dir"] = format!(" {} ", folder("new")).into();
        let saved = form(page).apply(&current, &built_in()).expect("saved");
        assert_eq!(
            saved,
            ServerSettings {
                set_up: true,
                name: "Home".into(),
                port: 3480,
                data_dir: folder("new"),
                ..ServerSettings::default()
            }
        );
    }

    #[test]
    fn a_server_set_up_with_no_folder_named_keeps_the_built_in_one() {
        let current = ServerSettings::default();
        let mut page = read(&current);
        assert_eq!(
            form(page.clone()).apply(&current, &built_in()),
            Ok(current.clone())
        );
        page["set_up"] = true.into();
        page["data_dir"] = "  ".into();
        let saved = form(page).apply(&current, &built_in()).expect("saved");
        assert!(saved.set_up);
        assert_eq!(saved.data_dir, built_in().display().to_string());
        let elsewhere = std::env::temp_dir().join("moved built in");
        assert_eq!(
            form(read(&saved)).apply(&saved, &elsewhere),
            Ok(saved.clone())
        );
        let blank = ServerSettings {
            data_dir: String::new(),
            ..saved
        };
        assert_eq!(
            form(read(&blank)).apply(&blank, &built_in()),
            Ok(ServerSettings {
                data_dir: built_in().display().to_string(),
                ..blank
            })
        );
    }

    #[test]
    fn a_set_up_server_keeps_its_folder_and_stays_set_up() {
        let current = stored();
        let mut page = read(&current);
        page["set_up"] = false.into();
        page["data_dir"] = folder("elsewhere").into();
        let saved = form(page).apply(&current, &built_in()).expect("saved");
        assert!(saved.set_up);
        assert_eq!(saved.data_dir, folder("kept"));
    }

    #[test]
    fn every_other_field_is_taken_from_the_form() {
        let current = stored();
        let mut page = read(&current);
        page["run_on_open"] = false.into();
        page["confirm_quit"] = false.into();
        page["serve_web"] = false.into();
        page["relay"] = true.into();
        page["listen"] = " 0.0.0.0 ".into();
        page["access"] = serde_json::json!({
            "mode": "https",
            "address": "https://chat.example.com",
            "proxy": "device",
            "proxy_device": "192.168.1.5",
        });
        let saved = form(page).apply(&current, &built_in()).expect("saved");
        assert_eq!(
            saved,
            ServerSettings {
                run_on_open: false,
                confirm_quit: false,
                serve_web: false,
                relay: true,
                listen: "0.0.0.0".into(),
                access: Access {
                    mode: AccessMode::Https,
                    address: "https://chat.example.com".into(),
                    proxy: ProxyHost::Device,
                    proxy_device: "192.168.1.5".into(),
                },
                ..current
            }
        );
    }

    #[test]
    fn a_form_the_server_could_not_start_with_is_refused() {
        let current = stored();
        for (field, value, text) in [
            (
                "port",
                serde_json::json!(80),
                "Pick a port from 1024 to 65535.",
            ),
            ("name", "".into(), "Give the server a name."),
            (
                "listen",
                "all".into(),
                "The listen address must be an IP address.",
            ),
            (
                "extra",
                "SERVER_PORT=1".into(),
                "Line 1: Set the port in the form above.",
            ),
            (
                "database_url",
                "sqlite://x".into(),
                "The database URL must start with postgres://",
            ),
        ] {
            let mut page = read(&current);
            page[field] = value;
            assert_eq!(
                form(page).apply(&current, &built_in()),
                Err(text.to_string()),
                "{field}"
            );
        }
        let mut fresh = read(&ServerSettings::default());
        fresh["data_dir"] = "relative".into();
        assert_eq!(
            form(fresh).apply(&ServerSettings::default(), &built_in()),
            Err("The data folder must be a full path.".to_string())
        );
    }

    #[test]
    fn a_form_with_a_missing_field_is_no_form() {
        let mut page = read(&stored());
        page.as_object_mut().expect("object").remove("port");
        assert!(serde_json::from_value::<Form>(page).is_err());
    }
}
