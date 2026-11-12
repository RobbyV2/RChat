use rchat_identity::owners::{
    Application, ApplicationMember, Change, DEADLOCK_WAYS, INVITE_SECS, Kind, LAPSE_GUARDED,
    LAPSE_SECS, MemberState, ORPHAN_DELETE_SECS, ORPHAN_RUN_SECS, OWNERS_MAX, Orphan,
    PROPOSAL_SECS, Proposal, RESTORE_SECS, Refusal, Removal, Role, SEATS_MAX, STAFF_MAX, Status,
    TIME_LOCK_SECS, TIME_LOCKABLE, Threshold, kind_of, lapse, same_field, server_seat,
};

fn member(uid: i64, role: Role, state: MemberState) -> ApplicationMember {
    ApplicationMember {
        uid,
        role,
        state,
        seat: None,
        inactive_since: None,
    }
}

fn owners(uids: &[i64]) -> Vec<ApplicationMember> {
    uids.iter()
        .map(|uid| member(*uid, Role::Owner, MemberState::Active))
        .collect()
}

fn inactive(uid: i64) -> ApplicationMember {
    member(uid, Role::Owner, MemberState::Inactive)
}

fn suspended_since(uid: i64, at: i64) -> ApplicationMember {
    ApplicationMember {
        inactive_since: Some(at),
        ..inactive(uid)
    }
}

fn with(mut ms: Vec<ApplicationMember>, more: &[ApplicationMember]) -> Vec<ApplicationMember> {
    ms.extend_from_slice(more);
    ms
}

fn need(ms: &[ApplicationMember], change: Change) -> usize {
    Application::new(ms).threshold(change, None).need
}

fn propose(ms: &[ApplicationMember], actor: i64, change: Change, id: i64) -> Proposal {
    Application::new(ms)
        .propose(actor, change, 0, id, None)
        .expect("a proposal")
}

#[test]
fn one_owner_decides_alone_otherwise_a_strict_majority_never_fewer_than_two() {
    assert_eq!(need(&owners(&[1]), Change::Name), 1);
    assert_eq!(need(&owners(&[1, 2]), Change::Name), 2);
    assert_eq!(need(&owners(&[1, 2, 3]), Change::Name), 2);
    assert_eq!(need(&owners(&[1, 2, 3, 4]), Change::Name), 3);
    assert_eq!(need(&owners(&[1, 2, 3, 4, 5]), Change::Delete), 3);
}

#[test]
fn the_owner_being_removed_does_not_vote() {
    assert_eq!(
        Application::new(&owners(&[1, 2, 3])).threshold(Change::OwnerRemove, Some(3)),
        Threshold {
            voters: vec![1, 2],
            need: 2
        }
    );
}

#[test]
fn invited_owners_do_not_count_suspended_ones_do() {
    let ms = with(
        owners(&[1, 2]),
        &[inactive(3), member(4, Role::Owner, MemberState::Invited)],
    );
    assert_eq!(
        Application::new(&ms).threshold(Change::Name, None),
        Threshold {
            voters: vec![1, 2, 3],
            need: 2
        }
    );
}

#[test]
fn agreement_changes_still_need_two_and_the_suspended_owner_can_not_be_removed() {
    let ms = with(owners(&[1]), &[inactive(2)]);
    let application = Application::new(&ms);
    assert_eq!(
        application.direct(1, Change::RedirectAdd),
        Err(Refusal::NeedsAgreement)
    );
    assert_eq!(need(&ms, Change::Name), 2);
    assert!(application.threshold(Change::OwnerRemove, Some(2)).need > 1);
    assert_eq!(
        application.propose(1, Change::OwnerRemove, 0, 1, Some(2)),
        Err(Refusal::SuspendedOwner)
    );
    assert_eq!(
        Refusal::SuspendedOwner.text(),
        "Application can not be removed while their account is suspended"
    );
    assert_eq!(Refusal::NeedsAgreement.text(), "Needs agreement");
}

