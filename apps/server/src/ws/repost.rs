use std::time::Duration;

use super::calls::finalize_call_log;
use super::event::{Updated, WsEvent};
use super::p2p::announce_drop;
use super::{PURGE_CHUNK, evict_unviewable};

use crate::api::access::{
    is_member, member_role, presence_mode, servers_with_expired_passwords, ws_banned,
    ws_channel_now, ws_server_lite, ws_voice_viewable,
};
use crate::api::messages::{Quotes, load_broadcast, load_message};
use crate::api::{Settings, UserRef};
use crate::db::get_user;
use crate::hub::{Aftermath, Hub, Op, Purge};
use crate::state::AppState;

/// Asks the connections on servers whose extra passwords expired in `(since, until]` to
/// recheck their access, so guests let in through those passwords are cut even when idle.
pub async fn announce_expired_passwords(
    state: &AppState,
    since: i64,
    until: i64,
) -> sqlx::Result<()> {
    let db = &state.read();
    for name in servers_with_expired_passwords(db, since, until).await? {
        if let Some(server) = ws_server_lite(db, &name).await? {
            state.hub.broadcast(WsEvent::ServerUpdated { server });
        }
    }
    Ok(())
}

pub async fn sweep_and_log(state: &AppState, idle: i64) {
    for end in state.hub.sweep_voice(idle).await {
        finalize_call_log(state, end, false).await;
    }
}

pub async fn settle(state: &AppState, purge: Purge) {
    let Purge { ends, p2p } = purge;
    for end in ends {
        finalize_call_log(state, end, false).await;
    }
    for (user, drop) in p2p {
        announce_drop(state, &user, drop, None).await;
    }
}

/// Starts the tasks that follow up on what the hub did. Returns them.
pub fn spawn_aftermath(state: &AppState) -> Vec<tokio::task::JoinHandle<()>> {
    let mut tasks = Vec::new();
    if let Some(mut shown) = state.hub.take_shown() {
        let state = state.clone();
        tasks.push(tokio::spawn(async move {
            while let Some((user, online)) = shown.recv().await {
                crate::api::friends::tell_friends(&state, &user, online).await;
            }
        }));
    }
    if let Some(mut rx) = state.hub.take_aftermath() {
        let state = state.clone();
        tasks.push(tokio::spawn(async move {
            while let Some(job) = rx.recv().await {
                match job {
                    Aftermath::Settle(purge) => settle(&state, purge).await,
                    Aftermath::Repost(ops) => {
                        for op in ops {
                            repost(&state, op).await;
                        }
                    }
                }
            }
        }));
    }
    tasks
}

