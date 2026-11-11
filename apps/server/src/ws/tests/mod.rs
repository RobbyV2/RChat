use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

use sqlx::Row;
use tokio::sync::broadcast;

use super::*;
use crate::api::messages::{Quotes, load_message};
use crate::api::{Channel, ServerSummaryLite};
use crate::api::{Member, Message, UserRef};
use crate::db::AvatarKind;
use crate::db::ChannelKind;
use crate::fanout::Topic;
use crate::ws::access::Access;

mod access;
mod calls;
mod conn;
mod event;
mod filter;
mod p2p;
mod presence;
mod repost;
mod rewrite;
mod typing;

fn message() -> Message {
    Message {
        id: 4,
        channel_id: None,
        dm_id: Some(2),
        thread_root_id: None,
        author: UserRef {
            username: "alice".to_string(),
            display_name: "Alice".to_string(),
            avatar_kind: AvatarKind::Identicon,
            avatar_color: None,
        },
        content: "hi".to_string(),
        created_at: 1,
        reply_count: 0,
        media: None,
        embeds: Vec::new(),
        kind: "user".to_string(),
        call: None,
        reactions: Vec::new(),
        reply_to: None,
        edited_at: None,
        forward: None,
        pinned_at: None,
        pin_message_id: None,
        group_mentions: Vec::new(),
        poll: None,
        webhook: None,
    }
}

async fn exec(db: &Db, sql: &'static str) {
    sqlx::query(sql).execute(db).await.unwrap();
}

fn set(items: &[&str]) -> HashSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

async fn add_user(db: &Db, name: &str) {
    crate::db::NewUser::plain(name).at(1).add(db).await;
}

async fn post_message(db: &Db, channel_id: i64, content: &str) -> Message {
    let id: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'alice', $2, 1) RETURNING id")
        .bind(channel_id)
        .bind(content)
        .fetch_one(db)
        .await
        .unwrap()
        .try_get(0)
        .unwrap();
    load_message(db, id, Quotes::Since(None))
        .await
        .ok()
        .flatten()
        .unwrap()
}

async fn general(db: &Db) -> i64 {
    sqlx::query("SELECT id FROM channels WHERE server = 'rchat' AND kind = 'text'")
        .fetch_one(db)
        .await
        .unwrap()
        .try_get(0)
        .unwrap()
}

fn lite(name: &str) -> ServerSummaryLite {
    ServerSummaryLite {
        name: name.to_string(),
        display_name: name.to_string(),
        creator: None,
        has_password: false,
        banner_color: None,
        name_color: None,
    }
}

fn s(v: &str) -> String {
    v.to_string()
}

fn renamed(old: &str, new: &str) -> WsEvent {
    WsEvent::ServerRenamed {
        old_name: s(old),
        server: lite(new),
    }
}

fn joined(server: &str, username: &str) -> WsEvent {
    WsEvent::MemberJoined {
        server: s(server),
        member: Member {
            user: UserRef {
                username: s(username),
                ..message().author
            },
            is_admin: false,
            is_creator: false,
            online: false,
            perms: 0,
            role_ids: Vec::new(),
            joined_via: None,
            timeout: None,
        },
    }
}

async fn insert_id(db: &Db, sql: &'static str) -> i64 {
    sqlx::query(sql)
        .fetch_one(db)
        .await
        .unwrap()
        .try_get(0)
        .unwrap()
}

async fn add_user_row(db: &Db, name: &str) {
    crate::db::NewUser::plain(name).hash("x").add(db).await;
}

fn viewer(user: &str, hidden: bool) -> Access {
    let mut access = Access::new(Some(s(user)), false, set(&["rchat", "other"]));
    access.hidden = hidden;
    access
}

async fn lagged_presence_state(tag: &str) -> (AppState, std::path::PathBuf) {
    let (state, path) = crate::api::test_util::temp_state(tag).await;
    add_user(&state.db, "alice").await;
    exec(
        &state.db,
        "INSERT INTO servers(name, display_name, created_at) VALUES('chat', 'chat', 1)",
    )
    .await;
    exec(
        &state.db,
        "INSERT INTO members(server, username, joined_at) VALUES('chat', 'alice', 1)",
    )
    .await;
    (state, path)
}

async fn peek_world(name: &str) -> (AppState, std::path::PathBuf, i64, i64) {
    let (state, path) = crate::api::test_util::temp_state(name).await;
    let db = &state.db;
    add_user(db, "alice").await;
    add_user(db, "nora").await;
    exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('open', 'Open', 'alice', 1)").await;
    exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('vault', 'Vault', 'alice', 'hash', 1)").await;
    exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('home', 'Home', 'nora', 1)").await;
    exec(
        db,
        "INSERT INTO members(server, username, joined_at) VALUES('open', 'alice', 1)",
    )
    .await;
    exec(
        db,
        "INSERT INTO members(server, username, joined_at) VALUES('home', 'nora', 1)",
    )
    .await;
    let general = insert_id(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('open', 'general', 1) RETURNING id",
    )
    .await;
    let secret = insert_id(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('open', 'secret', 1) RETURNING id",
    )
    .await;
    sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'r:999', 1, 1, 1)")
        .bind(secret)
        .execute(db)
        .await
        .unwrap();
    crate::api::test_util::restrict_ruled(db).await;
    (state, path, general, secret)
}

fn post_in(server: &str, cid: i64) -> WsEvent {
    WsEvent::Message {
        server: Some(s(server)),
        channel_id: Some(cid),
        dm_id: None,
        dm_users: None,
        message: Box::new(message()),
    }
}

fn reaches(target: &crate::fanout::Target, topics: &HashSet<Topic>) -> bool {
    use crate::fanout::Target;
    match *target {
        Target::Admins => topics.contains(&Topic::Admin),
        Target::User(u) => topics.contains(&Topic::User(s(u))),
        Target::Server(v) => topics.contains(&Topic::Server(s(v))),
        Target::View(v) => topics.contains(&Topic::View(v.to_string())),
    }
}
