//! Channel permissions evaluated inside SQL, for statements that must read the channels, their
//! rules and the viewer's roles in one go. Every expression is about the `channels` row named
//! `c` and reads each rule the way `PermRow::evaluated` does.

use rchat_perms::masks::{BASE, HISTORY, SEND_GROUP, VIEW};
use rchat_perms::{Mask, eval};

use super::perms::EVERYONE;

/// The flag column a rule stored with flags only answers `bit` from.
fn flag(bit: Mask) -> Option<&'static str> {
    match bit {
        VIEW => Some("can_view"),
        HISTORY => Some("can_read_history"),
        b if b & SEND_GROUP != 0 => Some("can_send"),
        _ => None,
    }
}

const FLAGS_ONLY: &str = "ow.allow = 0 AND ow.deny = 0";

fn allows(bit: Mask) -> String {
    let derived = match flag(bit) {
        Some(col) => format!("ow.{col} <> 0"),
        None => "1 = 0".to_string(),
    };
    format!("(CASE WHEN {FLAGS_ONLY} THEN {derived} ELSE (ow.allow & {bit}) <> 0 END)")
}

fn denies(bit: Mask) -> String {
    let derived = match flag(bit) {
        Some(col) => format!("ow.{col} = 0"),
        None => "1 = 0".to_string(),
    };
    format!("(CASE WHEN {FLAGS_ONLY} THEN {derived} ELSE (ow.deny & {bit}) <> 0 END)")
}

fn any(rule: &str) -> String {
    format!("EXISTS(SELECT 1 FROM channel_perms ow WHERE ow.channel_id = c.id AND {rule})")
}

fn restrict(bit: Mask) -> &'static str {
    match bit {
        VIEW => "c.restrict_view = 0 AND ",
        b if b & SEND_GROUP != 0 => "c.restrict_send = 0 AND ",
        _ => "",
    }
}

fn everyone_bits() -> String {
    format!(
        "(SELECT COALESCE(ows.everyone_perms, {}) FROM servers ows WHERE ows.name = c.server)",
        eval::DEFAULT_EVERYONE
    )
}

fn stage(bit: Mask, base: &str) -> String {
    let everyone = format!("ow.subject = '{EVERYONE}' AND ");
    format!(
        "({}({} OR ({base} AND NOT {})))",
        restrict(bit),
        any(&format!("{everyone}{}", allows(bit))),
        any(&format!("{everyone}{}", denies(bit))),
    )
}

/// Whether the channel gives `bit` to everyone before any role or member rule, as SQL.
pub fn everyone_stage_sql(bit: Mask) -> String {
    stage(bit, &format!("({} & {bit}) <> 0", everyone_bits()))
}

/// Whether some role or member rule of the channel denies `bit`, as SQL.
pub fn denied_to_some_sql(bit: Mask) -> String {
    any(&format!("ow.subject <> '{EVERYONE}' AND {}", denies(bit)))
}

/// Whether not everyone in the server views the channel, as SQL.
pub fn private_sql() -> String {
    format!(
        "(NOT {} OR {})",
        everyone_stage_sql(VIEW),
        denied_to_some_sql(VIEW)
    )
}

/// Whether the account whose lowercase username is the SQL expression `viewer` holds `bit` in the
/// channel, as SQL. For someone who does not manage channels: the caller lets managers pass.
/// `None` is a guest. Bits other than View still need View, which the caller tests.
pub fn overwrite_sql(bit: Mask, viewer: Option<&str>) -> String {
    let Some(name) = viewer else {
        return everyone_stage_sql(bit);
    };
    debug_assert!(bit & BASE != 0);
    let own = format!("ow.subject = 'u:' || {name}");
    let overrides = format!("NOT ({FLAGS_ONLY}) AND ow.mode = 'override'");
    let union = format!(
        "(({own} AND NOT ({overrides})) OR ow.subject IN (SELECT 'r:' || CAST(owu.role_id AS TEXT) FROM user_roles owu WHERE owu.server = c.server AND owu.username = {name}))"
    );
    let base = format!(
        "(({} & {bit}) <> 0 OR EXISTS(SELECT 1 FROM user_roles owu JOIN roles owr ON owr.id = owu.role_id WHERE owu.server = c.server AND owu.username = {name} AND (owr.perms & {bit}) <> 0))",
        everyone_bits()
    );
    let (allow, deny) = (allows(bit), denies(bit));
    format!(
        "(CASE WHEN {} THEN 1 WHEN {} THEN 0 WHEN {} THEN 1 WHEN {} THEN 0 WHEN {} THEN 1 ELSE 0 END = 1)",
        any(&format!("{own} AND {overrides} AND {allow}")),
        any(&format!("{own} AND {overrides} AND {deny}")),
        any(&format!("{union} AND {allow}")),
        any(&format!("{union} AND {deny}")),
        stage(bit, &base),
    )
}
