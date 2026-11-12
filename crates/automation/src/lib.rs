//! The pure rules of server onboarding and automations. Nothing here touches a database, a
//! clock or the network: ids are `i64` and strings, limits come in as `validate::Caps`, and
//! permissions are bit sets whose values are the server's.

pub mod access;
pub mod budget;
pub mod detect;
mod entities;
pub mod fold;
mod fold_table;
pub mod giveaway;
pub mod grants;
pub mod keywords;
pub mod levels;
pub mod links;
pub mod model;
pub mod onboarding;
pub mod panel;
pub mod presets;
pub mod regex;
pub mod safety;
pub mod schedule;
pub mod template;
pub mod timing;
pub mod undo;
pub mod validate;
