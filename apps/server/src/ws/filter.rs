use std::collections::HashSet;

use tokio::time::Instant;

use super::access::{Access, channel_gate, deleted_gate};
use super::conn::{forget_server, join, leave};
use super::event::WsEvent;
use super::is_member;

use crate::api::access::ws_sees_timeouts;
use crate::db::{MediaKind, now};
use crate::state::AppState;

/// Seconds after which a `message` event is checked against the read-history floor.
const REPLAY_AGE: i64 = 2;

pub(super) fn self_grant<'a>(ev: &'a WsEvent, me: Option<&str>) -> Option<&'a str> {
    match ev {
        WsEvent::MemberJoined { server, member } if Some(member.user.username.as_str()) == me => {
            Some(server.as_str())
        }
        WsEvent::ServerCreated { server } if me.is_some() && server.creator.as_deref() == me => {
            Some(server.name.as_str())
        }
        _ => None,
    }
}

pub(super) async fn on_event(
    state: &AppState,
    conn: u64,
    access: &mut Access,
    ev: &WsEvent,
) -> Option<bool> {
    if !access.past_deadlines(state, conn).await {
        return None;
    }
    if let (Some(server), Some(user)) = (self_grant(ev, access.user.as_deref()), &access.user) {
        let started = Instant::now();
        match is_member(&state.read(), server, user).await {
            Ok(true) => {}
            Ok(false) => return Some(false),
            Err(e) => return access.hold(e, started).then_some(false),
        }
    }
    let mut deliver = access.wants(ev);
    if deliver
        && let WsEvent::MemberTimeout {
            server,
            username,
            until: _,
            remaining: _,
            reason: _,
        } = ev
        && let Some(me) = access.user.as_deref()
        && me != username
    {
        let started = Instant::now();
        match ws_sees_timeouts(&state.read(), server, me, access.site_admin).await {
            Ok(sees) => deliver = sees,
            Err(e) => return access.hold(e, started).then_some(false),
        }
    }
    let known = match ev {
        WsEvent::ChannelDeleted {
            server,
            channel_id,
            rules: _,
        } => access
            .viewable
            .get(channel_id)
            .map(|(owner, view)| *view && owner == server),
        _ => None,
    };
    track(ev, access);
    if let WsEvent::MemberLeft { server, username }
    | WsEvent::MemberKicked {
        server,
        username,
        banned: false,
    } = ev
        && access.user.as_deref() == Some(username.as_str())
        && !access.recheck(state, conn, server).await
    {
        return None;
    }
    if let WsEvent::ServerRenamed {
        old_name: _,
        server,
    }
    | WsEvent::ServerUpdated { server }
    | WsEvent::ServerCreated { server } = ev
        && !access.recheck(state, conn, &server.name).await
    {
        return None;
    }
    if let WsEvent::ServerRenamed {
        old_name: _,
        server,
    }
    | WsEvent::ServerUpdated { server } = ev
    {
        deliver &= access.site_admin || access.held(&server.name);
    }
    if access.retry.pending() {
        deliver &= access.wants(ev);
    }
    if deliver && let Some((server, cid)) = event_channel(ev) {
        deliver = channel_gate(state, access, server, cid).await?;
    }
    if deliver
        && let WsEvent::PollUpdated {
            server: Some(server),
            channel_id: Some(cid),
            created_at,
            ..
        } = ev
    {
        deliver = access
            .floor(state, server, *cid)
            .await
            .is_some_and(|floor| floor.is_none_or(|floor| *created_at >= floor));
    }
    // A live message is newer than any floor; an older one is a replay after a bus outage
    // (`repost_event`), which must not reach members without read history of it.
    if deliver
        && let WsEvent::Message {
            server: Some(server),
            channel_id: Some(cid),
            message,
            ..
        } = ev
        && message.created_at < now() - REPLAY_AGE
    {
        deliver = access
            .floor(state, server, *cid)
            .await
            .is_some_and(|floor| floor.is_none_or(|floor| message.created_at >= floor));
    }
    if deliver
        && let WsEvent::MessagesDeleted {
            server: Some(server),
            channel_id: Some(cid),
            created,
            ..
        } = ev
    {
        deliver = match access.floor(state, server, *cid).await {
            Some(Some(floor)) => created.iter().any(|c| *c >= floor),
            Some(None) => true,
            None => false,
        };
    }
    if deliver
        && let WsEvent::ChannelDeleted {
            server,
            channel_id: _,
            rules,
        } = ev
    {
        deliver = deleted_gate(state, access, server, known, rules.as_ref()).await?;
    }
    if deliver {
        deliver = !hosting_via_who(access, ev);
    }
    Some(deliver)
}

