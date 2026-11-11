use crate::health::{Event, Refused};
use crate::levels::Service;
use crate::limits::HOLD_MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    Ok,
    Transport,
    Internal,
    NotFound,
    Unauthenticated,
    Unavailable,
    ResourceExhausted,
    FailedPrecondition,
    PermissionDenied,
    InvalidArgument,
    Unimplemented,
    BadReply,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Refused,
    Paused,
    Version,
    Identity,
    HelloNeeded,
    Busy,
    StampNeeded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Answer {
    pub code: Code,
    pub refusal: Option<Refusal>,
    pub until: Option<i64>,
    pub retry_after: Option<i64>,
    pub now: Option<i64>,
    pub their_now: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Job {
    Done,
    Retry,
    HelloThenRetry,
    StampThenHello,
    Fail,
    Hold,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub job: Job,
    pub wait: Option<i64>,
    pub event: Option<Event>,
}

const DEFAULT_WAIT: i64 = 60;

pub fn outcome(svc: Service, a: &Answer) -> Outcome {
    let Answer {
        code,
        refusal,
        until,
        retry_after,
        now,
        their_now,
    } = *a;
    let wait = retry_after.map(|secs| secs.min(HOLD_MAX));
    let held = wait.unwrap_or(DEFAULT_WAIT);
    let hold_until = now.unwrap_or(0) + held;
    let done = |job, wait, event| Outcome { job, wait, event };
    let fail = |unauthenticated| Event::OutFail {
        svc,
        unauthenticated,
        their_now,
    };
    let refused = |reason, until| Event::OutRefused { svc, reason, until };
    match (code, refusal) {
        (Code::Ok, _) => done(Job::Done, None, Some(Event::OutOk { svc })),
        (Code::Transport | Code::Internal, _) => done(Job::Retry, None, Some(fail(false))),
        (Code::NotFound | Code::Unauthenticated, _) => {
            done(Job::HelloThenRetry, None, Some(fail(true)))
        }
        (Code::Unavailable, Some(Refusal::Paused)) => {
            done(Job::Hold, wait, Some(refused(Refused::Paused, until)))
        }
        (Code::Unavailable, Some(Refusal::Busy)) => {
            let busy = Event::OutBusy { until: hold_until };
            done(Job::Retry, Some(held), Some(busy))
        }
        (Code::Unavailable, Some(Refusal::StampNeeded)) => done(Job::StampThenHello, None, None),
        (Code::Unavailable, _) => done(Job::Retry, wait, Some(fail(false))),
        (Code::ResourceExhausted, _) => {
            let limited = Event::OutLimited {
                svc,
                until: hold_until,
            };
            done(Job::Retry, Some(held), Some(limited))
        }
        (Code::FailedPrecondition, Some(Refusal::HelloNeeded)) => done(
            Job::HelloThenRetry,
            None,
            Some(refused(Refused::HelloNeeded, None)),
        ),
        (Code::FailedPrecondition | Code::Unimplemented, _) => done(
            Job::HelloThenRetry,
            None,
            Some(refused(Refused::Version, None)),
        ),
        (Code::PermissionDenied, Some(Refusal::Identity)) => {
            done(Job::Hold, None, Some(refused(Refused::Identity, None)))
        }
        (Code::PermissionDenied, _) => done(Job::Fail, None, Some(refused(Refused::Refused, None))),
        (Code::InvalidArgument, _) => done(Job::Fail, None, None),
        (Code::BadReply, _) => done(Job::Retry, None, Some(Event::OutBadReply { svc })),
    }
}
