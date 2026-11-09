use crate::settings::{Boot, Settings};

pub const AUTOSTART: &str = "--autostart";
// Login entries written before 0.4.0.
const LEGACY_HIDDEN: &str = "--hidden";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Launch {
    Manual,
    Autostart,
    LegacyHidden,
}

impl Launch {
    pub fn from_args<S: AsRef<str>>(args: impl IntoIterator<Item = S>) -> Self {
        args.into_iter()
            .fold(Launch::Manual, |found, arg| match (arg.as_ref(), found) {
                (AUTOSTART, _) => Launch::Autostart,
                (LEGACY_HIDDEN, Launch::Manual) => Launch::LegacyHidden,
                _ => found,
            })
    }

    // Whether starting the app again while it runs brings up the window.
    pub fn reopens(self) -> bool {
        match self {
            Launch::Manual => true,
            Launch::Autostart | Launch::LegacyHidden => false,
        }
    }
}

// What a start does: build the webview, show its window, start the server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
    pub webview: bool,
    pub show: bool,
    pub server: bool,
}

pub fn plan(launch: Launch, settings: &Settings, tray: bool) -> Plan {
    let set_up = settings.server.set_up;
    let boot = match launch {
        Launch::Manual => None,
        Launch::Autostart => Some(settings.boot),
        Launch::LegacyHidden => Some(Boot {
            on: true,
            client: true,
            hidden: true,
            server: false,
        }),
    };
    let wanted = match boot {
        None => settings.server.run_on_open,
        Some(Boot { server, .. }) => server,
    };
    let (webview, show) = match boot {
        None => (true, true),
        // With no tray, nothing else could open a hidden window.
        Some(Boot {
            client: true,
            hidden,
            ..
        }) => (true, !(hidden && tray)),
        Some(Boot {
            client: false,
            server: true,
            ..
        }) if set_up => (false, false),
        Some(Boot { client: false, .. }) => (true, true),
    };
    Plan {
        webview,
        show,
        // A server stopped for an update comes back whatever started the app.
        server: set_up && (settings.resume_server || wanted),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ServerSettings;

    fn settings(boot: Boot, set_up: bool, run_on_open: bool, resume_server: bool) -> Settings {
        Settings {
            boot,
            server: ServerSettings {
                set_up,
                run_on_open,
                ..ServerSettings::default()
            },
            resume_server,
            ..Settings::default()
        }
    }

    fn boot(client: bool, hidden: bool, server: bool) -> Boot {
        Boot {
            on: true,
            client,
            hidden,
            server,
        }
    }

    const SHOWN: Plan = Plan {
        webview: true,
        show: true,
        server: false,
    };
    const HIDDEN: Plan = Plan {
        webview: true,
        show: false,
        server: false,
    };
    const SERVER_ONLY: Plan = Plan {
        webview: false,
        show: false,
        server: true,
    };

    fn with_server(plan: Plan) -> Plan {
        Plan {
            server: true,
            ..plan
        }
    }

    #[test]
    fn reads_the_launch_from_the_arguments() {
        assert_eq!(Launch::from_args(["rchat"]), Launch::Manual);
        assert_eq!(Launch::from_args(Vec::<String>::new()), Launch::Manual);
        assert_eq!(
            Launch::from_args(["rchat", "rchat://chat.example.com/invite/a/"]),
            Launch::Manual
        );
        assert_eq!(
            Launch::from_args(["rchat", "--autostart"]),
            Launch::Autostart
        );
        assert_eq!(
            Launch::from_args(["rchat".to_string(), "--hidden".to_string()]),
            Launch::LegacyHidden
        );
        assert_eq!(
            Launch::from_args(["rchat", "--hidden", "--autostart"]),
            Launch::Autostart
        );
        assert_eq!(
            Launch::from_args(["rchat", "--autostart", "--hidden"]),
            Launch::Autostart
        );
        assert_eq!(Launch::from_args(["rchat", "--Autostart"]), Launch::Manual);
        assert_eq!(AUTOSTART, "--autostart");
    }

    #[test]
    fn manual_launch_shows_the_window() {
        for tray in [false, true] {
            for b in [
                boot(true, true, true),
                boot(false, false, true),
                boot(false, true, false),
            ] {
                let plan = |set_up, run_on_open, resume| {
                    super::plan(
                        Launch::Manual,
                        &settings(b, set_up, run_on_open, resume),
                        tray,
                    )
                };
                assert_eq!(plan(true, true, false), with_server(SHOWN));
                assert_eq!(plan(true, false, false), SHOWN);
                assert_eq!(plan(true, false, true), with_server(SHOWN));
                assert_eq!(plan(false, true, false), SHOWN);
                assert_eq!(plan(false, true, true), SHOWN);
            }
        }
    }

    #[test]
    fn autostart_follows_the_boot_choices() {
        let rows = [
            ("client, shown", boot(true, false, false), true, SHOWN),
            (
                "client, shown, no tray",
                boot(true, false, false),
                false,
                SHOWN,
            ),
            ("client, hidden", boot(true, true, false), true, HIDDEN),
            (
                "client, hidden, no tray",
                boot(true, true, false),
                false,
                SHOWN,
            ),
            ("server only", boot(false, true, true), true, SERVER_ONLY),
            (
                "server only, shown ticked",
                boot(false, false, true),
                true,
                SERVER_ONLY,
            ),
            (
                "server only, no tray",
                boot(false, true, true),
                false,
                SERVER_ONLY,
            ),
            ("neither", boot(false, true, false), true, SHOWN),
            ("neither, no tray", boot(false, false, false), false, SHOWN),
        ];
        for (name, b, tray, want) in rows {
            let got = plan(Launch::Autostart, &settings(b, true, false, false), tray);
            assert_eq!(got, want, "{name}");
        }
    }

    #[test]
    fn autostart_starts_the_server_only_when_ticked_and_set_up() {
        let rows = [
            (
                "both, shown",
                boot(true, false, true),
                true,
                true,
                with_server(SHOWN),
            ),
            (
                "both, hidden",
                boot(true, true, true),
                true,
                true,
                with_server(HIDDEN),
            ),
            (
                "both, hidden, no tray",
                boot(true, true, true),
                true,
                false,
                with_server(SHOWN),
            ),
            (
                "both, not set up",
                boot(true, true, true),
                false,
                true,
                HIDDEN,
            ),
            (
                "server only, not set up",
                boot(false, true, true),
                false,
                true,
                SHOWN,
            ),
            (
                "server only, not set up, no tray",
                boot(false, true, true),
                false,
                false,
                SHOWN,
            ),
        ];
        for (name, b, set_up, tray, want) in rows {
            for run_on_open in [false, true] {
                let got = plan(
                    Launch::Autostart,
                    &settings(b, set_up, run_on_open, false),
                    tray,
                );
                assert_eq!(got, want, "{name}");
            }
        }
    }

    #[test]
    fn legacy_hidden_means_a_hidden_client_without_the_server() {
        for b in [
            boot(true, true, false),
            boot(false, false, true),
            boot(true, false, true),
        ] {
            let s = settings(b, true, true, false);
            assert_eq!(plan(Launch::LegacyHidden, &s, true), HIDDEN);
            assert_eq!(plan(Launch::LegacyHidden, &s, false), SHOWN);
        }
    }

    #[test]
    fn a_server_stopped_for_an_update_comes_back() {
        let hidden = boot(true, true, false);
        let none = boot(false, true, false);
        let set_up = |b| settings(b, true, false, true);
        assert_eq!(
            plan(Launch::Autostart, &set_up(hidden), true),
            with_server(HIDDEN)
        );
        assert_eq!(
            plan(Launch::Autostart, &set_up(none), true),
            with_server(SHOWN)
        );
        assert_eq!(
            plan(Launch::LegacyHidden, &set_up(hidden), true),
            with_server(HIDDEN)
        );
        assert_eq!(
            plan(
                Launch::Autostart,
                &settings(hidden, false, true, true),
                true
            ),
            HIDDEN
        );
    }

    #[test]
    fn only_a_manual_second_launch_opens_the_window() {
        assert!(Launch::Manual.reopens());
        assert!(!Launch::Autostart.reopens());
        assert!(!Launch::LegacyHidden.reopens());
    }
}