#[test]
fn a_suspension_never_applies_an_open_proposal() {
    let four = owners(&[1, 2, 3, 4]);
    let application = Application::new(&four);
    let p = application
        .vote(&propose(&four, 1, Change::Delete, 1), 2, true, 1, 0)
        .unwrap();
    assert_eq!(p.status, Status::Open);
    let after = with(owners(&[1, 2, 3]), &[inactive(4)]);
    assert_eq!(
        Application::new(&after).settle(p, 2, 0).status,
        Status::Open
    );
}

#[test]
fn nor_does_a_time_lock_while_an_owner_can_not_answer() {
    let ms = with(owners(&[1]), &[inactive(2)]);
    let p = propose(&ms, 1, Change::Name, 1);
    assert_ne!(
        Application::new(&ms)
            .settle(p, TIME_LOCK_SECS + 1, 0)
            .status,
        Status::Applied
    );
}

#[test]
fn the_other_puts_it_back_alone_within_14_days() {
    let ms = owners(&[1, 2]);
    let application = Application::new(&ms);
    let removal = Removal {
        change: Change::RedirectRemove,
        by: 1,
        at: 0,
    };
    assert_eq!(application.direct(1, Change::RedirectRemove), Ok(()));
    assert_eq!(
        application.can_restore(2, &removal, RESTORE_SECS - 1),
        Ok(())
    );
    assert_eq!(
        application.can_restore(2, &removal, RESTORE_SECS),
        Err(Refusal::NothingToRestore)
    );
    assert_eq!(Refusal::NothingToRestore.text(), "Nothing to restore");
    assert_eq!(kind_of(Change::Restore), Kind::Single);
    let not_removal = Removal {
        change: Change::Name,
        ..removal
    };
    assert_eq!(
        application.can_restore(2, &not_removal, 1),
        Err(Refusal::NothingToRestore)
    );
    assert_eq!(
        application.can_restore(9, &removal, 1),
        Err(Refusal::NotFound)
    );
}

#[test]
fn the_stalemate_ways_out_are_none_of_them_a_takeover() {
    let ms = owners(&[1, 2]);
    let application = Application::new(&ms);
    assert_eq!(
        application.propose(1, Change::OwnerRemove, 0, 1, Some(2)),
        Err(Refusal::TwoOwners)
    );
    assert_eq!(
        Refusal::TwoOwners.text(),
        "Two owners can not remove each other. Either of you can leave"
    );
    assert_eq!(
        DEADLOCK_WAYS,
        ["pause", "leave", "time_locked_request", "ask_site"]
    );
    let look = propose(&ms, 1, Change::Name, 1);
    assert_eq!(
        application.settle(look.clone(), TIME_LOCK_SECS, 0).status,
        Status::Applied
    );
    assert_eq!(
        application.settle(look.clone(), TIME_LOCK_SECS, 1).status,
        Status::Expired
    );
    let refused = application.vote(&look, 2, false, 5, 0).unwrap();
    assert_eq!(refused.status, Status::Rejected);
    let redirect = propose(&ms, 1, Change::RedirectAdd, 2);
    assert_eq!(
        application.settle(redirect, TIME_LOCK_SECS, 0).status,
        Status::Expired
    );
    assert_eq!(
        TIME_LOCKABLE,
        [
            Change::Name,
            Change::Icon,
            Change::Links,
            Change::EndorseRequest
        ]
    );
}

#[test]
fn one_manager_casting_the_seat_is_one_vote_among_the_people() {
    let ms = with(owners(&[1]), &[server_seat("lobby")]);
    let application = Application::new(&ms);
    assert_eq!(server_seat("lobby").seat.as_deref(), Some("server:lobby"));
    assert_eq!(need(&ms, Change::RedirectAdd), 2);
    assert_eq!(
        application.direct(1, Change::Leave),
        Err(Refusal::NeedsPerson)
    );
    assert_eq!(
        Refusal::NeedsPerson.text(),
        "An application needs at least one person as owner"
    );
    assert_eq!(
        application.propose(1, Change::OwnerRemove, 0, 1, Some(1)),
        Err(Refusal::NotFound)
    );
    assert_eq!(
        application.propose(1, Change::OwnerRemove, 0, 1, None),
        Err(Refusal::NotFound)
    );
}

