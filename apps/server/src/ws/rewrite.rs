use axum::extract::ws::Utf8Bytes;
use tokio::time::Instant;

use super::access::{Access, channel_gate, deleted_gate};
use super::event::WsEvent;

use crate::api::access::{ViewRules, ws_sees_timeouts};
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

/// `layout_changed` for one connection: only the channels it can view, and only the categories
/// that hold one of them, unless it manages channels. `Some(None)` when it comes from creating or
/// deleting a channel the connection can't view (its layout is the same); `None` when the
/// connection must close.
pub(super) async fn layout_for(
    state: &AppState,
    access: &mut Access,
    server: &str,
    layout: &ChannelLayout,
    created: Option<i64>,
    deleted: Option<&ViewRules>,
) -> Option<Option<WsEvent>> {
    if let Some(cid) = created
        && !channel_gate(state, access, server, cid).await?
    {
        return Some(None);
    }
    if deleted.is_some() && !deleted_gate(state, access, server, None, deleted).await? {
        return Some(None);
    }
    let mut uncategorized = Vec::new();
    for cid in &layout.uncategorized {
        if channel_gate(state, access, server, *cid).await? {
            uncategorized.push(*cid);
        }
    }
    let mut categories = Vec::new();
    let mut manages = None;
    for category in &layout.categories {
        let mut channels = Vec::new();
        for cid in &category.channels {
            if channel_gate(state, access, server, *cid).await? {
                channels.push(*cid);
            }
        }
        if channels.is_empty() && manages.is_none() {
            let started = Instant::now();
            manages = match crate::api::access::ws_manages_channels(
                &state.read(),
                server,
                access.user.as_deref(),
            )
            .await
            {
                Ok(m) => Some(m),
                Err(e) => match access.hold(e, started) {
                    true => Some(false),
                    false => return None,
                },
            };
        }
        if !channels.is_empty() || manages == Some(true) {
            categories.push(LayoutCategory {
                id: category.id,
                name: category.name.clone(),
                channels,
            });
        }
    }
    Some(Some(WsEvent::LayoutChanged {
        server: server.to_string(),
        layout: ChannelLayout {
            version: layout.version,
            uncategorized,
            categories,
        },
        created: None,
        deleted: None,
    }))
}

pub(super) const PRESENCE_SNAPSHOT_MAX: usize = 50;

pub(super) fn presence_snapshot(hub: &Hub, access: &Access, server: &str) -> Option<WsEvent> {
    if access.retry.pending() || !access.held(server) {
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
