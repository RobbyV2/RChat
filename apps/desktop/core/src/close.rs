use crate::settings::Settings;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quit {
    Now,
    // Ask first: quitting stops the server for everyone connected to it.
    Ask,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Close {
    Hide,
    Quit(Quit),
}

pub fn on_quit(settings: &Settings, server_running: bool) -> Quit {
    if server_running && settings.server.confirm_quit {
        Quit::Ask
    } else {
        Quit::Now
    }
}

// Closing the window hides it only when something is left to open it again.
pub fn on_close(settings: &Settings, tray: bool, server_running: bool) -> Close {
    if settings.minimize_to_tray && tray {
        Close::Hide
    } else {
        Close::Quit(on_quit(settings, server_running))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ServerSettings;

    fn settings(minimize_to_tray: bool, confirm_quit: bool) -> Settings {
        Settings {
            minimize_to_tray,
            server: ServerSettings {
                confirm_quit,
                ..ServerSettings::default()
            },
            ..Settings::default()
        }
    }

    #[test]
    fn closing_hides_only_with_the_setting_and_a_tray() {
        const HIDE: Close = Close::Hide;
        const QUIT: Close = Close::Quit(Quit::Now);
        const ASK: Close = Close::Quit(Quit::Ask);
        // tray, setting, server running, confirm
        let rows = [
            (true, true, true, true, HIDE),
            (true, true, true, false, HIDE),
            (true, true, false, true, HIDE),
            (true, true, false, false, HIDE),
            (true, false, true, true, ASK),
            (true, false, true, false, QUIT),
            (true, false, false, true, QUIT),
            (true, false, false, false, QUIT),
            (false, true, true, true, ASK),
            (false, true, true, false, QUIT),
            (false, true, false, true, QUIT),
            (false, true, false, false, QUIT),
            (false, false, true, true, ASK),
            (false, false, true, false, QUIT),
            (false, false, false, true, QUIT),
            (false, false, false, false, QUIT),
        ];
        for (tray, setting, running, confirm, want) in rows {
            assert_eq!(
                on_close(&settings(setting, confirm), tray, running),
                want,
                "tray {tray}, setting {setting}, running {running}, confirm {confirm}"
            );
        }
    }

    #[test]
    fn quitting_asks_only_while_the_server_runs() {
        for minimize in [false, true] {
            assert_eq!(on_quit(&settings(minimize, true), true), Quit::Ask);
            assert_eq!(on_quit(&settings(minimize, false), true), Quit::Now);
            assert_eq!(on_quit(&settings(minimize, true), false), Quit::Now);
            assert_eq!(on_quit(&settings(minimize, false), false), Quit::Now);
        }
    }
}
