// The tray menu as data. The Tauri menu (macOS, Windows) and the StatusNotifierItem menu (Linux)
// both render it.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Open,
    Online,
    Offline,
    Mute,
    StartServer,
    StopServer,
    RestartServer,
    CopyAddress,
    ServerSettings,
    CheckUpdates,
    Quit,
}

impl Action {
    pub const ALL: [Action; 11] = [
        Action::Open,
        Action::Online,
        Action::Offline,
        Action::Mute,
        Action::StartServer,
        Action::StopServer,
        Action::RestartServer,
        Action::CopyAddress,
        Action::ServerSettings,
        Action::CheckUpdates,
        Action::Quit,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Action::Open => "open",
            Action::Online => "online",
            Action::Offline => "offline",
            Action::Mute => "mute",
            Action::StartServer => "server_start",
            Action::StopServer => "server_stop",
            Action::RestartServer => "server_restart",
            Action::CopyAddress => "server_copy",
            Action::ServerSettings => "server_settings",
            Action::CheckUpdates => "update",
            Action::Quit => "quit",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Action::ALL.into_iter().find(|a| a.id() == id)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServerState {
    Off,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Server {
    pub state: ServerState,
    pub connections: u32,
    pub needs_restart: bool,
}

// `server` is None until a server is set up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub webview: bool,
    pub offline: bool,
    pub muted: bool,
    pub server: Option<Server>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pick {
    pub action: Action,
    pub label: &'static str,
    pub selected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Item {
    Separator,
    // A line of text that can't be clicked.
    Note(String),
    Button {
        action: Action,
        label: &'static str,
        enabled: bool,
    },
    Check {
        action: Action,
        label: &'static str,
        checked: bool,
    },
    // A submenu where one option is selected.
    Choice {
        label: &'static str,
        enabled: bool,
        options: Vec<Pick>,
    },
}

fn button(action: Action, label: &'static str, enabled: bool) -> Item {
    Item::Button {
        action,
        label,
        enabled,
    }
}

fn server_line(server: Server) -> String {
    let Server {
        state,
        connections,
        needs_restart,
    } = server;
    match state {
        ServerState::Off => "Server: off".into(),
        ServerState::Starting => "Server: starting".into(),
        ServerState::Running if needs_restart => "Server: restart to apply".into(),
        ServerState::Running => format!("Server: running, {connections} connected"),
        ServerState::Stopping => "Server: stopping".into(),
        ServerState::Failed => "Server: failed".into(),
    }
}

fn server_block(server: Server) -> [Item; 6] {
    let toggle = match server.state {
        ServerState::Off | ServerState::Failed => button(Action::StartServer, "Start server", true),
        ServerState::Stopping => button(Action::StartServer, "Start server", false),
        ServerState::Starting => button(Action::StopServer, "Stop server", false),
        ServerState::Running => button(Action::StopServer, "Stop server", true),
    };
    let running = server.state == ServerState::Running;
    [
        Item::Note(server_line(server)),
        toggle,
        button(Action::RestartServer, "Restart server", running),
        button(Action::CopyAddress, "Copy server address", running),
        button(Action::ServerSettings, "Server settings", true),
        Item::Separator,
    ]
}

pub fn menu(snapshot: &Snapshot) -> Vec<Item> {
    let Snapshot {
        webview,
        offline,
        muted,
        server,
    } = *snapshot;
    let mut items = vec![
        button(Action::Open, "Open RChat", true),
        Item::Separator,
        // The page sets the status of its signed-in accounts, so it needs a webview.
        Item::Choice {
            label: "Status",
            enabled: webview,
            options: vec![
                Pick {
                    action: Action::Online,
                    label: "Online",
                    selected: !offline,
                },
                Pick {
                    action: Action::Offline,
                    label: "Appear offline",
                    selected: offline,
                },
            ],
        },
        Item::Check {
            action: Action::Mute,
            label: "Mute notifications",
            checked: muted,
        },
        Item::Separator,
    ];
    items.extend(server.into_iter().flat_map(server_block));
    items.push(button(Action::CheckUpdates, "Check for updates", true));
    items.push(button(Action::Quit, "Quit RChat", true));
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN: Snapshot = Snapshot {
        webview: true,
        offline: false,
        muted: false,
        server: None,
    };

    fn server(state: ServerState, connections: u32, needs_restart: bool) -> Snapshot {
        Snapshot {
            server: Some(Server {
                state,
                connections,
                needs_restart,
            }),
            ..PLAIN
        }
    }

    fn button(action: Action, label: &'static str, enabled: bool) -> Item {
        Item::Button {
            action,
            label,
            enabled,
        }
    }

    fn status(enabled: bool, offline: bool) -> Item {
        Item::Choice {
            label: "Status",
            enabled,
            options: vec![
                Pick {
                    action: Action::Online,
                    label: "Online",
                    selected: !offline,
                },
                Pick {
                    action: Action::Offline,
                    label: "Appear offline",
                    selected: offline,
                },
            ],
        }
    }

    fn mute(checked: bool) -> Item {
        Item::Check {
            action: Action::Mute,
            label: "Mute notifications",
            checked,
        }
    }

    #[test]
    fn no_server_block_until_one_is_set_up() {
        assert_eq!(
            menu(&PLAIN),
            vec![
                button(Action::Open, "Open RChat", true),
                Item::Separator,
                status(true, false),
                mute(false),
                Item::Separator,
                button(Action::CheckUpdates, "Check for updates", true),
                button(Action::Quit, "Quit RChat", true),
            ]
        );
    }

    #[test]
    fn a_set_up_server_gets_its_block() {
        assert_eq!(
            menu(&server(ServerState::Running, 2, false)),
            vec![
                button(Action::Open, "Open RChat", true),
                Item::Separator,
                status(true, false),
                mute(false),
                Item::Separator,
                Item::Note("Server: running, 2 connected".into()),
                button(Action::StopServer, "Stop server", true),
                button(Action::RestartServer, "Restart server", true),
                button(Action::CopyAddress, "Copy server address", true),
                button(Action::ServerSettings, "Server settings", true),
                Item::Separator,
                button(Action::CheckUpdates, "Check for updates", true),
                button(Action::Quit, "Quit RChat", true),
            ]
        );
    }

    #[test]
    fn server_lines_and_buttons_follow_the_state() {
        let start = |enabled| button(Action::StartServer, "Start server", enabled);
        let stop = |enabled| button(Action::StopServer, "Stop server", enabled);
        let rows = [
            (
                server(ServerState::Off, 0, false),
                "Server: off",
                start(true),
                false,
            ),
            (
                server(ServerState::Off, 0, true),
                "Server: off",
                start(true),
                false,
            ),
            (
                server(ServerState::Starting, 0, false),
                "Server: starting",
                stop(false),
                false,
            ),
            (
                server(ServerState::Running, 0, false),
                "Server: running, 0 connected",
                stop(true),
                true,
            ),
            (
                server(ServerState::Running, 1, false),
                "Server: running, 1 connected",
                stop(true),
                true,
            ),
            (
                server(ServerState::Running, 12, true),
                "Server: restart to apply",
                stop(true),
                true,
            ),
            (
                server(ServerState::Stopping, 3, false),
                "Server: stopping",
                start(false),
                false,
            ),
            (
                server(ServerState::Failed, 0, false),
                "Server: failed",
                start(true),
                false,
            ),
            (
                server(ServerState::Failed, 0, true),
                "Server: failed",
                start(true),
                false,
            ),
        ];
        for (snapshot, line, toggle, running) in rows {
            let items = menu(&snapshot);
            assert_eq!(
                items[5..10],
                [
                    Item::Note(line.into()),
                    toggle,
                    button(Action::RestartServer, "Restart server", running),
                    button(Action::CopyAddress, "Copy server address", running),
                    button(Action::ServerSettings, "Server settings", true),
                ],
                "{line}"
            );
            assert_eq!(items.len(), 13);
        }
    }

    #[test]
    fn status_needs_a_webview() {
        let none = Snapshot {
            webview: false,
            ..server(ServerState::Running, 1, false)
        };
        let items = menu(&none);
        assert_eq!(items[2], status(false, false));
        assert_eq!(items[0], button(Action::Open, "Open RChat", true));
        assert_eq!(items[3], mute(false));
        assert_eq!(items[6], button(Action::StopServer, "Stop server", true));
    }

    #[test]
    fn checks_follow_the_snapshot() {
        let offline = Snapshot {
            offline: true,
            ..PLAIN
        };
        assert_eq!(menu(&offline)[2], status(true, true));
        assert_eq!(menu(&offline)[3], mute(false));
        let muted = Snapshot {
            muted: true,
            ..PLAIN
        };
        assert_eq!(menu(&muted)[2], status(true, false));
        assert_eq!(menu(&muted)[3], mute(true));
    }

    #[test]
    fn action_ids_are_unique_and_read_back() {
        for (i, a) in Action::ALL.iter().enumerate() {
            assert_eq!(Action::from_id(a.id()), Some(*a));
            assert!(a.id().is_ascii());
            assert!(Action::ALL[..i].iter().all(|b| b.id() != a.id()));
        }
        assert_eq!(Action::from_id("show"), None);
        assert_eq!(Action::from_id(""), None);
    }

    #[test]
    fn every_action_is_listed() {
        let listed = |a: Action| match a {
            Action::Open
            | Action::Online
            | Action::Offline
            | Action::Mute
            | Action::StartServer
            | Action::StopServer
            | Action::RestartServer
            | Action::CopyAddress
            | Action::ServerSettings
            | Action::CheckUpdates
            | Action::Quit => Action::ALL.contains(&a),
        };
        assert!(Action::ALL.into_iter().all(listed));
        assert_eq!(Action::ALL.len(), 11);
    }

    #[test]
    fn labels_are_plain() {
        let mut texts = Vec::new();
        for snapshot in [PLAIN, server(ServerState::Running, 2, true)] {
            for item in menu(&snapshot) {
                match item {
                    Item::Separator => {}
                    Item::Note(text) => texts.push(text),
                    Item::Button { label, .. } | Item::Check { label, .. } => {
                        texts.push(label.to_string())
                    }
                    Item::Choice { label, options, .. } => {
                        texts.push(label.to_string());
                        texts.extend(options.iter().map(|o| o.label.to_string()));
                    }
                }
            }
        }
        assert!(texts.iter().all(|t| t.is_ascii() && !t.is_empty()));
    }
}