#[test]
fn developers_and_viewers() {
    let ms = with(
        owners(&[1, 2]),
        &[
            member(5, Role::Developer, MemberState::Active),
            member(6, Role::Viewer, MemberState::Active),
        ],
    );
    let application = Application::new(&ms);
    assert_eq!(application.direct(5, Change::Description), Ok(()));
    assert_eq!(
        application.direct(6, Change::Description),
        Err(Refusal::OnlyOwners)
    );
    assert_eq!(
        application.direct(5, Change::SecretIssue),
        Err(Refusal::OnlyOwners)
    );
    assert_eq!(application.direct(5, Change::Leave), Ok(()));
    assert_eq!(application.direct(6, Change::Leave), Ok(()));
    assert_eq!(
        application.propose(5, Change::Name, 0, 1, None),
        Err(Refusal::OnlyOwners)
    );
    assert_eq!(
        application.direct(9, Change::Description),
        Err(Refusal::NotFound)
    );
    assert_eq!(
        application.propose(9, Change::Name, 0, 1, None),
        Err(Refusal::NotFound)
    );
    assert_eq!(
        application.propose(1, Change::Pause, 0, 1, None),
        Err(Refusal::NotFound)
    );
    assert_eq!(Refusal::OnlyOwners.text(), "Only owners can do that");
    assert_eq!(Refusal::NotFound.text(), "Not found");
}

#[test]
fn the_last_owner_can_not_leave() {
    assert_eq!(
        Application::new(&owners(&[1])).direct(1, Change::Leave),
        Err(Refusal::LastOwner)
    );
    assert_eq!(
        Refusal::LastOwner.text(),
        "You are the last owner. Add another owner or delete the application"
    );
    assert_eq!(
        Application::new(&owners(&[1, 2])).direct(1, Change::Leave),
        Ok(())
    );
    assert_eq!(
        Application::new(&owners(&[1])).direct(1, Change::RedirectAdd),
        Ok(())
    );
}

#[test]
fn three_owners_remove_the_third_with_two_votes() {
    let ms = owners(&[1, 2, 3]);
    let application = Application::new(&ms);
    let p = application
        .propose(1, Change::OwnerRemove, 0, 7, Some(3))
        .unwrap();
    assert_eq!(p.status, Status::Open);
    assert_eq!(application.vote(&p, 3, false, 1, 0), Err(Refusal::NotFound));
    let p = application.vote(&p, 2, true, 1, 0).unwrap();
    assert_eq!(p.status, Status::Applied);
    assert_eq!(application.vote(&p, 2, true, 2, 0), Err(Refusal::NotFound));
}

#[test]
fn rejected_expired_withdrawn_a_vote_can_change() {
    let ms = owners(&[1, 2, 3]);
    let application = Application::new(&ms);
    let p = propose(&ms, 1, Change::RedirectAdd, 1);
    let p = application.vote(&p, 2, false, 1, 0).unwrap();
    let p = application.vote(&p, 3, false, 1, 0).unwrap();
    assert_eq!(p.status, Status::Rejected);
    let q = propose(&ms, 1, Change::RedirectAdd, 2);
    assert_eq!(
        application.settle(q.clone(), PROPOSAL_SECS, 0).status,
        Status::Expired
    );
    assert_eq!(
        application.settle(q.clone(), PROPOSAL_SECS - 1, 0).status,
        Status::Open
    );
    assert_eq!(
        Application::new(&owners(&[2, 3])).settle(q, 5, 0).status,
        Status::Withdrawn
    );
    let r = propose(&ms, 1, Change::RedirectAdd, 3);
    let r = application.vote(&r, 2, false, 1, 0).unwrap();
    let r = application.vote(&r, 2, true, 2, 0).unwrap();
    assert_eq!(r.status, Status::Applied);
    let gone = application
        .propose(1, Change::OwnerRemove, 0, 4, Some(3))
        .unwrap();
    assert_eq!(
        Application::new(&owners(&[1, 2])).settle(gone, 1, 0).status,
        Status::Stale
    );
}