pub(crate) async fn current(state: &AppState, ev: WsEvent) -> Option<WsEvent> {
    let db = &state.read();
    match ev {
        WsEvent::Message {
            server,
            channel_id,
            dm_id,
            dm_users,
            message,
        } => {
            let message = load_broadcast(db, message.id).await.ok().flatten()?;
            Some(WsEvent::Message {
                server,
                channel_id,
                dm_id,
                dm_users,
                message: Box::new(message),
            })
        }
        WsEvent::MessageUpdated {
            server,
            channel_id,
            update,
            dm_users,
        } => {
            let message = load_broadcast(db, update.id()).await.ok().flatten()?;
            let update = match update {
                Updated::Stub(_) => {
                    Updated::stub(message.id, message.thread_root_id, message.edited_at)
                }
                Updated::Full { message: _ } => Updated::full(message),
            };
            Some(WsEvent::MessageUpdated {
                server,
                channel_id,
                update,
                dm_users,
            })
        }
        WsEvent::EmbedsResolved {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
            embeds: _,
        } => {
            let message = load_broadcast(db, message_id).await.ok().flatten()?;
            Some(WsEvent::EmbedsResolved {
                server,
                channel_id,
                dm_id,
                dm_users,
                message_id,
                embeds: message.embeds,
            })
        }
        WsEvent::ReactionAdded {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
            thread_root_id,
            emoji,
            username,
            count: _,
        } => {
            let (stored, count) =
                crate::api::reactions::reaction_state(db, message_id, &username, &emoji)
                    .await
                    .ok()?;
            stored.then_some(WsEvent::ReactionAdded {
                server,
                channel_id,
                dm_id,
                dm_users,
                message_id,
                thread_root_id,
                emoji,
                username,
                count,
            })
        }
        WsEvent::ReactionRemoved {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
            thread_root_id,
            emoji,
            username,
            count: _,
        } => {
            let (stored, count) =
                crate::api::reactions::reaction_state(db, message_id, &username, &emoji)
                    .await
                    .ok()?;
            (!stored).then_some(WsEvent::ReactionRemoved {
                server,
                channel_id,
                dm_id,
                dm_users,
                message_id,
                thread_root_id,
                emoji,
                username,
                count,
            })
        }
        WsEvent::PollUpdated {
            server: _,
            channel_id: _,
            dm_id: _,
            dm_users: _,
            message_id,
            thread_root_id: _,
            created_at: _,
            poll: _,
        } => crate::api::polls::update_event(db, message_id)
            .await
            .ok()
            .flatten(),
        WsEvent::MessagePinned {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
            pinned_at: _,
            pinned_by,
        } => {
            let pinned_at = crate::api::pins::pinned_at(db, message_id).await.ok()??;
            Some(WsEvent::MessagePinned {
                server,
                channel_id,
                dm_id,
                dm_users,
                message_id,
                pinned_at,
                pinned_by,
            })
        }
        WsEvent::MessageUnpinned {
            server,
            channel_id,
            dm_id,
            dm_users,
            message_id,
        } => match crate::api::pins::pinned_at(db, message_id).await.ok()? {
            Some(_) => None,
            None => Some(WsEvent::MessageUnpinned {
                server,
                channel_id,
                dm_id,
                dm_users,
                message_id,
            }),
        },
        WsEvent::ChannelCreated { server, channel } => {
            let (owner, channel) = ws_channel_now(db, channel.id).await.ok().flatten()?;
            (owner == server).then_some(WsEvent::ChannelCreated { server, channel })
        }
        WsEvent::ChannelRenamed { server, channel } => {
            let (owner, channel) = ws_channel_now(db, channel.id).await.ok().flatten()?;
            (owner == server).then_some(WsEvent::ChannelRenamed { server, channel })
        }
        WsEvent::ChannelUpdated { server, channel } => {
            let (owner, channel) = ws_channel_now(db, channel.id).await.ok().flatten()?;
            (owner == server).then_some(WsEvent::ChannelUpdated { server, channel })
        }
        WsEvent::LayoutChanged {
            server,
            layout: _,
            created,
            deleted,
        } => {
            let layout = crate::api::categories::current_layout(db, &server)
                .await
                .ok()
                .flatten()?;
            Some(WsEvent::LayoutChanged {
                server,
                layout,
                created,
                deleted,
            })
        }
        WsEvent::ServerCreated { server } => {
            let server = ws_server_lite(db, &server.name).await.ok().flatten()?;
            Some(WsEvent::ServerCreated { server })
        }
        WsEvent::ServerRenamed { old_name, server } => {
            let reused =
                old_name != server.name && !matches!(ws_server_lite(db, &old_name).await, Ok(None));
            let server = ws_server_lite(db, &server.name).await.ok().flatten()?;
            (!reused).then_some(WsEvent::ServerRenamed { old_name, server })
        }
        WsEvent::ServerUpdated { server } => {
            let server = ws_server_lite(db, &server.name).await.ok().flatten()?;
            Some(WsEvent::ServerUpdated { server })
        }
        WsEvent::ServerDeleted { name } => match ws_server_lite(db, &name).await {
            Ok(Some(_)) => None,
            Ok(None) | Err(_) => Some(WsEvent::ServerDeleted { name }),
        },
        WsEvent::MemberJoined { server, member } => {
            match is_member(db, &server, &member.user.username).await {
                Ok(true) => Some(WsEvent::MemberJoined { server, member }),
                Ok(false) | Err(_) => None,
            }
        }
        WsEvent::MemberLeft { server, username } => match is_member(db, &server, &username).await {
            Ok(true) => {
                evict_unviewable(state, &server, None).await;
                None
            }
            Ok(false) | Err(_) => Some(WsEvent::MemberLeft { server, username }),
        },
        WsEvent::MemberKicked {
            server,
            username,
            banned,
        } => match is_member(db, &server, &username).await {
            Ok(true) => {
                evict_unviewable(state, &server, None).await;
                None
            }
            Ok(false) | Err(_) => Some(WsEvent::MemberKicked {
                server,
                username,
                banned,
            }),
        },
        WsEvent::MembersPurged { server, usernames } => {
            let mut gone = Vec::new();
            let mut stayed = false;
            for username in usernames {
                match is_member(db, &server, &username).await {
                    Ok(true) => stayed = true,
                    Ok(false) | Err(_) => gone.push(username),
                }
            }
            if stayed {
                evict_unviewable(state, &server, None).await;
            }
            (!gone.is_empty()).then_some(WsEvent::MembersPurged {
                server,
                usernames: gone,
            })
        }
        WsEvent::ServerBanned { server, username } => match ws_banned(db, &server, &username).await
        {
            Ok(true) => Some(WsEvent::ServerBanned { server, username }),
            Ok(false) | Err(_) => None,
        },
        WsEvent::PresenceMode {
            username,
            appear_offline: _,
            seq: _,
        } => {
            let (appear_offline, seq) = presence_mode(&state.db, &username).await.ok().flatten()?;
            Some(WsEvent::PresenceMode {
                username,
                appear_offline,
                seq,
            })
        }
        WsEvent::AdminChanged {
            server,
            username,
            is_admin: _,
            perms: _,
        } => {
            let (is_admin, perms) = member_role(db, &server, &username).await.ok().flatten()?;
            Some(WsEvent::AdminChanged {
                server,
                username,
                is_admin,
                perms,
            })
        }
        WsEvent::UserUpdated { user, scope } => {
            let user = get_user(db, &user.username).await.ok().flatten()?;
            Some(WsEvent::UserUpdated {
                user: UserRef::from_user(&user),
                scope,
            })
        }
        WsEvent::UserRegistered { user } => {
            let user = get_user(db, &user.username).await.ok().flatten()?;
            Some(WsEvent::UserRegistered {
                user: UserRef::from_user(&user),
            })
        }
        WsEvent::Banned { username } => match get_user(db, &username).await {
            Ok(Some(_)) => None,
            Ok(None) | Err(_) => Some(WsEvent::Banned { username }),
        },
        WsEvent::SettingsChanged { settings: _ } => Some(WsEvent::SettingsChanged {
            settings: Settings::load(db).await,
        }),
        WsEvent::RtcSignal {
            to,
            from,
            channel_id,
            dm_id,
            payload,
        } => state
            .hub
            .rtc_shared(&from, &to, channel_id, dm_id)
            .then_some(WsEvent::RtcSignal {
                to,
                from,
                channel_id,
                dm_id,
                payload,
            }),
        WsEvent::Typing {
            server: _,
            channel_id: _,
            dm_id: _,
            dm_users: _,
            scope: _,
            username: _,
            display_name: _,
            until: _,
        } => None,
        other => Some(other),
    }
}

