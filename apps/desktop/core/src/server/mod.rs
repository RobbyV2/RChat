// The app's own server: the settings as the server reads them, its data folder, and the
// supervisor that runs it inside this process.

pub mod assets;
pub mod backups;
pub mod dirs;
pub mod env;
pub mod logs;
pub mod ports;
pub mod supervisor;

pub use supervisor::{State, Status, Supervisor};