#[test]
fn no_active_owner_runs_pauses_goes() {
    assert_eq!(
        Application::new(&owners(&[1])).orphan_state(None, 0),
        Orphan::Managed
    );
    let nobody = Application::new(&[]);
    assert_eq!(nobody.orphan_state(None, 12345), Orphan::Running);
    assert_eq!(
        nobody.orphan_state(Some(0), ORPHAN_RUN_SECS - 1),
        Orphan::Running
    );
    assert_eq!(
        nobody.orphan_state(Some(0), ORPHAN_RUN_SECS),
        Orphan::Paused
    );
    assert_eq!(
        nobody.orphan_state(Some(0), ORPHAN_DELETE_SECS),
        Orphan::Delete
    );
    assert_eq!(
        Application::new(&[inactive(1)]).orphan_state(Some(0), ORPHAN_RUN_SECS),
        Orphan::Paused
    );
}

#[test]
fn limits_and_fields() {
    assert_eq!((OWNERS_MAX, STAFF_MAX), (10, 25));
    assert_eq!(INVITE_SECS, 14 * 86400);
    assert_eq!(same_field(Change::RedirectAdd), Some("redirects"));
    assert_eq!(same_field(Change::ServerSeatAdd), Some("owner"));
    assert_eq!(same_field(Change::Delete), Some("owner"));
    assert_eq!(same_field(Change::OwnerAdd), None);
    assert_eq!(kind_of(Change::Description), Kind::Anyone);
    for change in [
        Change::Pause,
        Change::Resume,
        Change::SecretIssue,
        Change::SecretRevoke,
        Change::RedirectRemove,
        Change::ScopeRemove,
        Change::StaffAdd,
        Change::StaffRemove,
        Change::Leave,
        Change::EndorseWithdraw,
        Change::Restore,
    ] {
        assert_eq!(kind_of(change), Kind::Single);
    }
    for change in [
        Change::Name,
        Change::Icon,
        Change::Links,
        Change::RedirectAdd,
        Change::LogoutUri,
        Change::ScopeAdd,
        Change::ClientType,
        Change::SubjectGroup,
        Change::LoginUri,
        Change::OwnerAdd,
        Change::OwnerRemove,
        Change::ServerSeatAdd,
        Change::EndorseRequest,
        Change::Delete,
    ] {
        assert_eq!(kind_of(change), Kind::Agreement);
    }
}

#[test]
fn an_owner_who_manages_the_seats_server_cant_cast_its_vote() {
    let ms = with(owners(&[1]), &[server_seat("lobby")]);
    let application = Application::with_managers(&ms, &[1, 5]);
    let p = application
        .propose(1, Change::RedirectAdd, 0, 1, None)
        .unwrap();
    assert_eq!(p.status, Status::Open);
    assert_eq!(
        application.seat_vote(&p, "server:lobby", 1, true, 1, 0),
        Err(Refusal::AlreadyVotes)
    );
    assert_eq!(Refusal::AlreadyVotes.text(), "You already vote as an owner");
    assert_eq!(
        application
            .seat_vote(&p, "server:lobby", 5, true, 1, 0)
            .unwrap()
            .status,
        Status::Applied
    );
    assert_eq!(
        application.seat_vote(&p, "server:lobby", 6, true, 1, 0),
        Err(Refusal::NotFound)
    );
    assert_eq!(
        application.seat_vote(&p, "server:other", 5, true, 1, 0),
        Err(Refusal::NotFound)
    );
    assert_eq!(application.seat_overlap(), [1]);
    assert_eq!(application.vote(&p, 0, true, 1, 0), Err(Refusal::NotFound));
}