async fn repost_event(state: &AppState, event: WsEvent) {
    loop {
        let Some(ev) = current(state, event.clone()).await else {
            return;
        };
        let WsEvent::Message {
            server,
            channel_id,
            dm_id,
            dm_users,
            message,
        } = &ev
        else {
            state.hub.broadcast(ev);
            return;
        };
        let id = message.id;
        let deleted = WsEvent::MessageDeleted {
            server: server.clone(),
            channel_id: *channel_id,
            dm_id: *dm_id,
            dm_users: dm_users.clone(),
            id,
            thread_root_id: message.thread_root_id,
        };
        if state.hub.broadcast_confirmed(ev).await {
            if matches!(
                load_message(&state.read(), id, Quotes::Skip).await,
                Ok(None)
            ) {
                state.hub.broadcast(deleted);
            }
            return;
        }
    }
}

pub(crate) async fn repost(state: &AppState, op: Op) {
    match op {
        Op::Broadcast { event } => repost_event(state, event).await,
        Op::ForceOffline { server, user } => {
            if !is_member(&state.db, &server, &user).await.unwrap_or(false) {
                state.hub.force_offline(&server, &user);
            }
        }
        Op::EvictVoice { user, channel_id } => {
            let allowed = match ws_channel_now(&state.read(), channel_id).await {
                Ok(Some((server, _))) => {
                    ws_voice_viewable(&state.read(), &server, channel_id, &user).await
                }
                Ok(None) | Err(_) => false,
            };
            if !allowed {
                state.hub.evict_voice(&user, channel_id);
            }
        }
        _ => {}
    }
}

pub fn announce_purge(hub: &Hub, server: &str, usernames: &[String]) {
    for chunk in usernames.chunks(PURGE_CHUNK) {
        hub.broadcast(WsEvent::MembersPurged {
            server: server.to_string(),
            usernames: chunk.to_vec(),
        });
    }
}

pub async fn depart(state: &AppState) {
    let wait = Duration::from_secs(3);
    if let Ok(Some(purge)) = tokio::time::timeout(wait, state.hub.depart()).await {
        let _ = tokio::time::timeout(wait, settle(state, purge)).await;
    }
    let _ = tokio::time::timeout(wait, state.hub.flush()).await;
}
