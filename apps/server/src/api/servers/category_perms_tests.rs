use super::category_perms::{
    clear_category_perm, list_category_perms, set_category_perm, sync_channel_perms,
};
use super::*;
use crate::api::categories::{load_layout, write_layout};
use crate::api::test_util::{add_member, done, mem_user, temp_state};
use serde_json::json;

type Answer<T> = Result<T, (StatusCode, String)>;

fn done_or<T>(r: Result<T, ApiError>) -> Answer<()> {
    r.map(|_| ()).map_err(|ApiError(code, msg, _)| (code, msg))
}

const VIEW: i64 = masks::VIEW as i64;
const SEND: i64 = masks::SEND as i64;
const DELETE: i64 = Perm::DeleteMessages as i64;
const PIN: i64 = Perm::PinMessages as i64;
const CHANNELS: i64 = Perm::ManageChannels as i64;

async fn one(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
        .try_get(0)
        .expect("number")
}

/// A server `club` of alice, with `names` as members.
async fn club(state: &AppState, names: &[&str]) {
    let _ = create_server(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Json(CreateServerReq {
            name: "club".to_string(),
            password: None,
            options: ServerOptions::default(),
        }),
    )
    .await
    .expect("club");
    for name in names {
        crate::db::NewUser::plain(name).add(&state.db).await;
        add_member(&state.db, "club", name, 0, 0, 1).await;
    }
}

/// A role of `club` with `perms`, held by `holders`, ranked at `position`.
async fn role(db: &Db, name: &str, position: i64, perms: i64, holders: &[&str]) -> i64 {
    let id = sqlx::query("INSERT INTO roles(server, name, color, perms, position) VALUES('club', $1, '#336699', $2, $3) RETURNING id")
        .bind(name)
        .bind(perms)
        .bind(position)
        .fetch_one(db)
        .await
        .expect("role")
        .try_get(0)
        .expect("id");
    for holder in holders {
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('club', $1, $2)")
            .bind(holder)
            .bind(id)
            .execute(db)
            .await
            .expect("hold");
    }
    id
}

async fn category(db: &Db, name: &str) -> i64 {
    sqlx::query("INSERT INTO channel_categories(server, name, position, created_at) VALUES('club', $1, 0, 0) RETURNING id")
        .bind(name)
        .fetch_one(db)
        .await
        .expect("category")
        .try_get(0)
        .expect("id")
}

async fn channel(state: &AppState, name: &str, category_id: Option<i64>, private: bool) -> i64 {
    create_channel(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path("club".to_string()),
        Json(CreateChannelReq {
            name: name.to_string(),
            kind: None,
            restrict_view: private,
            text_only: false,
            category_id,
        }),
    )
    .await
    .expect("channel")
    .0
    .id
}

async fn set(
    state: &AppState,
    actor: &str,
    cat: i64,
    subject: &str,
    allow: i64,
    deny: i64,
) -> Answer<()> {
    done_or(
        set_category_perm(
            State(state.clone()),
            Authed(mem_user(actor, false)),
            Path(cat),
            Json(
                serde_json::from_value(json!({"subject": subject, "allow": allow, "deny": deny}))
                    .expect("rule"),
            ),
        )
        .await,
    )
}

async fn set_rule(state: &AppState, channel: i64, subject: &str, allow: i64, deny: i64) {
    let _ = set_channel_perm(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path(channel),
        Json(
            serde_json::from_value(json!({"subject": subject, "allow": allow, "deny": deny}))
                .expect("rule"),
        ),
    )
    .await
    .expect("channel rule");
}

async fn sync(state: &AppState, channel: i64, confirm: bool) -> Answer<()> {
    done_or(
        sync_channel_perms(
            State(state.clone()),
            Authed(mem_user("alice", false)),
            Path(channel),
            Json(serde_json::from_value(json!({ "confirm": confirm })).expect("sync")),
        )
        .await,
    )
}

/// A channel's rules: subject, allow, deny.
async fn rules(db: &Db, channel: i64) -> Vec<(String, i64, i64)> {
    sqlx::query(
        "SELECT subject, allow, deny FROM channel_perms WHERE channel_id = $1 ORDER BY subject",
    )
    .bind(channel)
    .fetch_all(db)
    .await
    .expect("rules")
    .iter()
    .map(|r| {
        (
            r.try_get(0).expect("subject"),
            r.try_get(1).expect("allow"),
            r.try_get(2).expect("deny"),
        )
    })
    .collect()
}