#[test]
fn an_application_has_one_seat_so_no_manager_casts_another_servers_vote() {
    assert_eq!(SEATS_MAX, 1);
    let two = with(owners(&[1, 2]), &[server_seat("lobby"), server_seat("eng")]);
    let application = Application::with_managers(&two, &[5]);
    let p = application
        .propose(1, Change::RedirectAdd, 0, 1, None)
        .unwrap();
    assert_eq!(p.status, Status::Open);
    for seat in ["server:lobby", "server:eng"] {
        assert_eq!(
            application.seat_vote(&p, seat, 5, true, 1, 0),
            Err(Refusal::NotFound)
        );
    }
    assert!(application.seat_counts());
    let invited = ApplicationMember {
        state: MemberState::Invited,
        ..server_seat("eng")
    };
    let one = with(owners(&[1, 2]), &[server_seat("lobby"), invited]);
    let application = Application::with_managers(&one, &[5]);
    let p = application
        .propose(1, Change::RedirectAdd, 0, 1, None)
        .unwrap();
    assert!(
        application
            .seat_vote(&p, "server:lobby", 5, true, 1, 0)
            .is_ok()
    );
}

#[test]
fn and_cant_remove_the_other_person_owner_alone() {
    let ms = with(owners(&[1, 2]), &[server_seat("lobby")]);
    let application = Application::with_managers(&ms, &[1]);
    assert_eq!(
        application.propose(1, Change::OwnerRemove, 0, 7, Some(2)),
        Err(Refusal::TwoOwners)
    );
    let application = Application::with_managers(&ms, &[1, 5]);
    let p = application
        .propose(1, Change::OwnerRemove, 0, 7, Some(2))
        .unwrap();
    assert_eq!(p.status, Status::Open);
    assert_eq!(
        application.seat_vote(&p, "server:lobby", 1, true, 1, 0),
        Err(Refusal::AlreadyVotes)
    );
}

#[test]
fn after_30_days_the_owner_stops_counting_others_cant_remove_them_the_operator_may() {
    let ms = with(owners(&[1]), &[suspended_since(2, 0)]);
    let application = Application::new(&ms);
    assert_eq!(
        application.direct(1, Change::RedirectAdd),
        Err(Refusal::NeedsAgreement)
    );
    assert_eq!(lapse(&ms, LAPSE_SECS - 1), ms);
    let later = lapse(&ms, LAPSE_SECS);
    assert_eq!(later[1].state, MemberState::Lapsed);
    let lapsed = Application::new(&later);
    assert_eq!(lapsed.direct(1, Change::RedirectAdd), Ok(()));
    assert_eq!(
        lapsed.propose(1, Change::OwnerRemove, LAPSE_SECS, 1, Some(2)),
        Err(Refusal::SuspendedOwner)
    );
    assert!(lapsed.operator_may_remove(2));
    assert!(!lapsed.operator_may_remove(1));
    assert!(!application.operator_may_remove(2));
    let p = propose(&ms, 1, Change::Name, 3);
    assert_eq!(p.status, Status::Open);
    assert_eq!(lapsed.settle(p, LAPSE_SECS, 0).status, Status::Applied);
    assert_eq!(lapse(&[inactive(2)], i64::MAX), [inactive(2)]);
    assert_eq!(
        lapse(&[suspended_since(2, i64::MIN)], i64::MAX)[0].state,
        MemberState::Lapsed
    );
}