// Hosted ids are read capabilities, and the broadcast of a hoster goes to all who share a server
// with them. So others learn about hosting only through p2p_who: filtered to the ids they can
// read. Answers carry no peer ids: a peer id reaches a reader only through a p2p release.
fn hosting_via_who(access: &mut Access, ev: &WsEvent) -> bool {
    let me = access.user.as_deref();
    match ev {
        WsEvent::P2pAvailability {
            hoster,
            peer_id: _,
            ids: _,
            online: true,
            scope_servers: _,
            scope_users: _,
        } if me != Some(hoster.as_str()) => {
            access.who.soon(hoster, Instant::now());
            true
        }
        WsEvent::Message {
            server: _,
            channel_id: _,
            dm_id: _,
            dm_users: _,
            message,
        } => {
            if let Some(media) = &message.media
                && media.kind == MediaKind::P2p
                && let Some(hoster) = &media.hoster
                && me != Some(hoster.as_str())
            {
                access.who.media.remove(&(hoster.clone(), media.id.clone()));
                access.who.soon(hoster, Instant::now());
            }
            false
        }
        _ => false,
    }
}

pub(super) fn track(ev: &WsEvent, access: &mut Access) {
    let me = access.user.as_deref();
    match ev {
        WsEvent::MemberJoined { server, member } => {
            if Some(member.user.username.as_str()) == me {
                join(access, server.clone());
            }
        }
        WsEvent::MemberLeft { server, username }
        | WsEvent::MemberKicked {
            server,
            username,
            banned: false,
        } => {
            if Some(username.as_str()) == me {
                leave(access, server);
            }
        }
        WsEvent::MemberKicked {
            server,
            username,
            banned: true,
        }
        | WsEvent::ServerBanned { server, username } => {
            if Some(username.as_str()) == me {
                leave(access, server);
                access.subs.remove(server);
                access.grants.remove(server);
                if access.looking.as_deref() == Some(server.as_str()) {
                    access.looking = None;
                }
            }
        }
        WsEvent::MembersPurged { server, usernames } => {
            if me.is_some_and(|me| usernames.iter().any(|u| u == me)) {
                leave(access, server);
            }
        }
        WsEvent::ServerCreated { server } => {
            if server.creator.as_deref() == me {
                join(access, server.name.clone());
            }
        }
        WsEvent::AdminChanged {
            server,
            username,
            is_admin: _,
            perms: _,
        } => {
            if Some(username.as_str()) == me {
                forget_server(access, server);
            }
        }
        WsEvent::RolesChanged { server } => forget_server(access, server),
        WsEvent::ChannelPermsChanged {
            server: _,
            channel_id,
        }
        | WsEvent::ChannelDeleted {
            server: _,
            channel_id,
            rules: _,
        } => {
            access.viewable.remove(channel_id);
            access.floors.clear();
            access.who.forget();
        }
        WsEvent::ServerRenamed { old_name, server } => {
            access.topics_dirty |= access.held(old_name);
            if access.member_servers.remove(old_name) {
                access.member_servers.insert(server.name.clone());
                access.moved.extend([old_name.clone(), server.name.clone()]);
                access.hosted_scope = None;
            }
            if access.subs.remove(old_name) {
                access.subs.insert(server.name.clone());
            }
            if let Some(at) = access.deadlines.remove(old_name) {
                access.deadlines.insert(server.name.clone(), at);
            }
            if let Some(grant) = access.grants.remove(old_name) {
                access.grants.insert(server.name.clone(), grant);
            }
            for slot in [&mut access.viewing, &mut access.peek, &mut access.looking] {
                if slot.as_deref() == Some(old_name.as_str()) {
                    *slot = Some(server.name.clone());
                }
            }
            forget_server(access, old_name);
        }
        WsEvent::ServerUpdated { server } => forget_server(access, &server.name),
        WsEvent::ServerDeleted { name } => {
            access.topics_dirty |= access.held(name);
            if access.member_servers.remove(name) {
                access.moved.push(name.clone());
                access.hosted_scope = None;
            }
            access.subs.remove(name);
            if access.viewing.as_deref() == Some(name.as_str()) {
                access.viewing = None;
            }
            if access.looking.as_deref() == Some(name.as_str()) {
                access.looking = None;
            }
            forget_server(access, name);
        }
        _ => {}
    }
    access.tidy_peek();
}

