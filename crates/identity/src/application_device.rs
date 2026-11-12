#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceKind {
    Device,
    Guest,
    Compliance,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceRow {
    pub id: String,
    pub kind: DeviceKind,
    pub session: Option<String>,
    pub application_grant: Option<String>,
    pub last_seen_at: i64,
    pub cert_version: u8,
}

pub fn is_application_device(d: &DeviceRow) -> bool {
    d.application_grant.is_some()
}

pub const UNUSED_GRANT_DAYS: i64 = 90;
const DAY: i64 = 86400;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GrantUse {
    pub live: bool,
    pub last_used_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sweep {
    Keep,
    HousekeepingRemove,
    SecurityRemove,
    UnusedRemove,
}

pub fn sweep(d: &DeviceRow, now: i64, idle_days: i64, grant: Option<GrantUse>) -> Sweep {
    let idle_for = |since: i64, days: i64| now.saturating_sub(since) >= days.saturating_mul(DAY);
    match (is_application_device(d), grant) {
        (
            true,
            Some(GrantUse {
                live: true,
                last_used_at,
            }),
        ) => match idle_for(last_used_at, UNUSED_GRANT_DAYS) {
            true => Sweep::UnusedRemove,
            false => Sweep::Keep,
        },
        (true, Some(GrantUse { live: false, .. }) | None) => Sweep::SecurityRemove,
        (false, _) => match d.session.is_none() && idle_for(d.last_seen_at, idle_days) {
            true => Sweep::HousekeepingRemove,
            false => Sweep::Keep,
        },
    }
}

pub fn committer_candidates(devices: &[DeviceRow]) -> Vec<&DeviceRow> {
    devices
        .iter()
        .filter(|d| !is_application_device(d) && d.kind == DeviceKind::Device)
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Commit {
    SelfUpdate,
    Resync,
    Request,
}

pub fn application_commit_ok(kind: Commit, refs: usize) -> bool {
    match kind {
        Commit::Request => false,
        Commit::Resync => true,
        Commit::SelfUpdate => refs == 0,
    }
}

pub fn slot_refs<S: AsRef<str>>(d: &DeviceRow, due_housekeeping: &[S]) -> Vec<String> {
    match is_application_device(d) {
        true => Vec::new(),
        false => due_housekeeping
            .iter()
            .map(|r| r.as_ref().to_string())
            .collect(),
    }
}
