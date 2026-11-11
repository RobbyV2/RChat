use rchat_fed::health::{Event, LinkState, Refused, Support, fresh, step, view};
use rchat_fed::levels::Service;
use rchat_fed::outcomes::{Answer, Code, Job, Outcome, Refusal, outcome};

use crate::support::{T0, hello, ours, said};

use Service::Letters;

fn answer(code: Code) -> Answer {
    Answer {
        code,
        refusal: None,
        until: None,
        retry_after: None,
        now: None,
        their_now: None,
    }
}

fn refusal(code: Code, refusal: Refusal) -> Answer {
    Answer {
        refusal: Some(refusal),
        ..answer(code)
    }
}

fn job(a: Answer) -> Job {
    outcome(Letters, &a).job
}

#[test]
fn each_answer_has_one_job_outcome() {
    assert_eq!(job(answer(Code::Ok)), Job::Done);
    assert_eq!(job(answer(Code::Transport)), Job::Retry);
    assert_eq!(job(answer(Code::Internal)), Job::Retry);
    assert_eq!(job(answer(Code::NotFound)), Job::HelloThenRetry);
    assert_eq!(job(answer(Code::Unauthenticated)), Job::HelloThenRetry);
    assert_eq!(
        job(Answer {
            retry_after: Some(30),
            ..answer(Code::Unavailable)
        }),
        Job::Retry
    );
    assert_eq!(
        job(Answer {
            until: Some(T0 + 600),
            ..refusal(Code::Unavailable, Refusal::Paused)
        }),
        Job::Hold
    );
    assert_eq!(
        job(Answer {
            retry_after: Some(30),
            ..refusal(Code::Unavailable, Refusal::Busy)
        }),
        Job::Retry
    );
    assert_eq!(
        job(refusal(Code::Unavailable, Refusal::StampNeeded)),
        Job::StampThenHello
    );
    assert_eq!(
        job(Answer {
            retry_after: Some(20),
            ..answer(Code::ResourceExhausted)
        }),
        Job::Retry
    );
    assert_eq!(
        job(refusal(Code::FailedPrecondition, Refusal::Version)),
        Job::HelloThenRetry
    );
    assert_eq!(
        job(refusal(Code::FailedPrecondition, Refusal::HelloNeeded)),
        Job::HelloThenRetry
    );
    assert_eq!(
        job(refusal(Code::PermissionDenied, Refusal::Refused)),
        Job::Fail
    );
    assert_eq!(
        job(refusal(Code::PermissionDenied, Refusal::Identity)),
        Job::Hold
    );
    assert_eq!(job(answer(Code::InvalidArgument)), Job::Fail);
    assert_eq!(job(answer(Code::Unimplemented)), Job::HelloThenRetry);
    assert_eq!(job(answer(Code::BadReply)), Job::Retry);
}

#[test]
fn each_answer_has_its_health_event() {
    let event = |a: Answer| outcome(Letters, &a).event;
    let fail = |unauthenticated: bool| {
        Some(Event::OutFail {
            svc: Letters,
            unauthenticated,
            their_now: Some(T0 + 9),
        })
    };
    let dated = |code: Code| Answer {
        their_now: Some(T0 + 9),
        ..answer(code)
    };
    let refused = |reason: Refused, until: Option<i64>| {
        Some(Event::OutRefused {
            svc: Letters,
            reason,
            until,
        })
    };
    assert_eq!(event(answer(Code::Ok)), Some(Event::OutOk { svc: Letters }));
    assert_eq!(event(dated(Code::Transport)), fail(false));
    assert_eq!(event(dated(Code::Internal)), fail(false));
    assert_eq!(event(dated(Code::Unavailable)), fail(false));
    assert_eq!(event(dated(Code::NotFound)), fail(true));
    assert_eq!(event(dated(Code::Unauthenticated)), fail(true));
    assert_eq!(
        event(Answer {
            until: Some(T0 + 600),
            ..refusal(Code::Unavailable, Refusal::Paused)
        }),
        refused(Refused::Paused, Some(T0 + 600))
    );
    assert_eq!(
        event(refusal(Code::Unavailable, Refusal::StampNeeded)),
        None
    );
    assert_eq!(
        event(refusal(Code::FailedPrecondition, Refusal::HelloNeeded)),
        refused(Refused::HelloNeeded, None)
    );
    assert_eq!(
        event(refusal(Code::FailedPrecondition, Refusal::Version)),
        refused(Refused::Version, None)
    );
    assert_eq!(
        event(answer(Code::FailedPrecondition)),
        refused(Refused::Version, None)
    );
    assert_eq!(
        event(answer(Code::Unimplemented)),
        refused(Refused::Version, None)
    );
    assert_eq!(
        event(refusal(Code::PermissionDenied, Refusal::Identity)),
        refused(Refused::Identity, None)
    );
    assert_eq!(
        event(refusal(Code::PermissionDenied, Refusal::Refused)),
        refused(Refused::Refused, None)
    );
    assert_eq!(
        event(answer(Code::PermissionDenied)),
        refused(Refused::Refused, None)
    );
    assert_eq!(event(answer(Code::InvalidArgument)), None);
    assert_eq!(
        event(answer(Code::BadReply)),
        Some(Event::OutBadReply { svc: Letters })
    );
}

#[test]
fn retry_after_is_honoured_at_most_an_hour() {
    let limited = |retry_after: Option<i64>| {
        outcome(
            Letters,
            &Answer {
                retry_after,
                now: Some(T0),
                ..answer(Code::ResourceExhausted)
            },
        )
    };
    assert_eq!(limited(Some(1_000_000)).wait, Some(3600));
    assert_eq!(limited(Some(20)).wait, Some(20));
    assert_eq!(
        limited(None),
        Outcome {
            job: Job::Retry,
            wait: Some(60),
            event: Some(Event::OutLimited {
                svc: Letters,
                until: T0 + 60
            })
        }
    );
    assert_eq!(outcome(Letters, &answer(Code::Unavailable)).wait, None);
}

#[test]
fn a_day_of_404s_from_a_host_announcing_the_protocol_never_shelves_it_as_unsupported() {
    let ours = ours();
    let mut h = step(&fresh("b.example", None), &said(hello(), T0), T0, &ours);
    for i in 0..200 {
        let now = T0 + i * 400;
        let not_found = Answer {
            their_now: Some(now),
            ..answer(Code::NotFound)
        };
        if let Some(e) = outcome(Letters, &not_found).event {
            h = step(&h, &e, now, &ours);
        }
    }
    assert_eq!(view(&h, &ours, T0 + 80_000).state, LinkState::Degraded);
    assert_eq!(h.support, Support::Rchat);
}

#[test]
fn a_429_holds_that_service_for_everyone_and_busy_holds_the_whole_destination() {
    let limited = Answer {
        retry_after: Some(20),
        now: Some(T0),
        ..answer(Code::ResourceExhausted)
    };
    assert_eq!(
        outcome(Letters, &limited).event,
        Some(Event::OutLimited {
            svc: Letters,
            until: T0 + 20
        })
    );
    let busy = Answer {
        retry_after: Some(45),
        now: Some(T0),
        ..refusal(Code::Unavailable, Refusal::Busy)
    };
    assert_eq!(
        outcome(Letters, &busy),
        Outcome {
            job: Job::Retry,
            wait: Some(45),
            event: Some(Event::OutBusy { until: T0 + 45 })
        }
    );
}