pub(super) fn event_channel(ev: &WsEvent) -> Option<(&str, i64)> {
    fn scoped<'a>(server: &'a Option<String>, channel_id: &Option<i64>) -> Option<(&'a str, i64)> {
        match (server, channel_id) {
            (Some(s), Some(c)) => Some((s.as_str(), *c)),
            (_, _) => None,
        }
    }
    match ev {
        WsEvent::Message {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message: _,
        } => scoped(server, channel_id),
        WsEvent::MessageUpdated {
            server,
            channel_id,
            update: _,
            dm_users: _,
        } => scoped(server, channel_id),
        WsEvent::MessageDeleted {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            id: _,
            thread_root_id: _,
        } => scoped(server, channel_id),
        WsEvent::MessagesDeleted {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            thread_root_id: _,
            ids: _,
            created: _,
        } => scoped(server, channel_id),
        WsEvent::MediaRemoved {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            removed_by_author: _,
        } => scoped(server, channel_id),
        WsEvent::EmbedsResolved {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            embeds: _,
        } => scoped(server, channel_id),
        WsEvent::EmbedsRemoved {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            ord: _,
            banner: _,
        } => scoped(server, channel_id),
        WsEvent::ReactionAdded {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            thread_root_id: _,
            emoji: _,
            username: _,
            count: _,
        }
        | WsEvent::ReactionRemoved {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            thread_root_id: _,
            emoji: _,
            username: _,
            count: _,
        }
        | WsEvent::PollUpdated {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            thread_root_id: _,
            created_at: _,
            poll: _,
        } => scoped(server, channel_id),
        WsEvent::MessagePinned {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
            pinned_at: _,
            pinned_by: _,
        }
        | WsEvent::MessageUnpinned {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            message_id: _,
        } => scoped(server, channel_id),
        WsEvent::ChannelCreated { server, channel }
        | WsEvent::ChannelRenamed { server, channel }
        | WsEvent::ChannelUpdated { server, channel } => Some((server.as_str(), channel.id)),
        WsEvent::VoiceState {
            server,
            channel_id,
            users: _,
        } => Some((server.as_str(), *channel_id)),
        WsEvent::VoiceMuted {
            server,
            channel_id,
            username: _,
            muted: _,
        } => Some((server.as_str(), *channel_id)),
        WsEvent::VoiceEnded {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            reason: _,
        } => scoped(server, channel_id),
        WsEvent::Typing {
            server,
            channel_id,
            dm_id: _,
            dm_users: _,
            scope: _,
            username: _,
            display_name: _,
            until: _,
        } => scoped(server, channel_id),
        _ => None,
    }
}