async fn category_rules(db: &Db, cat: i64) -> Vec<(String, i64, i64)> {
    sqlx::query(
        "SELECT subject, allow, deny FROM category_perms WHERE category_id = $1 ORDER BY subject",
    )
    .bind(cat)
    .fetch_all(db)
    .await
    .expect("rules")
    .iter()
    .map(|r| {
        (
            r.try_get(0).expect("subject"),
            r.try_get(1).expect("allow"),
            r.try_get(2).expect("deny"),
        )
    })
    .collect()
}

async fn synced(db: &Db, channel: i64) -> bool {
    one(
        db,
        &format!("SELECT perm_sync FROM channels WHERE id = {channel}"),
    )
    .await
        != 0
}

fn events(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(match ev {
            WsEvent::ChannelPermsChanged { server, channel_id } => {
                format!("channel {server} {channel_id}")
            }
            WsEvent::ChannelsPermsChanged {
                server,
                channel_ids,
            } => format!("channels {server} {channel_ids:?}"),
            _ => continue,
        });
    }
    out
}

fn rule(subject: &str, allow: i64, deny: i64) -> (String, i64, i64) {
    (subject.to_string(), allow, deny)
}

#[tokio::test]
async fn channels_made_in_a_category_copy_its_rules_and_follow_them() {
    let (state, path) = temp_state("category_rules_follow").await;
    let db = &state.db;
    club(&state, &["bob", "carol"]).await;
    let mods = role(db, "mods", 1, 0, &["carol"]).await;
    let m = format!("r:{mods}");
    let cat = category(db, "Team").await;
    set(&state, "alice", cat, "everyone", 0, VIEW)
        .await
        .expect("everyone");
    set(&state, "alice", cat, &m, VIEW, 0).await.expect("mods");
    let team = vec![rule("everyone", 0, VIEW), rule(&m, VIEW, 0)];
    let plans = channel(&state, "plans", Some(cat), false).await;
    let open = channel(&state, "open", None, false).await;
    let secret = channel(&state, "secret", Some(cat), true).await;
    assert_eq!(
        rules(db, plans).await,
        team,
        "a new channel copies its category's rules"
    );
    assert!(synced(db, plans).await);
    assert!(rules(db, open).await.is_empty() && !synced(db, open).await);
    assert!(
        rules(db, secret).await.is_empty() && !synced(db, secret).await,
        "a private channel keeps its own rules"
    );
    let mut rx = state.hub.subscribe();
    set(&state, "alice", cat, "u:bob", VIEW | SEND, 0)
        .await
        .expect("bob");
    assert_eq!(
        rules(db, plans).await,
        vec![
            rule("everyone", 0, VIEW),
            rule(&m, VIEW, 0),
            rule("u:bob", VIEW | SEND, 0)
        ]
    );
    assert!(rules(db, secret).await.is_empty(), "only copies change");
    assert_eq!(events(&mut rx), [format!("channels club [{plans}]")]);
    let entry: serde_json::Value = serde_json::from_str(
        &sqlx::query(
            "SELECT details FROM audit_log WHERE action = 'channel.category_perms' ORDER BY id DESC",
        )
        .fetch_one(db)
        .await
        .expect("audit")
        .try_get::<String, _>(0)
        .expect("details"),
    )
    .expect("json");
    assert_eq!(entry["copies"], json!(1));
    assert_eq!(entry["removed"], json!(false));
    set_rule(&state, plans, "u:carol", VIEW, 0).await;
    assert!(!synced(db, plans).await, "a rule of its own ends the copy");
    set(&state, "alice", cat, "u:bob", 0, 0)
        .await
        .expect("bob gone");
    assert!(
        rules(db, plans)
            .await
            .contains(&rule("u:bob", VIEW | SEND, 0)),
        "a channel that no longer copies keeps its rules"
    );
    assert_eq!(events(&mut rx), [format!("channel club {plans}")]);
    assert_eq!(
        done_or(
            clear_category_perm(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Path((cat, "u:bob".to_string())),
            )
            .await
        ),
        Err((StatusCode::NOT_FOUND, "No such rule".to_string()))
    );
    sync(&state, plans, false)
        .await
        .expect("narrowing needs no confirm");
    assert_eq!(rules(db, plans).await, team);
    assert!(synced(db, plans).await);
    assert_eq!(events(&mut rx), [format!("channel club {plans}")]);
    assert_eq!(
        one(
            db,
            "SELECT COUNT(*) FROM audit_log WHERE action = 'channel.perm_sync'"
        )
        .await,
        1
    );
    assert_eq!(
        sync(&state, open, false).await,
        Err((
            StatusCode::BAD_REQUEST,
            "This channel is not in a category".to_string()
        ))
    );
    set_rule(&state, plans, &m, 0, VIEW).await;
    assert_eq!(
        sync(&state, plans, false).await,
        Err((
            StatusCode::CONFLICT,
            format!("Syncing lets {m} see or send here. Send confirm to sync.")
        )),
        "a sync that lets a role in asks first"
    );
    assert!(!synced(db, plans).await);
    sync(&state, plans, true).await.expect("confirmed");
    assert_eq!(rules(db, plans).await, team);
    let mut tx = db.begin().await.expect("tx");
    let mut layout = load_layout(&mut tx, "club")
        .await
        .expect("layout")
        .expect("some");
    for c in &mut layout.categories {
        c.channels.retain(|id| *id != plans);
    }
    layout.uncategorized.push(plans);
    write_layout(&mut tx, "club", &layout).await.expect("move");
    tx.commit().await.expect("commit");
    assert!(!synced(db, plans).await, "a move ends the copy");
    assert_eq!(rules(db, plans).await, team, "and changes no rule");
    done(state, path).await;
}

