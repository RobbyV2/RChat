use clap::{Parser, Subcommand};
use rust_next::api::admin_cli::{self, UserCommand};
use rust_next::config::{AppConfig, CliOverrides};
use rust_next::crypt::cli::{self as keys_cli, KeysCommand};
use rust_next::run::{self, RunOptions};
use tracing::info;

/// The server's command line: with no command it runs the server.
#[derive(Debug, Parser)]
#[command(
    name = "server",
    about = "Runs the server, or manages its accounts and keys"
)]
struct Cli {
    #[command(flatten)]
    overrides: CliOverrides,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Manage accounts in the instance's database. Works while the server runs.
    User {
        #[command(subcommand)]
        action: UserCommand,
    },
    /// Manage the instance's encryption keys.
    Keys {
        #[command(subcommand)]
        action: KeysCommand,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rust_next::env_file::load(".env.local")?;
    rust_next::env_file::load(".env")?;

    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let Cli { overrides, command } = Cli::parse();
    let config = AppConfig::load(&overrides)?;
    match command {
        Some(Command::User { action }) => {
            println!("{}", admin_cli::run(&config, action).await?);
            return Ok(());
        }
        Some(Command::Keys { action }) => {
            println!("{}", keys_cli::run(&config, action).await?);
            return Ok(());
        }
        None => {}
    }
    let running = run::start(config, RunOptions::default()).await?;
    shutdown_signal().await;
    running.shutdown().await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => info!("Received Ctrl+C, shutting down..."),
        _ = terminate => info!("Received SIGTERM, shutting down..."),
    }
}

#[cfg(test)]
mod tests {
    use clap::{CommandFactory, Parser};
    use rust_next::api::admin_cli::UserCommand;
    use serde_json::{Value, json};

    use rust_next::crypt::cli::KeysCommand;

    use super::{Cli, Command};

    /// The commands, arguments and help texts of `cmd` and its subcommands.
    fn described(cmd: &clap::Command) -> Value {
        let args: Vec<Value> = cmd
            .get_arguments()
            .filter(|a| !a.is_hide_set() && a.get_id() != "help")
            .map(|a| {
                let value = a.get_action().takes_values().then(|| {
                    a.get_value_names()
                        .map(|names| names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
                        .unwrap_or_else(|| vec![a.get_id().as_str().to_uppercase()])
                        .join(" ")
                });
                json!({
                    "id": a.get_id().as_str(),
                    "long": a.get_long(),
                    "short": a.get_short().map(String::from),
                    "value": value,
                    "positional": a.is_positional(),
                    "required": a.is_required_set(),
                    "help": a.get_help().map(|h| h.to_string()),
                })
            })
            .collect();
        let commands: Vec<Value> = cmd
            .get_subcommands()
            .filter(|c| c.get_name() != "help")
            .map(described)
            .collect();
        json!({
            "name": cmd.get_name(),
            "about": cmd.get_about().map(|a| a.to_string()),
            "usage": cmd.clone().render_usage().to_string().trim_start_matches("Usage: ").to_string(),
            "args": args,
            "commands": commands,
        })
    }

    /// The command line reference of the docs site is built from `docs/generated/cli.json`,
    /// which must describe this command line. `RCHAT_DOCS_WRITE=1` writes it
    /// (`just src docs-refs`).
    #[test]
    fn the_docs_site_has_the_current_command_line() {
        let mut cmd = Cli::command();
        cmd.build();
        let json = format!(
            "{}\n",
            serde_json::to_string_pretty(&described(&cmd)).expect("json")
        );
        let file =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/generated/cli.json");
        if std::env::var_os("RCHAT_DOCS_WRITE").is_some() {
            std::fs::write(&file, &json).expect("write");
        }
        let committed = std::fs::read_to_string(&file).unwrap_or_default();
        assert!(
            committed == json,
            "docs/generated/cli.json is out of date: run `just src docs-refs`"
        );
    }

    fn parsed(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from(std::iter::once("server").chain(args.iter().copied()))
    }

    #[test]
    fn no_command_runs_the_server_with_its_flags() {
        let cli = parsed(&["--port", "4500", "--mode", "api-only"]).expect("flags");
        assert!(cli.command.is_none());
        assert_eq!(cli.overrides.port, Some(4500));
        assert_eq!(cli.overrides.mode.as_deref(), Some("api-only"));
        assert!(parsed(&[]).expect("bare").command.is_none());
    }

    #[test]
    fn user_commands_take_a_name() {
        let Some(Command::User { action }) =
            parsed(&["user", "create", "Dana"]).expect("create").command
        else {
            panic!("no user command");
        };
        assert_eq!(
            action,
            UserCommand::Create {
                name: "Dana".to_string(),
                display_name: None
            }
        );
        let Some(Command::User { action }) =
            parsed(&["user", "create", "dana", "--display-name", "Dana R."])
                .expect("display name")
                .command
        else {
            panic!("no user command");
        };
        assert_eq!(
            action,
            UserCommand::Create {
                name: "dana".to_string(),
                display_name: Some("Dana R.".to_string())
            }
        );
        let Some(Command::User { action }) = parsed(&["user", "reset-password", "dana"])
            .expect("reset")
            .command
        else {
            panic!("no user command");
        };
        assert_eq!(
            action,
            UserCommand::ResetPassword {
                name: "dana".to_string()
            }
        );
        assert!(parsed(&["user", "create"]).is_err(), "a name is required");
        assert!(parsed(&["user", "delete", "dana"]).is_err());
        assert!(parsed(&["user"]).is_err());
    }

    #[test]
    fn keys_commands_parse() {
        let action = |args: &[&str]| match parsed(args).map(|cli| cli.command) {
            Ok(Some(Command::Keys { action })) => Some(action),
            Ok(Some(Command::User { action: _ })) | Ok(None) | Err(_) => None,
        };
        assert_eq!(
            action(&["keys", "new"]),
            Some(KeysCommand::New {
                id: "k1".to_string()
            })
        );
        assert_eq!(
            action(&["keys", "new", "--id", "k2"]),
            Some(KeysCommand::New {
                id: "k2".to_string()
            })
        );
        assert_eq!(action(&["keys", "status"]), Some(KeysCommand::Status));
        assert_eq!(
            action(&["keys", "export", "--out", "keys.json"]),
            Some(KeysCommand::Export {
                out: "keys.json".into(),
                passphrase_file: None
            })
        );
        assert_eq!(action(&["keys", "export"]), None, "a file is required");
        assert_eq!(
            action(&["keys", "import", "--in", "keys.json"]),
            Some(KeysCommand::Import {
                input: "keys.json".into(),
                passphrase_file: None,
                out: None
            })
        );
        assert_eq!(
            action(&[
                "keys",
                "import",
                "--in",
                "keys.json",
                "--passphrase-file",
                "phrase",
                "--out",
                "site.keys"
            ]),
            Some(KeysCommand::Import {
                input: "keys.json".into(),
                passphrase_file: Some("phrase".into()),
                out: Some("site.keys".into())
            })
        );
        assert_eq!(action(&["keys", "import"]), None, "a file is required");
        assert_eq!(action(&["keys"]), None);
    }
}