pub(super) fn wants(
    ev: &WsEvent,
    me: Option<&str>,
    is_site_admin: bool,
    member_servers: &HashSet<String>,
    subs: &HashSet<String>,
) -> bool {
    let in_server = |s: &String| member_servers.contains(s) || subs.contains(s);
    let scoped = |server: &Option<String>, dm_users: &Option<Vec<String>>| match server {
        Some(s) => in_server(s),
        None => match (me, dm_users) {
            (Some(user), Some(list)) => list.iter().any(|u| u == user),
            (_, _) => false,
        },
    };
    match ev {
        WsEvent::Message {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message: _,
        } => scoped(server, dm_users),
        WsEvent::MessageUpdated {
            server: Some(server),
            channel_id: _,
            update: _,
            dm_users: _,
        } => in_server(server),
        WsEvent::MessageUpdated {
            server: None,
            channel_id: _,
            update: _,
            dm_users,
        } => me.is_some_and(|user| dm_users.iter().any(|u| u == user)),
        WsEvent::MessageDeleted {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            id: _,
            thread_root_id: _,
        } => scoped(server, dm_users),
        WsEvent::MessagesDeleted {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            thread_root_id: _,
            ids: _,
            created: _,
        } => scoped(server, dm_users),
        WsEvent::MediaRemoved {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            removed_by_author: _,
        } => scoped(server, dm_users),
        WsEvent::EmbedsResolved {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            embeds: _,
        } => scoped(server, dm_users),
        WsEvent::EmbedsRemoved {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            ord: _,
            banner: _,
        } => scoped(server, dm_users),
        WsEvent::ReactionAdded {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            thread_root_id: _,
            emoji: _,
            username: _,
            count: _,
        }
        | WsEvent::ReactionRemoved {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            thread_root_id: _,
            emoji: _,
            username: _,
            count: _,
        }
        | WsEvent::PollUpdated {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            thread_root_id: _,
            created_at: _,
            poll: _,
        } => scoped(server, dm_users),
        WsEvent::MessagePinned {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
            pinned_at: _,
            pinned_by: _,
        }
        | WsEvent::MessageUnpinned {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            message_id: _,
        } => scoped(server, dm_users),
        WsEvent::ChannelCreated { server, channel: _ }
        | WsEvent::ChannelRenamed { server, channel: _ }
        | WsEvent::ChannelUpdated { server, channel: _ } => in_server(server),
        WsEvent::ChannelDeleted {
            server,
            channel_id: _,
            rules: _,
        } => in_server(server),
        WsEvent::MemberJoined { server, member } => {
            in_server(server) || Some(member.user.username.as_str()) == me
        }
        WsEvent::MemberLeft { server, username }
        | WsEvent::MemberKicked {
            server,
            username,
            banned: _,
        } => in_server(server) || Some(username.as_str()) == me,
        WsEvent::MembersPurged { server, usernames } => {
            in_server(server) || me.is_some_and(|user| usernames.iter().any(|u| u == user))
        }
        WsEvent::AdminChanged {
            server,
            username: _,
            is_admin: _,
            perms: _,
        } => in_server(server),
        WsEvent::RolesChanged { server } => in_server(server),
        WsEvent::ChannelPermsChanged {
            server,
            channel_id: _,
        } => in_server(server),
        WsEvent::LayoutChanged {
            server,
            layout: _,
            created: _,
            deleted: _,
        } => in_server(server),
        WsEvent::UserUpdated { user, scope } => {
            scope.is_empty()
                || Some(user.username.as_str()) == me
                || scope
                    .servers
                    .iter()
                    .chain(scope.views.iter())
                    .any(in_server)
                || me.is_some_and(|me| scope.users.iter().any(|u| u == me))
        }
        WsEvent::UserRegistered { user: _ } => is_site_admin,
        WsEvent::PresenceChanged {
            server,
            username: _,
            online: _,
            online_count: _,
        } => in_server(server),
        WsEvent::PresenceSnapshot {
            server: _,
            online: _,
            online_count: _,
        } => false,
        WsEvent::ServerBanned {
            server: _,
            username,
        }
        | WsEvent::PresenceMode {
            username,
            appear_offline: _,
            seq: _,
        }
        | WsEvent::ReadUpdated {
            username,
            scope: _,
            last_read: _,
            pings_until: _,
        }
        | WsEvent::Ping { username, ping: _ }
        | WsEvent::PingCount {
            username,
            scope: _,
            pings: _,
            pings_until: _,
            thread_pings: _,
        }
        | WsEvent::DmClosed { username, dm_id: _ }
        | WsEvent::DmReopened { username, dm_id: _ }
        | WsEvent::GroupPingsSeen {
            username,
            scope: _,
            message_ids: _,
        }
        | WsEvent::UserBlocked {
            username,
            blocked: _,
        }
        | WsEvent::UserUnblocked {
            username,
            blocked: _,
        }
        | WsEvent::PollVoted {
            username,
            message_id: _,
        }
        | WsEvent::BulkDeleteProgress { username, job: _ }
        | WsEvent::FriendRequestAdded {
            username,
            request: _,
        }
        | WsEvent::FriendRequestRemoved { username, other: _ }
        | WsEvent::FriendAdded {
            username,
            friend: _,
        }
        | WsEvent::FriendRemoved {
            username,
            friend: _,
        }
        | WsEvent::FriendPresence {
            username,
            friend: _,
            online: _,
        }
        | WsEvent::PrivacyChanged {
            username,
            privacy: _,
        } => Some(username.as_str()) == me,
        WsEvent::ServerCreated { server } => {
            is_site_admin || (me.is_some() && server.creator.as_deref() == me)
        }
        WsEvent::ServerRenamed {
            old_name,
            server: _,
        } => is_site_admin || in_server(old_name),
        WsEvent::ServerUpdated { server } => is_site_admin || in_server(&server.name),
        WsEvent::ServerDeleted { name } => is_site_admin || in_server(name),
        WsEvent::Banned { username: _ } | WsEvent::SettingsChanged { settings: _ } => true,
        WsEvent::DmCreated { dm_id: _, dm_users } => {
            me.is_some_and(|user| dm_users.iter().any(|u| u == user))
        }
        WsEvent::VoiceState {
            server,
            channel_id: _,
            users: _,
        } => in_server(server),
        WsEvent::VoiceMuted {
            server,
            channel_id: _,
            username: _,
            muted: _,
        } => in_server(server),
        WsEvent::MemberTimeout {
            server,
            username,
            until: _,
            remaining: _,
            reason: _,
        } => Some(username.as_str()) == me || (me.is_some() && in_server(server)),
        WsEvent::CallState {
            dm_id: _,
            dm_users,
            state: _,
            from: _,
            kind: _,
            video: _,
            call_id: _,
            answered_at: _,
            peers: _,
            relays: _,
        } => me.is_some_and(|user| dm_users.iter().any(|u| u == user)),
        WsEvent::P2pAvailability {
            hoster,
            peer_id: _,
            ids: _,
            online: _,
            scope_servers,
            scope_users,
        } => {
            Some(hoster.as_str()) == me
                || scope_servers.iter().any(in_server)
                || me.is_some_and(|user| scope_users.iter().any(|u| u == user))
        }
        WsEvent::RtcSignal {
            to,
            from: _,
            channel_id: _,
            dm_id: _,
            payload: _,
        } => Some(to.as_str()) == me,
        WsEvent::VoiceEnded {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            reason: _,
        } => scoped(server, dm_users),
        WsEvent::Typing {
            server,
            channel_id: _,
            dm_id: _,
            dm_users,
            scope: _,
            username,
            display_name: _,
            until: _,
        } => me != Some(username.as_str()) && scoped(server, dm_users),
        WsEvent::Error { message: _ }
        | WsEvent::TokensRevoked { username: _ }
        | WsEvent::P2pHosted {
            live: _,
            checked: _,
            key: _,
            peer_id: _,
            now: _,
        }
        | WsEvent::P2pPeer {
            message_id: _,
            peer_id: _,
            token: _,
            expires_at: _,
            error: _,
            relays: _,
        }
        | WsEvent::UserShown {
            username: _,
            online: _,
        }
        | WsEvent::Resync => false,
    }
}