#[test]
fn while_an_owner_is_lapsed_adding_owners_or_a_seat_the_subject_group_and_deleting_wait_for_them() {
    let ms = with(owners(&[1]), &[suspended_since(2, 0)]);
    let later = lapse(&ms, LAPSE_SECS);
    let application = Application::new(&later);
    assert_eq!(
        LAPSE_GUARDED,
        [
            Change::OwnerAdd,
            Change::ServerSeatAdd,
            Change::SubjectGroup,
            Change::Delete
        ]
    );
    for change in LAPSE_GUARDED {
        assert_eq!(application.direct(1, change), Err(Refusal::NeedsAgreement));
        assert_eq!(
            application.threshold(change, None),
            Threshold {
                voters: vec![1, 2],
                need: 2
            }
        );
        assert!(application.waits_for_lapsed(change));
        let p = application.propose(1, change, LAPSE_SECS, 9, None).unwrap();
        assert_eq!(p.status, Status::Open);
        assert_eq!(
            application.vote(&p, 2, true, LAPSE_SECS, 0),
            Err(Refusal::NotFound)
        );
        assert_eq!(
            application
                .settle(p.clone(), LAPSE_SECS + PROPOSAL_SECS - 1, 0)
                .status,
            Status::Open
        );
        assert_eq!(
            application.settle(p, LAPSE_SECS + PROPOSAL_SECS, 0).status,
            Status::Expired
        );
    }
    assert!(!application.waits_for_lapsed(Change::RedirectAdd));
    assert!(!Application::new(&ms).waits_for_lapsed(Change::OwnerAdd));
    assert_eq!(application.direct(1, Change::Name), Ok(()));
}

#[test]
fn suspend_wait_30_days_add_owners_restore_remove_ends_with_the_original_owner_still_an_owner() {
    let ms = with(owners(&[1]), &[suspended_since(2, 0)]);
    let later = lapse(&ms, LAPSE_SECS);
    let lapsed = Application::new(&later);
    let add = lapsed
        .propose(1, Change::OwnerAdd, LAPSE_SECS, 9, None)
        .unwrap();
    assert_eq!(add.status, Status::Open);
    let back = owners(&[1, 2]);
    let returned = Application::new(&back);
    assert_eq!(
        returned.threshold(Change::Name, None),
        Threshold {
            voters: vec![1, 2],
            need: 2
        }
    );
    assert_eq!(
        returned.propose(1, Change::OwnerRemove, LAPSE_SECS + 1, 10, Some(2)),
        Err(Refusal::TwoOwners)
    );
    assert_eq!(
        returned
            .vote(&add, 2, true, LAPSE_SECS + 1, 0)
            .unwrap()
            .status,
        Status::Applied
    );
    assert_eq!(
        returned
            .vote(&add, 2, false, LAPSE_SECS + 1, 0)
            .unwrap()
            .status,
        Status::Rejected
    );
}

#[test]
fn with_three_owners_a_lapsed_one_counts_as_a_silent_voter_for_those_changes() {
    let ms = with(owners(&[1, 3]), &[suspended_since(2, 0)]);
    let later = lapse(&ms, LAPSE_SECS);
    let application = Application::new(&later);
    assert_eq!(need(&later, Change::RedirectAdd), 2);
    assert_eq!(
        application.threshold(Change::OwnerAdd, None),
        Threshold {
            voters: vec![1, 3, 2],
            need: 2
        }
    );
    let p = application
        .propose(1, Change::OwnerAdd, 0, 1, None)
        .unwrap();
    assert_eq!(
        application.vote(&p, 3, true, 1, 0).unwrap().status,
        Status::Applied
    );
}

#[test]
fn one_person_and_a_seat_only_they_manage_is_owned_by_that_person() {
    let ms = with(owners(&[1]), &[server_seat("lobby")]);
    let application = Application::with_managers(&ms, &[1]);
    assert!(!application.seat_counts());
    assert_eq!(application.counted().len(), 1);
    assert_eq!(
        application.threshold(Change::RedirectAdd, None),
        Threshold {
            voters: vec![1],
            need: 1
        }
    );
    assert_eq!(application.direct(1, Change::RedirectAdd), Ok(()));
    assert_eq!(application.direct(1, Change::OwnerAdd), Ok(()));
    assert_eq!(application.direct(1, Change::Delete), Ok(()));
    assert_eq!(
        application.direct(1, Change::Leave),
        Err(Refusal::LastOwner)
    );
    let p = application
        .propose(1, Change::RedirectAdd, 0, 1, None)
        .unwrap();
    assert_eq!(p.status, Status::Applied);
    let seat_gone = application
        .propose(1, Change::OwnerRemove, 0, 2, Some(0))
        .unwrap();
    assert_eq!(seat_gone.status, Status::Applied);
    let waiting = Application::new(&ms)
        .propose(1, Change::RedirectAdd, 0, 3, None)
        .unwrap();
    assert_eq!(waiting.status, Status::Open);
    assert_eq!(
        application.settle(waiting.clone(), 1, 0).status,
        Status::Applied
    );
    assert_eq!(
        application.seat_vote(&waiting, "server:lobby", 1, true, 1, 0),
        Err(Refusal::NotFound)
    );
}

