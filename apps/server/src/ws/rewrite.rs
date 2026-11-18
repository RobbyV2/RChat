use axum::extract::ws::Utf8Bytes;
use tokio::time::Instant;

use super::access::{Access, channel_gate, deleted_gate};
use super::event::WsEvent;

use crate::api::access::ws_sees_timeouts;
use crate::api::categories::seen_version;
use crate::api::{Channel, ChannelLayout, LayoutCategory};
use crate::hub::Hub;
use crate::state::AppState;

pub(super) fn client_frame(fanned: &crate::fanout::Fanned, me: Option<&str>) -> Option<Utf8Bytes> {
    match (&fanned.ev, me) {
        (WsEvent::MembersPurged { server, usernames }, Some(me))
            if usernames.iter().any(|u| u == me) =>
        {
            serde_json::to_string(&WsEvent::MemberKicked {
                server: server.clone(),
                username: me.to_string(),
                banned: false,
            })
            .ok()
            .map(Utf8Bytes::from)
        }
        (
            WsEvent::MemberTimeout {
                server: _,
                username,
                until: _,
                remaining: _,
                reason: _,
            },
            Some(me),
        ) if username == me => None,
        (
            WsEvent::LayoutChanged {
                server: _,
                layout: _,
                created: _,
                deleted: _,
                before: _,
                after: _,
            }
            | WsEvent::ChannelCreated {
                server: _,
                channel: _,
            }
            | WsEvent::ChannelRenamed {
                server: _,
                channel: _,
            }
            | WsEvent::ChannelUpdated {
                server: _,
                channel: _,
            },
            _,
        ) => None,
        (_, _) => fanned.frame(),
    }
}

/// A `member_timeout` about the connection's own user: without the reason unless they hold
/// Timeout members themselves. `Some(None)` for other events; `None` when the connection must
/// close.
pub(super) async fn own_timeout(
    state: &AppState,
    access: &mut Access,
    ev: &WsEvent,
) -> Option<Option<WsEvent>> {
    let WsEvent::MemberTimeout {
        server,
        username,
        until,
        remaining,
        reason,
    } = ev
    else {
        return Some(None);
    };
    if access.user.as_deref() != Some(username.as_str()) {
        return Some(None);
    }
    let started = Instant::now();
    let sees = match ws_sees_timeouts(&state.read(), server, username, access.site_admin).await {
        Ok(sees) => sees,
        Err(e) => return access.hold(e, started).then_some(None),
    };
    Some(Some(WsEvent::MemberTimeout {
        server: server.clone(),
        username: username.clone(),
        until: *until,
        remaining: *remaining,
        reason: reason.clone().filter(|_| sees),
    }))
}

/// `poll_updated` of an open `after_vote` poll for a connection whose account voted in it:
/// with the counts the shared event leaves out. `None` for everything else.
pub(super) async fn poll_for(state: &AppState, access: &Access, ev: &WsEvent) -> Option<WsEvent> {
    let WsEvent::PollUpdated {
        server,
        channel_id,
        dm_id,
        dm_users,
        message_id,
        thread_root_id,
        created_at,
        poll,
    } = ev
    else {
        return None;
    };
    if poll.results.is_some()
        || poll.closed
        || poll.show_results != crate::api::polls::ShowResults::AfterVote
    {
        return None;
    }
    let (user, since) = (access.user.as_deref()?, access.since?);
    let results =
        crate::api::polls::voter_results(&state.read(), *message_id, poll.anonymous, user, since)
            .await?;
    Some(WsEvent::PollUpdated {
        server: server.clone(),
        channel_id: *channel_id,
        dm_id: *dm_id,
        dm_users: dm_users.clone(),
        message_id: *message_id,
        thread_root_id: *thread_root_id,
        created_at: *created_at,
        poll: Box::new(crate::api::polls::Poll {
            results: Some(results),
            ..(**poll).clone()
        }),
    })
}

/// `messages_deleted` for a connection with a read-history floor in its channel: only the ids it
/// could read. `None` when the shared event fits (or for other events).
pub(super) async fn deleted_for(
    state: &AppState,
    access: &mut Access,
    ev: &WsEvent,
) -> Option<WsEvent> {
    let WsEvent::MessagesDeleted {
        server: Some(server),
        channel_id: Some(cid),
        dm_id,
        dm_users,
        thread_root_id,
        ids,
        created,
    } = ev
    else {
        return None;
    };
    let floor = access.floor(state, server, *cid).await??;
    if created.len() == ids.len() && created.iter().all(|c| *c >= floor) {
        return None;
    }
    let (ids, created): (Vec<i64>, Vec<i64>) = ids
        .iter()
        .zip(created)
        .filter(|(_, c)| **c >= floor)
        .map(|(i, c)| (*i, *c))
        .unzip();
    Some(WsEvent::MessagesDeleted {
        server: Some(server.clone()),
        channel_id: Some(*cid),
        dm_id: *dm_id,
        dm_users: dm_users.clone(),
        thread_root_id: *thread_root_id,
        ids,
        created,
    })
}

