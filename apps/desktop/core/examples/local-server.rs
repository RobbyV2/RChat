// The app's own server without the app, as the supervisor runs it:
// local-server --dir <data folder> [--port <port>] [--web <folder>]
// `--web` serves a folder such as a static export of the web app (`apps/web/out`) the way the app
// serves its bundled one. Ctrl+C stops it.

use rchat_desktop_core::server::logs::Logs;
use rchat_desktop_core::server::{State, Supervisor, assets, ports};
use rchat_desktop_core::settings::ServerSettings;
use std::path::PathBuf;

const USAGE: &str = "usage: local-server --dir <data folder> [--port <port>] [--web <folder>]";

fn folder(value: &str) -> Result<PathBuf, String> {
    std::path::absolute(value).map_err(|e| format!("{value}: {e}"))
}

fn main() -> Result<(), String> {
    let (mut port, mut dir, mut web) = (ports::DEFAULT, None, None);
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args.next().ok_or(USAGE)?;
        match flag.as_str() {
            "--port" => port = value.parse().map_err(|_| USAGE)?,
            "--dir" => dir = Some(folder(&value)?),
            "--web" => web = Some(folder(&value)?),
            _ => return Err(USAGE.into()),
        }
    }
    let dir = dir.ok_or(USAGE)?;
    let logs = Logs::new();
    logs.install(true);
    let settings = ServerSettings {
        set_up: true,
        port,
        data_dir: dir.display().to_string(),
        ..ServerSettings::default()
    };
    let supervisor = Supervisor::new(dir, web.map(assets::folder), logs);
    let status = supervisor.start(&settings);
    let url = match (status.state, status.url) {
        (State::Running, Some(url)) => url,
        _ => {
            return Err(status
                .error
                .unwrap_or_else(|| "The server did not start.".into()));
        }
    };
    println!("Serving {url} from {}. Ctrl+C stops it.", status.data_dir);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .and_then(|runtime| runtime.block_on(tokio::signal::ctrl_c()))
        .map_err(|e| e.to_string())?;
    supervisor.stop(&settings);
    Ok(())
}