#[test]
fn the_seat_counts_again_as_soon_as_someone_who_doesnt_vote_as_an_owner_manages_it() {
    let ms = with(owners(&[1]), &[server_seat("lobby")]);
    let counts = |managers: &[i64]| Application::with_managers(&ms, managers).seat_counts();
    assert!(counts(&[1, 5]));
    assert!(counts(&[5]));
    assert!(!counts(&[1]));
    assert!(!counts(&[1, 1]));
    assert!(Application::new(&ms).seat_counts());
    let two = with(owners(&[1, 2]), &[server_seat("lobby")]);
    for managers in [&[1][..], &[1, 2], &[2]] {
        let application = Application::with_managers(&two, managers);
        assert!(!application.seat_counts(), "{managers:?}");
        assert_eq!(
            application.threshold(Change::RedirectAdd, None),
            Threshold {
                voters: vec![1, 2],
                need: 2
            }
        );
    }
    assert_eq!(
        Application::with_managers(&two, &[1, 5]).threshold(Change::RedirectAdd, None),
        Threshold {
            voters: vec![1, 2, 0],
            need: 2
        }
    );
    let invited = with(ms.clone(), &[member(2, Role::Owner, MemberState::Invited)]);
    assert!(!Application::with_managers(&invited, &[1]).seat_counts());
    assert!(Application::with_managers(&invited, &[2]).seat_counts());
    let lapsed = with(ms.clone(), &[member(2, Role::Owner, MemberState::Lapsed)]);
    assert!(!Application::with_managers(&lapsed, &[1, 2]).seat_counts());
    let staff = with(ms, &[member(7, Role::Developer, MemberState::Active)]);
    assert!(!Application::with_managers(&staff, &[1]).seat_counts());
    assert!(Application::with_managers(&staff, &[1, 7]).seat_counts());
    assert_eq!(
        Application::with_managers(&owners(&[1]), &[1])
            .counted()
            .len(),
        1
    );
}

#[test]
fn a_seat_nobody_manages_any_more_doesnt_freeze_its_one_person() {
    let ms = with(owners(&[1]), &[server_seat("lobby")]);
    let frozen = Application::new(&ms);
    assert_eq!(frozen.direct(1, Change::Leave), Err(Refusal::NeedsPerson));
    assert_eq!(
        frozen.direct(1, Change::OwnerAdd),
        Err(Refusal::NeedsAgreement)
    );
    let application = Application::with_managers(&ms, &[]);
    assert!(!application.seat_counts());
    assert_eq!(
        application.threshold(Change::OwnerAdd, None),
        Threshold {
            voters: vec![1],
            need: 1
        }
    );
    assert_eq!(
        application.direct(1, Change::Leave),
        Err(Refusal::LastOwner)
    );
    assert_eq!(application.direct(1, Change::OwnerAdd), Ok(()));
    assert_eq!(application.direct(1, Change::Delete), Ok(()));
    assert_eq!(
        application
            .propose(1, Change::OwnerRemove, 0, 1, Some(0))
            .unwrap()
            .status,
        Status::Applied
    );
    let three = with(owners(&[1, 2, 3]), &[server_seat("lobby")]);
    assert_eq!(
        Application::with_managers(&three, &[]).threshold(Change::RedirectAdd, None),
        Threshold {
            voters: vec![1, 2, 3],
            need: 2
        }
    );
    assert_eq!(
        Application::with_managers(&three, &[5]).threshold(Change::RedirectAdd, None),
        Threshold {
            voters: vec![1, 2, 3, 0],
            need: 3
        }
    );
}