/// A channel event for one connection, with the channel's `position` counted among the channels
/// that connection can see. `Some(None)` for other events or when the order can't be loaded;
/// `None` when the connection must close.
pub(super) async fn channel_for(
    state: &AppState,
    access: &mut Access,
    fanned: &crate::fanout::Fanned,
) -> Option<Option<WsEvent>> {
    let (server, channel) = match &fanned.ev {
        WsEvent::ChannelCreated { server, channel }
        | WsEvent::ChannelRenamed { server, channel }
        | WsEvent::ChannelUpdated { server, channel } => (server, channel),
        _ => return Some(None),
    };
    let started = Instant::now();
    let order = match fanned.channel_order(&state.read(), server).await {
        Ok(order) => order,
        Err(e) => return access.hold(e, started).then_some(None),
    };
    let mut position = 0;
    for cid in order.iter().take_while(|c| **c != channel.id) {
        if channel_gate(state, access, server, *cid).await? {
            position += 1;
        }
    }
    let channel = Channel {
        position,
        ..channel.clone()
    };
    let server = server.clone();
    Some(Some(match &fanned.ev {
        WsEvent::ChannelCreated {
            server: _,
            channel: _,
        } => WsEvent::ChannelCreated { server, channel },
        WsEvent::ChannelRenamed {
            server: _,
            channel: _,
        } => WsEvent::ChannelRenamed { server, channel },
        _ => WsEvent::ChannelUpdated { server, channel },
    }))
}

/// Projects a layout change for one viewer. A category or reorder notification needs a
/// visible change in the matching edit, even when its payload is a newer layout.
pub(super) async fn layout_for(
    state: &AppState,
    access: &mut Access,
    ev: &WsEvent,
) -> Option<Option<WsEvent>> {
    let WsEvent::LayoutChanged {
        server,
        layout,
        created,
        deleted,
        before,
        after,
    } = ev
    else {
        return Some(None);
    };
    let edited = after.as_ref().unwrap_or(layout);
    let previous = access.layouts.insert(server.clone(), edited.clone());
    if let Some(cid) = created
        && !channel_gate(state, access, server, *cid).await?
    {
        return Some(None);
    }
    if deleted.is_some() && !deleted_gate(state, access, server, None, deleted.as_ref()).await? {
        return Some(None);
    }
    let started = Instant::now();
    let manages = match crate::api::access::ws_manages_channels(
        &state.read(),
        server,
        access.user.as_deref(),
    )
    .await
    {
        Ok(manages) => manages,
        Err(e) => return access.hold(e, started).then_some(None),
    };
    let mine = if manages || created.is_some() || deleted.is_some() {
        seen_layout(state, access, server, layout, manages).await?
    } else {
        // Both snapshots in a write transaction carry its incremented version.
        let before = before
            .as_ref()
            .filter(|b| b.version == edited.version)
            .or_else(|| {
                previous
                    .as_deref()
                    .filter(|p| p.version.checked_add(1) == Some(edited.version))
            });
        let Some(before) = before else {
            return Some(None);
        };
        let old = seen_layout(state, access, server, before, false).await?;
        let new = seen_layout(state, access, server, edited, false).await?;
        if old.version == new.version {
            return Some(None);
        }
        match after {
            Some(_) => seen_layout(state, access, server, layout, false).await?,
            None => new,
        }
    };
    if access.retry.pending() {
        return Some(None);
    }
    Some(Some(WsEvent::LayoutChanged {
        server: server.clone(),
        layout: mine.into(),
        created: None,
        deleted: None,
        before: None,
        after: None,
    }))
}

/// `layout` with only the channels this connection can view, and only the categories that hold
/// one of them unless it `manages` channels. `None` when the connection must close.
async fn seen_layout(
    state: &AppState,
    access: &mut Access,
    server: &str,
    layout: &ChannelLayout,
    manages: bool,
) -> Option<ChannelLayout> {
    let ChannelLayout {
        version,
        uncategorized: all,
        categories: all_categories,
    } = layout;
    let mut uncategorized = Vec::new();
    for cid in all {
        if channel_gate(state, access, server, *cid).await? {
            uncategorized.push(*cid);
        }
    }
    let mut categories = Vec::new();
    for LayoutCategory { id, name, channels } in all_categories {
        let mut shown = Vec::new();
        for cid in channels {
            if channel_gate(state, access, server, *cid).await? {
                shown.push(*cid);
            }
        }
        if !shown.is_empty() || manages {
            categories.push(LayoutCategory {
                id: *id,
                name: name.clone(),
                channels: shown,
            });
        }
    }
    let mut seen = ChannelLayout {
        version: *version,
        uncategorized,
        categories,
    };
    if !manages {
        seen.version = seen_version(&seen);
    }
    Some(seen)
}

pub(super) const PRESENCE_SNAPSHOT_MAX: usize = 50;

pub(super) fn presence_snapshot(hub: &Hub, access: &Access, server: &str) -> Option<WsEvent> {
    if access.retry.pending() || !access.held(server) || access.closes(server) {
        return None;
    }
    let mut online = hub.online_after(server, None, PRESENCE_SNAPSHOT_MAX);
    let mut online_count = hub.online_count(server);
    if let Some(user) = access.user.as_deref()
        && access.shows(server)
        && !hub.is_online(server, user)
    {
        online_count += 1;
        if let Err(at) = online.binary_search_by(|n| n.as_str().cmp(user)) {
            online.insert(at, user.to_string());
            online.truncate(PRESENCE_SNAPSHOT_MAX);
        }
    }
    Some(WsEvent::PresenceSnapshot {
        server: server.to_string(),
        online,
        online_count,
    })
}
