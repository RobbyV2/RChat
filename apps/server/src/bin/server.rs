use clap::{Parser, Subcommand};
use rust_next::api::admin_cli::{self, UserCommand};
use rust_next::config::{AppConfig, CliOverrides};
use rust_next::run::{self, RunOptions};
use tracing::info;

/// The server's command line: with no command it runs the server.
#[derive(Debug, Parser)]
#[command(name = "server", about = "Runs the server, or manages its accounts")]
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
    if let Some(Command::User { action }) = command {
        println!("{}", admin_cli::run(&config, action).await?);
        return Ok(());
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
    use clap::Parser;
    use rust_next::api::admin_cli::UserCommand;

    use super::{Cli, Command};

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
}
