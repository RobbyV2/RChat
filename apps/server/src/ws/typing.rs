use std::time::Duration;

use tokio::time::Instant;

use super::access::Access;
use super::event::WsEvent;
use super::{TYPING_BURST, TYPING_RATE, TYPING_REFRESH, TYPING_SCOPE_MAX, TYPING_TTL};

use crate::api::access::{TypingPlace, typing_scope, ws_typing_place};
use crate::db::{Db, now};
use crate::limits::bucket::{Policy, Single};
use crate::state::AppState;

fn typing_event(place: &TypingPlace, scope: &str, username: &str, until: i64) -> WsEvent {
    let TypingPlace {
        server,
        channel_id,
        dm_id,
        dm_users,
        display_name,
    } = place.clone();
    WsEvent::Typing {
        server,
        channel_id,
        dm_id,
        dm_users,
        scope: scope.to_string(),
        username: username.to_string(),
        display_name,
        until,
    }
}

// One connection's typing indicator: at most one scope at a time, checked against the send
// gate whenever it is shown again. Starts are paced; a stop only ends the one shown.
pub(super) struct Typer {
    pub(super) bucket: Single,
    active: Option<(String, TypingPlace, Instant)>,
}

impl Typer {
    pub(super) fn new() -> Typer {
        Typer {
            bucket: Single::new(
                Policy::Tokens {
                    burst: TYPING_BURST,
                    per_sec: TYPING_RATE,
                },
                Instant::now(),
            ),
            active: None,
        }
    }

    pub(super) fn stop(&mut self, user: &str) -> Option<WsEvent> {
        let (scope, place, at) = self.active.take()?;
        (at.elapsed() < Duration::from_secs(TYPING_TTL as u64))
            .then(|| typing_event(&place, &scope, user, 0))
    }

    // The events a `typing` (`on`) or `typing_stop` command gives, in order.
    pub(super) async fn command(
        &mut self,
        db: &Db,
        user: &str,
        scope: String,
        on: bool,
    ) -> Vec<WsEvent> {
        let at = Instant::now();
        let Some(scope) = (scope.len() <= TYPING_SCOPE_MAX)
            .then(|| typing_scope(&scope))
            .flatten()
            .map(|(kind, id)| format!("{kind}{id}"))
        else {
            return Vec::new();
        };
        let same = self.active.as_ref().is_some_and(|(s, _, _)| *s == scope);
        if !on {
            return match same {
                true => self.stop(user).into_iter().collect(),
                false => Vec::new(),
            };
        }
        if same
            && let Some((_, _, since)) = &self.active
            && at.duration_since(*since) < TYPING_REFRESH
        {
            return Vec::new();
        }
        if self.bucket.spend(1.0, at) < 0.0 {
            return Vec::new();
        }
        let place = ws_typing_place(&crate::ws::LAYER, db, user, &scope).await;
        let mut out: Vec<WsEvent> = match (same, &place) {
            (true, Some(_)) => {
                self.active = None;
                Vec::new()
            }
            (_, _) => self.stop(user).into_iter().collect(),
        };
        if let Some(place) = place {
            out.push(typing_event(&place, &scope, user, now() + TYPING_TTL));
            self.active = Some((scope, place, at));
        }
        out
    }
}

// DM typing is checked against blocks on the primary, so a block takes effect at once.
pub(super) fn typing_db(state: &AppState, scope: &str) -> Db {
    match scope.starts_with('d') {
        true => state.db.clone(),
        false => state.read(),
    }
}

pub(super) async fn type_in(
    state: &AppState,
    access: &Access,
    typer: &mut Typer,
    scope: String,
    on: bool,
) {
    let Some(user) = access.user.as_deref() else {
        return;
    };
    if on && access.retry.pending() {
        return;
    }
    for ev in typer
        .command(&typing_db(state, &scope), user, scope, on)
        .await
    {
        let shows = matches!(&ev, WsEvent::Typing { until, .. } if *until > 0);
        if !shows || state.hub.typing_ok(user) {
            state.hub.broadcast(ev);
        }
    }
}
