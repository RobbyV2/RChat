use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Owner,
    Developer,
    Viewer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemberState {
    Active,
    Invited,
    Inactive,
    Lapsed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplicationMember {
    pub uid: i64,
    pub role: Role,
    pub state: MemberState,
    pub seat: Option<String>,
    pub inactive_since: Option<i64>,
}

pub const LAPSE_SECS: i64 = 30 * 86400;
pub const PROPOSAL_SECS: i64 = 14 * 86400;
pub const TIME_LOCK_SECS: i64 = 14 * 86400;
pub const RESTORE_SECS: i64 = 14 * 86400;
pub const ORPHAN_RUN_SECS: i64 = 30 * 86400;
pub const ORPHAN_DELETE_SECS: i64 = 180 * 86400;
pub const INVITE_SECS: i64 = 14 * 86400;
pub const OWNERS_MAX: usize = 10;
pub const SEATS_MAX: usize = 1;
pub const STAFF_MAX: usize = 25;
pub const DEADLOCK_WAYS: [&str; 4] = ["pause", "leave", "time_locked_request", "ask_site"];

pub fn lapse(ms: &[ApplicationMember], now: i64) -> Vec<ApplicationMember> {
    ms.iter()
        .map(|m| {
            let due = m.state == MemberState::Inactive
                && m.inactive_since
                    .is_some_and(|since| now.saturating_sub(since) >= LAPSE_SECS);
            ApplicationMember {
                state: match due {
                    true => MemberState::Lapsed,
                    false => m.state,
                },
                ..m.clone()
            }
        })
        .collect()
}

pub fn server_seat(server: &str) -> ApplicationMember {
    ApplicationMember {
        uid: 0,
        role: Role::Owner,
        state: MemberState::Active,
        seat: Some(format!("server:{server}")),
        inactive_since: None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    Description,
    Pause,
    Resume,
    SecretIssue,
    SecretRevoke,
    RedirectRemove,
    ScopeRemove,
    StaffAdd,
    StaffRemove,
    Leave,
    EndorseWithdraw,
    Restore,
    Name,
    Icon,
    Links,
    RedirectAdd,
    LogoutUri,
    ScopeAdd,
    ClientType,
    SubjectGroup,
    LoginUri,
    OwnerAdd,
    OwnerRemove,
    ServerSeatAdd,
    EndorseRequest,
    Delete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Anyone,
    Single,
    Agreement,
}

pub fn kind_of(change: Change) -> Kind {
    match change {
        Change::Description => Kind::Anyone,
        Change::Pause
        | Change::Resume
        | Change::SecretIssue
        | Change::SecretRevoke
        | Change::RedirectRemove
        | Change::ScopeRemove
        | Change::StaffAdd
        | Change::StaffRemove
        | Change::Leave
        | Change::EndorseWithdraw
        | Change::Restore => Kind::Single,
        Change::Name
        | Change::Icon
        | Change::Links
        | Change::RedirectAdd
        | Change::LogoutUri
        | Change::ScopeAdd
        | Change::ClientType
        | Change::SubjectGroup
        | Change::LoginUri
        | Change::OwnerAdd
        | Change::OwnerRemove
        | Change::ServerSeatAdd
        | Change::EndorseRequest
        | Change::Delete => Kind::Agreement,
    }
}

pub const TIME_LOCKABLE: [Change; 4] = [
    Change::Name,
    Change::Icon,
    Change::Links,
    Change::EndorseRequest,
];

// What a lapsed owner still has a say in: nothing done while they were away may remove them or
// thin out their vote.
pub const LAPSE_GUARDED: [Change; 4] = [
    Change::OwnerAdd,
    Change::ServerSeatAdd,
    Change::SubjectGroup,
    Change::Delete,
];

pub const RESTORABLE: [Change; 4] = [
    Change::RedirectRemove,
    Change::ScopeRemove,
    Change::Pause,
    Change::SecretRevoke,
];

pub fn same_field(change: Change) -> Option<&'static str> {
    match change {
        Change::Name => Some("name"),
        Change::Icon => Some("icon"),
        Change::Links => Some("links"),
        Change::RedirectAdd => Some("redirects"),
        Change::LogoutUri => Some("logout"),
        Change::ScopeAdd => Some("scopes"),
        Change::ClientType => Some("client_type"),
        Change::SubjectGroup => Some("subject_group"),
        Change::LoginUri => Some("login_uri"),
        Change::ServerSeatAdd | Change::Delete => Some("owner"),
        Change::Description
        | Change::Pause
        | Change::Resume
        | Change::SecretIssue
        | Change::SecretRevoke
        | Change::RedirectRemove
        | Change::ScopeRemove
        | Change::StaffAdd
        | Change::StaffRemove
        | Change::Leave
        | Change::EndorseWithdraw
        | Change::Restore
        | Change::OwnerAdd
        | Change::OwnerRemove
        | Change::EndorseRequest => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    NotFound,
    OnlyOwners,
    LastOwner,
    TwoOwners,
    SuspendedOwner,
    NeedsPerson,
    NeedsAgreement,
    NothingToRestore,
    AlreadyVotes,
}

impl Refusal {
    pub fn text(self) -> &'static str {
        match self {
            Refusal::NotFound => "Not found",
            Refusal::OnlyOwners => "Only owners can do that",
            Refusal::LastOwner => {
                "You are the last owner. Add another owner or delete the application"
            }
            Refusal::TwoOwners => "Two owners can not remove each other. Either of you can leave",
            Refusal::SuspendedOwner => {
                "Application can not be removed while their account is suspended"
            }
            Refusal::NeedsPerson => "An application needs at least one person as owner",
            Refusal::NeedsAgreement => "Needs agreement",
            Refusal::NothingToRestore => "Nothing to restore",
            Refusal::AlreadyVotes => "You already vote as an owner",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Open,
    Applied,
    Rejected,
    Withdrawn,
    Expired,
    Stale,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proposal {
    pub id: i64,
    pub change: Change,
    pub target: Option<i64>,
    pub proposer: i64,
    pub yes: BTreeSet<i64>,
    pub no: BTreeSet<i64>,
    pub created_at: i64,
    pub status: Status,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Threshold {
    pub voters: Vec<i64>,
    pub need: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Removal {
    pub change: Change,
    pub by: i64,
    pub at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Orphan {
    Managed,
    Running,
    Paused,
    Delete,
}

fn suspended(m: &ApplicationMember) -> bool {
    matches!(m.state, MemberState::Inactive | MemberState::Lapsed)
}

#[derive(Clone, Copy, Debug)]
pub struct Application<'a> {
    pub members: &'a [ApplicationMember],
    pub seat_managers: Option<&'a [i64]>,
}

impl<'a> Application<'a> {
    pub fn new(members: &'a [ApplicationMember]) -> Application<'a> {
        Application {
            members,
            seat_managers: None,
        }
    }

    pub fn with_managers(
        members: &'a [ApplicationMember],
        seat_managers: &'a [i64],
    ) -> Application<'a> {
        Application {
            members,
            seat_managers: Some(seat_managers),
        }
    }

    fn votes_as_owner(&self, uid: i64) -> bool {
        self.members.iter().any(|m| {
            m.uid == uid
                && m.role == Role::Owner
                && m.seat.is_none()
                && m.state != MemberState::Invited
        })
    }

    // A seat counts only while one of its managers could cast its vote. Without the managers
    // given, it counts.
    pub fn seat_counts(&self) -> bool {
        self.seat_managers
            .is_none_or(|managers| managers.iter().any(|u| !self.votes_as_owner(*u)))
    }

    fn voters_for(&self, change: Option<Change>) -> Vec<&'a ApplicationMember> {
        let seat_counts = self.seat_counts();
        let guarded = change.is_some_and(|c| LAPSE_GUARDED.contains(&c));
        self.members
            .iter()
            .filter(|m| m.role == Role::Owner)
            .filter(|m| match m.state {
                MemberState::Active | MemberState::Inactive => seat_counts || m.seat.is_none(),
                MemberState::Lapsed => guarded,
                MemberState::Invited => false,
            })
            .collect()
    }

    pub fn counted(&self) -> Vec<&'a ApplicationMember> {
        self.voters_for(None)
    }

    pub fn active_owners(&self) -> Vec<&'a ApplicationMember> {
        self.members
            .iter()
            .filter(|m| m.role == Role::Owner && m.state == MemberState::Active)
            .collect()
    }

    pub fn account_owners(&self) -> Vec<&'a ApplicationMember> {
        self.counted()
            .into_iter()
            .filter(|m| m.seat.is_none())
            .collect()
    }

    pub fn waits_for_lapsed(&self, change: Change) -> bool {
        LAPSE_GUARDED.contains(&change)
            && self
                .members
                .iter()
                .any(|m| m.role == Role::Owner && m.state == MemberState::Lapsed)
    }

    pub fn operator_may_remove(&self, uid: i64) -> bool {
        self.members
            .iter()
            .any(|m| m.uid == uid && m.role == Role::Owner && m.state == MemberState::Lapsed)
    }

    pub fn threshold(&self, change: Change, target: Option<i64>) -> Threshold {
        let counted = self.voters_for(Some(change));
        let voters: Vec<i64> = counted
            .iter()
            .map(|m| m.uid)
            .filter(|u| !(change == Change::OwnerRemove && Some(*u) == target))
            .collect();
        let need = match counted.len() <= 1 {
            true => 1,
            false => (voters.len() / 2 + 1).max(2),
        };
        Threshold { voters, need }
    }

    pub fn direct(&self, actor: i64, change: Change) -> Result<(), Refusal> {
        let me = self
            .members
            .iter()
            .find(|m| m.uid == actor && m.state == MemberState::Active && m.seat.is_none())
            .ok_or(Refusal::NotFound)?;
        match (kind_of(change), me.role, change) {
            (Kind::Anyone, Role::Viewer, _) => Err(Refusal::OnlyOwners),
            (Kind::Anyone, Role::Owner | Role::Developer, _) => Ok(()),
            (_, Role::Developer | Role::Viewer, Change::Leave) => Ok(()),
            (_, Role::Developer | Role::Viewer, _) => Err(Refusal::OnlyOwners),
            (_, Role::Owner, Change::Leave) => {
                match (self.counted().len(), self.account_owners().len()) {
                    (1, _) => Err(Refusal::LastOwner),
                    (_, 1) => Err(Refusal::NeedsPerson),
                    (_, _) => Ok(()),
                }
            }
            (Kind::Single, Role::Owner, _) => Ok(()),
            (Kind::Agreement, Role::Owner, _) => match self.voters_for(Some(change)).len() {
                1 => Ok(()),
                _ => Err(Refusal::NeedsAgreement),
            },
        }
    }

    pub fn propose(
        &self,
        actor: i64,
        change: Change,
        now: i64,
        id: i64,
        target: Option<i64>,
    ) -> Result<Proposal, Refusal> {
        let owner = self
            .active_owners()
            .into_iter()
            .any(|m| m.uid == actor && m.seat.is_none());
        if !owner {
            let member = self
                .members
                .iter()
                .any(|m| m.uid == actor && m.state == MemberState::Active);
            return Err(match member {
                true => Refusal::OnlyOwners,
                false => Refusal::NotFound,
            });
        }
        if kind_of(change) != Kind::Agreement {
            return Err(Refusal::NotFound);
        }
        if change == Change::OwnerRemove {
            let removed = self
                .members
                .iter()
                .find(|m| Some(m.uid) == target && m.role == Role::Owner)
                .filter(|m| m.uid != actor)
                .ok_or(Refusal::NotFound)?;
            if suspended(removed) {
                return Err(Refusal::SuspendedOwner);
            }
            let Threshold { voters, need } = self.threshold(change, target);
            if need > voters.len() {
                return Err(Refusal::TwoOwners);
            }
            if removed.seat.is_none() && self.account_owners().len() == 1 {
                return Err(Refusal::NeedsPerson);
            }
        }
        let proposal = Proposal {
            id,
            change,
            target,
            proposer: actor,
            yes: BTreeSet::from([actor]),
            no: BTreeSet::new(),
            created_at: now,
            status: Status::Open,
        };
        Ok(self.settle(proposal, now, now))
    }

    pub fn settle(&self, p: Proposal, now: i64, active_since: i64) -> Proposal {
        if p.status != Status::Open {
            return p;
        }
        let closed = |status: Status| Proposal {
            status,
            ..p.clone()
        };
        let Threshold { voters, need } = self.threshold(p.change, p.target);
        if p.change == Change::OwnerRemove {
            let removed = self
                .members
                .iter()
                .find(|m| Some(m.uid) == p.target && m.role == Role::Owner);
            match removed {
                None => return closed(Status::Stale),
                Some(m) if suspended(m) => return p,
                Some(_) => {}
            }
        }
        if !voters.contains(&p.proposer) {
            return closed(Status::Withdrawn);
        }
        let yes = p.yes.iter().filter(|u| voters.contains(u)).count();
        let no = p.no.iter().filter(|u| voters.contains(u)).count();
        if yes >= need {
            return closed(Status::Applied);
        }
        if voters.len().saturating_sub(no) < need {
            return closed(Status::Rejected);
        }
        let age = now.saturating_sub(p.created_at);
        let everyone_could_answer = active_since <= p.created_at
            && self
                .counted()
                .iter()
                .all(|m| m.state == MemberState::Active);
        let time_locked = age >= TIME_LOCK_SECS
            && TIME_LOCKABLE.contains(&p.change)
            && no == 0
            && everyone_could_answer;
        match (time_locked, age >= PROPOSAL_SECS) {
            (true, _) => closed(Status::Applied),
            (false, true) => closed(Status::Expired),
            (false, false) => p,
        }
    }

    fn cast(&self, p: &Proposal, voter: i64, yes: bool, now: i64, active_since: i64) -> Proposal {
        let mut next = p.clone();
        next.yes.remove(&voter);
        next.no.remove(&voter);
        match yes {
            true => next.yes.insert(voter),
            false => next.no.insert(voter),
        };
        self.settle(next, now, active_since)
    }

    pub fn vote(
        &self,
        p: &Proposal,
        actor: i64,
        yes: bool,
        now: i64,
        active_since: i64,
    ) -> Result<Proposal, Refusal> {
        let voter = self.members.iter().find(|m| m.uid == actor);
        let may = p.status == Status::Open
            && voter.is_some_and(|m| m.seat.is_none() && m.state == MemberState::Active)
            && self.threshold(p.change, p.target).voters.contains(&actor);
        match may {
            true => Ok(self.cast(p, actor, yes, now, active_since)),
            false => Err(Refusal::NotFound),
        }
    }

    pub fn seat_vote(
        &self,
        p: &Proposal,
        seat: &str,
        caster: i64,
        yes: bool,
        now: i64,
        active_since: i64,
    ) -> Result<Proposal, Refusal> {
        let seats = self
            .members
            .iter()
            .filter(|m| m.seat.is_some() && m.state != MemberState::Invited)
            .count();
        if p.status != Status::Open || seats > SEATS_MAX {
            return Err(Refusal::NotFound);
        }
        let held = self
            .members
            .iter()
            .find(|m| m.seat.as_deref() == Some(seat) && m.state == MemberState::Active)
            .filter(|m| self.threshold(p.change, p.target).voters.contains(&m.uid))
            .ok_or(Refusal::NotFound)?;
        if !self.seat_managers.unwrap_or(&[]).contains(&caster) {
            return Err(Refusal::NotFound);
        }
        match self.votes_as_owner(caster) {
            true => Err(Refusal::AlreadyVotes),
            false => Ok(self.cast(p, held.uid, yes, now, active_since)),
        }
    }

    pub fn seat_overlap(&self) -> Vec<i64> {
        self.seat_managers
            .unwrap_or(&[])
            .iter()
            .copied()
            .filter(|u| {
                self.members
                    .iter()
                    .any(|m| m.uid == *u && m.role == Role::Owner && m.seat.is_none())
            })
            .collect()
    }

    pub fn can_restore(&self, actor: i64, removal: &Removal, now: i64) -> Result<(), Refusal> {
        self.direct(actor, Change::Restore)?;
        let live =
            RESTORABLE.contains(&removal.change) && now.saturating_sub(removal.at) < RESTORE_SECS;
        match live {
            true => Ok(()),
            false => Err(Refusal::NothingToRestore),
        }
    }

    pub fn orphan_state(&self, orphaned_at: Option<i64>, now: i64) -> Orphan {
        if !self.active_owners().is_empty() {
            return Orphan::Managed;
        }
        let gone_for = now.saturating_sub(orphaned_at.unwrap_or(now));
        match (gone_for >= ORPHAN_DELETE_SECS, gone_for >= ORPHAN_RUN_SECS) {
            (true, _) => Orphan::Delete,
            (false, true) => Orphan::Paused,
            (false, false) => Orphan::Running,
        }
    }
}