#[tokio::test]
async fn category_rules_are_checked_against_the_editor_and_every_copy() {
    let (state, path) = temp_state("category_rules_checks").await;
    let db = &state.db;
    club(&state, &["bob", "carol"]).await;
    role(db, "mgr", 3, CHANNELS | PIN, &["bob"]).await;
    let low = role(db, "low", 1, 0, &["carol"]).await;
    let l = format!("r:{low}");
    let cat = category(db, "Team").await;
    let plans = channel(&state, "plans", Some(cat), false).await;
    let lack = Err((
        StatusCode::FORBIDDEN,
        "You can't allow permissions you don't have in this channel".to_string(),
    ));
    assert_eq!(set(&state, "bob", cat, &l, DELETE, 0).await, lack);
    assert_eq!(
        set(&state, "bob", cat, "everyone", 0, DELETE).await,
        Err((
            StatusCode::FORBIDDEN,
            "You can't deny moderation permissions you don't have in this channel".to_string()
        ))
    );
    set(&state, "alice", cat, "u:bob", 0, PIN)
        .await
        .expect("alice");
    assert_eq!(rules(db, plans).await, vec![rule("u:bob", 0, PIN)]);
    assert_eq!(
        set(&state, "bob", cat, &l, PIN, 0).await,
        lack,
        "bob holds Pin messages in a channel without rules, but not in the channel that copies the category"
    );
    assert_eq!(
        category_rules(db, cat).await,
        vec![rule("u:bob", 0, PIN)],
        "nothing is written"
    );
    set(&state, "bob", cat, &l, VIEW | SEND, 0)
        .await
        .expect("base bits pass");
    set(&state, "alice", cat, &l, VIEW | DELETE, 0)
        .await
        .expect("alice");
    let made = create_channel(
        State(state.clone()),
        Authed(mem_user("bob", false)),
        Path("club".to_string()),
        Json(CreateChannelReq {
            name: "more".to_string(),
            kind: None,
            restrict_view: false,
            text_only: false,
            category_id: Some(cat),
        }),
    )
    .await
    .map(|_| ())
    .map_err(|ApiError(code, msg, _)| (code, msg));
    assert_eq!(
        made,
        Err((
            StatusCode::FORBIDDEN,
            "You can't make a channel with this category's permissions".to_string()
        )),
        "a new channel would give the role Manage messages bob doesn't hold"
    );
    set(&state, "alice", cat, &l, VIEW | SEND, 0)
        .await
        .expect("alice again");
    assert_eq!(
        rules(db, plans).await,
        vec![rule(&l, VIEW | SEND, 0), rule("u:bob", 0, PIN)]
    );
    let listed = list_category_perms(
        State(state.clone()),
        Authed(mem_user("bob", false)),
        Path(cat),
        Query(serde_json::from_value(json!({})).expect("query")),
    )
    .await
    .expect("list");
    let Paged(rows, next) = listed;
    assert_eq!(
        rows.iter()
            .map(|r| (r.subject.as_str(), r.allow, r.deny))
            .collect::<Vec<_>>(),
        vec![(l.as_str(), VIEW | SEND, 0), ("u:bob", 0, PIN)]
    );
    assert!(next.is_none());
    assert_eq!(
        list_category_perms(
            State(state.clone()),
            Authed(mem_user("carol", false)),
            Path(cat),
            Query(serde_json::from_value(json!({})).expect("query")),
        )
        .await
        .map(|_| ())
        .map_err(|ApiError(code, _, _)| code),
        Err(StatusCode::NOT_FOUND),
        "only those who manage channels see a category's rules"
    );
    let _ = delete_role(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path(("club".to_string(), low)),
    )
    .await
    .expect("delete role");
    assert_eq!(
        category_rules(db, cat).await,
        vec![rule("u:bob", 0, PIN)],
        "a deleted role's category rules go with it"
    );
    done(state, path).await;
}
