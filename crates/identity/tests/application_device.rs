use rchat_identity::application_device::{
    Commit, DeviceKind, DeviceRow, GrantUse, Sweep, UNUSED_GRANT_DAYS, application_commit_ok,
    committer_candidates, is_application_device, slot_refs, sweep,
};

const DAY: i64 = 86400;

fn row(id: &str, application_grant: Option<&str>, cert_version: u8) -> DeviceRow {
    DeviceRow {
        id: id.to_string(),
        kind: DeviceKind::Device,
        session: None,
        application_grant: application_grant.map(str::to_string),
        last_seen_at: 0,
        cert_version,
    }
}

fn application() -> DeviceRow {
    row("d_application", Some("gr1"), 2)
}

fn laptop() -> DeviceRow {
    row("d_lap", None, 1)
}

fn used(last_used_at: i64) -> Option<GrantUse> {
    Some(GrantUse {
        live: true,
        last_used_at,
    })
}

#[test]
fn exempt_from_the_idle_sweep_while_the_grant_is_used_an_ended_grant_is_a_security_removal() {
    assert!(is_application_device(&application()));
    assert!(!is_application_device(&laptop()));
    assert_eq!(
        sweep(&application(), 365 * DAY, 90, used(365 * DAY - 1)),
        Sweep::Keep
    );
    let ended = Some(GrantUse {
        live: false,
        last_used_at: 0,
    });
    assert_eq!(sweep(&application(), 0, 90, ended), Sweep::SecurityRemove);
    assert_eq!(sweep(&application(), 0, 90, None), Sweep::SecurityRemove);
    assert_eq!(
        sweep(&laptop(), 90 * DAY, 90, None),
        Sweep::HousekeepingRemove
    );
    assert_eq!(sweep(&laptop(), 90 * DAY - 1, 90, None), Sweep::Keep);
    let bound = DeviceRow {
        session: Some("s1".to_string()),
        ..laptop()
    };
    assert_eq!(sweep(&bound, 900 * DAY, 90, None), Sweep::Keep);
}

#[test]
fn an_application_that_has_not_used_its_grant_for_90_days_loses_its_device() {
    assert_eq!(UNUSED_GRANT_DAYS, 90);
    let d = application();
    assert_eq!(sweep(&d, 3 * 365 * DAY, 90, used(0)), Sweep::UnusedRemove);
    assert_eq!(sweep(&d, 90 * DAY, 90, used(0)), Sweep::UnusedRemove);
    assert_eq!(sweep(&d, 90 * DAY - 1, 90, used(0)), Sweep::Keep);
    assert_eq!(sweep(&d, 90 * DAY, 1, used(1)), Sweep::Keep);
    let fetching = DeviceRow {
        last_seen_at: 3 * 365 * DAY,
        ..application()
    };
    assert_eq!(
        sweep(&fetching, 3 * 365 * DAY, 90, used(0)),
        Sweep::UnusedRemove
    );
    assert_eq!(sweep(&d, i64::MAX, 90, used(i64::MIN)), Sweep::UnusedRemove);
    assert_eq!(sweep(&laptop(), i64::MAX - 1, i64::MAX, None), Sweep::Keep);
}

#[test]
fn never_asked_to_commit_others_changes() {
    let devices = [application(), laptop()];
    let ids: Vec<&str> = committer_candidates(&devices)
        .iter()
        .map(|d| d.id.as_str())
        .collect();
    assert_eq!(ids, ["d_lap"]);
    let guest = DeviceRow {
        kind: DeviceKind::Guest,
        ..laptop()
    };
    assert!(committer_candidates(&[guest]).is_empty());
    assert_eq!(slot_refs(&application(), &["r1", "r2"]), [] as [&str; 0]);
    assert_eq!(slot_refs(&laptop(), &["r1"]), ["r1"]);
    assert!(!application_commit_ok(Commit::Request, 0));
    assert!(!application_commit_ok(Commit::SelfUpdate, 1));
    assert!(application_commit_ok(Commit::SelfUpdate, 0));
    assert!(application_commit_ok(Commit::Resync, 0));
    assert!(application_commit_ok(Commit::Resync, 3));
}
