use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use rchat_perms::{Mask, masks};
use serde_json::{Value, json};
use sqlx::Row;

use super::perms::{Perm, held};
use super::{Proof, resolve_channel, resolve_message};
use crate::api::messages::{
    delete_message, edit_message, send_channel_message, send_thread_message,
};
use crate::api::pings::group_mentions;
use crate::api::pins::{pin_message, unpin_message};
use crate::api::reactions::{add_reaction, remove_reaction};
use crate::api::test_util::{add_member, each_db, mem_user};
use crate::api::{ApiError, Authed, Message};
use crate::db::{Db, NewUser};
use crate::state::AppState;

async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn id_of(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
        .try_get(0)
        .expect("id")
}

fn me(name: &str) -> Authed {
    Authed(mem_user(name, false))
}

fn refusal<T>(res: Result<T, ApiError>) -> (StatusCode, String) {
    match res {
        Ok(_) => (StatusCode::OK, String::new()),
        Err(ApiError(code, text, _)) => (code, text),
    }
}

fn says(got: (StatusCode, String), code: StatusCode, text: &str, what: &str) {
    assert_eq!((got.0, got.1.as_str()), (code, text), "{what}");
}

fn thumbs_up() -> String {
    char::from_u32(0x1f44d).expect("an emoji").to_string()
}

const OK: StatusCode = StatusCode::OK;
const NO: StatusCode = StatusCode::FORBIDDEN;

/// A server with its owner `own`, `mgr` (Manage channels), `modr` (Manage messages), `pinr` (Pin
/// messages), `fast` (Bypass slow mode), `loud` (Mention everyone) and a member `low`, each
/// through a role named `r` and their name.
struct Club {
    state: AppState,
    channel: i64,
}

impl Club {
    async fn new(state: AppState) -> Club {
        let db = &state.db;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'own', 0)").await;
        let channel = id_of(db, "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 0) RETURNING id").await;
        NewUser::plain("own").at(1).add(db).await;
        add_member(db, "club", "own", 1, 0, 0).await;
        for (name, perms) in [
            ("mgr", Perm::ManageChannels as i64),
            ("modr", Perm::DeleteMessages as i64),
            ("pinr", Perm::PinMessages as i64),
            ("fast", Perm::BypassSlowmode as i64),
            ("loud", Perm::MentionEveryone as i64),
            ("low", 0),
        ] {
            let role = id_of(db, &format!("INSERT INTO roles(server, name, color, perms) VALUES('club', 'r{name}', '#ffffff', {perms}) RETURNING id")).await;
            NewUser::plain(name).at(1).add(db).await;
            add_member(db, "club", name, 0, 0, 0).await;
            exec(db, &format!("INSERT INTO user_roles(server, username, role_id) VALUES('club', '{name}', {role})")).await;
        }
        Club { state, channel }
    }

    /// Stores the rule of `subject` (`everyone`, a member as `u:name`, or the role of a member
    /// as `r:name`) in the channel; both masks 0 removes it.
    async fn rule(&self, subject: &str, allow: Mask, deny: Mask) {
        let db = &self.state.db;
        let subject = match subject.strip_prefix("r:") {
            Some(name) => format!(
                "r:{}",
                id_of(
                    db,
                    &format!("SELECT id FROM roles WHERE server = 'club' AND name = 'r{name}'")
                )
                .await
            ),
            None => subject.to_string(),
        };
        exec(
            db,
            &format!(
                "DELETE FROM channel_perms WHERE channel_id = {} AND subject = '{subject}'",
                self.channel
            ),
        )
        .await;
        if allow | deny != 0 {
            exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, allow, deny) VALUES({}, '{subject}', {allow}, {deny})", self.channel)).await;
        }
    }

    async fn send(&self, by: &str, body: Value) -> Result<Message, ApiError> {
        send_channel_message(
            State(self.state.clone()),
            Path(self.channel),
            me(by),
            Json(serde_json::from_value(body).expect("body")),
        )
        .await
        .map(|Json(m)| m)
    }

    async fn reply(&self, by: &str, root: i64) -> (StatusCode, String) {
        refusal(
            send_thread_message(
                State(self.state.clone()),
                Path(root),
                me(by),
                Json(serde_json::from_value(json!({ "content": "reply" })).expect("body")),
            )
            .await,
        )
    }

    async fn react(&self, by: &str, id: i64) -> (StatusCode, String) {
        let path = Path((id, thumbs_up()));
        refusal(add_reaction(State(self.state.clone()), path, me(by)).await)
    }

    async fn pin(&self, by: &str, id: i64) -> (StatusCode, String) {
        refusal(pin_message(State(self.state.clone()), Path(id), me(by)).await)
    }

    async fn delete(&self, by: &str, id: i64) -> (StatusCode, String) {
        refusal(delete_message(State(self.state.clone()), Path(id), me(by)).await)
    }

    async fn post(&self, by: &str) -> i64 {
        id_of(&self.state.db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({}, '{by}', 'hello', 5) RETURNING id", self.channel)).await
    }
}

const POLL: fn() -> Value = || json!({ "content": "", "poll": { "question": "Where?", "kind": "single", "options": [{ "text": "Here" }, { "text": "There" }] } });
const FILE: fn() -> Value = || json!({ "content": "", "media_id": "0".repeat(32) });

#[tokio::test]
async fn a_message_needs_the_permission_of_each_thing_it_carries() {
    for (state, temp) in each_db("bit_gates_send").await {
        let c = Club::new(state.clone()).await;
        let carried = held::ATTACH | held::EMBED | held::POLLS | held::THREADS | held::REACT;
        c.rule("everyone", 0, carried).await;
        let link = c
            .send("low", json!({ "content": "see https://example.com" }))
            .await
            .expect("text needs only Send messages");
        assert!(link.no_previews, "no Embed links, no previews");
        says(
            refusal(c.send("low", FILE()).await),
            NO,
            "No permission to attach files in this channel",
            "a file",
        );
        says(
            refusal(c.send("low", POLL()).await),
            NO,
            "No permission to create polls in this channel",
            "a poll",
        );
        exec(&state.db, "INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES('f1', 'notes.txt', 'text/plain', 1, 'x', 'own', 1)").await;
        let filed = id_of(&state.db, &format!("INSERT INTO messages(channel_id, author, content, media_id, media_filename, created_at) VALUES({}, 'own', 'with a file', 'f1', 'notes.txt', 5) RETURNING id", c.channel)).await;
        let copy = c
            .send("low", json!({ "content": "", "forward_of": filed }))
            .await
            .expect("a forward goes through without its file");
        let dropped = copy.forward.as_ref().and_then(|f| f.dropped.clone());
        assert_eq!(
            (copy.media.is_none(), dropped.as_deref()),
            (true, Some("notes.txt"))
        );
        says(
            c.reply("low", link.id).await,
            NO,
            "No permission to start threads in this channel",
            "the first reply",
        );
        says(
            c.react("low", link.id).await,
            NO,
            "No permission to react in this channel",
            "a reaction",
        );
        exec(&state.db, &format!("INSERT INTO reactions(message_id, username, emoji, created_at) VALUES({}, 'low', '{}', 6)", link.id, thumbs_up())).await;
        let path = Path((link.id, thumbs_up()));
        let _ = remove_reaction(State(state.clone()), path, me("low"))
            .await
            .expect("your own reaction comes off without Add reactions");
        says(c.reply("own", link.id).await, OK, "", "the owner starts it");
        says(c.reply("low", link.id).await, OK, "", "a started thread");
        let Json(edited) = edit_message(
            State(state.clone()),
            Path(link.id),
            me("low"),
            Json(
                serde_json::from_value(json!({ "content": "now https://example.org" }))
                    .expect("body"),
            ),
        )
        .await
        .expect("edit");
        assert!(edited.no_previews, "an edit gets no previews either");

        c.rule("r:low", carried, 0).await;
        let link = c
            .send("low", json!({ "content": "see https://example.com" }))
            .await
            .expect("send");
        assert!(!link.no_previews, "a role's allow wins over the deny");
        assert_eq!(
            refusal(c.send("low", FILE()).await).0,
            StatusCode::BAD_REQUEST,
            "the file is asked for once attaching is allowed"
        );
        c.send("low", POLL()).await.expect("a poll");
        let copy = c
            .send("low", json!({ "content": "", "forward_of": filed }))
            .await
            .expect("a forward");
        assert!(
            copy.media.is_some(),
            "the file comes along with Attach files"
        );
        says(c.reply("low", link.id).await, OK, "", "the first reply");
        says(c.react("low", link.id).await, OK, "", "a reaction");

        c.rule("r:low", 0, 0).await;
        c.rule("everyone", 0, masks::SEND).await;
        says(
            refusal(c.send("low", json!({ "content": "hi" })).await),
            NO,
            "No permission to send in this channel",
            "Send messages alone decides text",
        );
        says(
            c.react("low", link.id).await,
            OK,
            "",
            "reacting needs no Send messages",
        );
        drop(temp);
    }
}

#[tokio::test]
async fn pins_and_deletes_follow_the_channel() {
    for (state, temp) in each_db("bit_gates_moderation").await {
        let c = Club::new(state.clone()).await;
        let (theirs, pinned) = (c.post("low").await, c.post("low").await);
        let no_pin = "No permission to pin messages in this channel";
        says(c.pin("modr", pinned).await, NO, no_pin, "Manage messages");
        says(c.pin("low", pinned).await, NO, no_pin, "a member");
        says(c.pin("pinr", pinned).await, OK, "", "Pin messages");
        says(
            c.delete("pinr", theirs).await,
            NO,
            "Not allowed",
            "a pinner",
        );
        refusal(unpin_message(State(state.clone()), Path(pinned), me("pinr")).await);

        c.rule("r:pinr", 0, held::PIN).await;
        c.rule("u:low", held::PIN, 0).await;
        says(c.pin("pinr", pinned).await, NO, no_pin, "denied here");
        says(c.pin("low", pinned).await, OK, "", "allowed here");
        c.rule("everyone", 0, masks::SEND).await;
        says(
            c.pin("low", pinned).await,
            NO,
            "No permission to send in this channel",
            "pinning also needs Send messages",
        );
        c.rule("everyone", 0, 0).await;

        c.rule("r:modr", 0, held::DELETE).await;
        says(c.delete("modr", theirs).await, NO, "Not allowed", "denied");
        c.rule("everyone", 0, held::DELETE | held::PIN).await;
        says(c.pin("own", pinned).await, OK, "", "the owner keeps both");
        says(c.delete("own", theirs).await, OK, "", "the owner deletes");
        c.rule("everyone", 0, 0).await;
        c.rule("r:modr", 0, 0).await;
        let other = c.post("low").await;
        exec(&state.db, "INSERT INTO member_timeouts(server, username, until, created_at) VALUES('club', 'modr', 99999999999, 0)").await;
        let db = &state.db;
        let message = resolve_message(db, other, Some(&mem_user("modr", false)), &Proof::none())
            .await
            .expect("readable");
        let channel = message.channel().expect("channel");
        assert!(
            !channel.moderates_messages(db).await.expect("gate"),
            "a timeout takes Manage messages away"
        );
        exec(db, "DELETE FROM member_timeouts").await;
        assert!(channel.moderates_messages(db).await.expect("gate"));
        says(c.delete("modr", other).await, OK, "", "Manage messages");
        says(
            c.delete("low", c.post("low").await).await,
            OK,
            "",
            "your own",
        );
        drop(temp);
    }
}

#[tokio::test]
async fn mentioning_everyone_follows_the_channel() {
    for (state, temp) in each_db("bit_gates_mentions").await {
        let c = Club::new(state.clone()).await;
        let db = &state.db;
        let count = async |name: &str| {
            let user = mem_user(name, false);
            let channel = resolve_channel(db, c.channel, Some(&user), &Proof::none())
                .await
                .expect("channel");
            group_mentions(db, &channel, "@everyone hi", 5)
                .await
                .expect("mentions")
                .len()
        };
        assert_eq!((count("loud").await, count("low").await), (1, 0));
        c.rule("r:loud", 0, held::MENTION).await;
        c.rule("u:low", held::MENTION, 0).await;
        assert_eq!((count("loud").await, count("low").await), (0, 1));
        c.rule("everyone", 0, held::MENTION).await;
        assert_eq!(count("own").await, 1, "the owner keeps it");
        drop(temp);
    }
}

#[tokio::test]
async fn slow_mode_leaves_out_only_holders_of_bypass() {
    for (state, temp) in each_db("bit_gates_slowmode").await {
        let c = Club::new(state.clone()).await;
        exec(
            &state.db,
            &format!(
                "UPDATE channels SET slowmode_seconds = 600 WHERE id = {}",
                c.channel
            ),
        )
        .await;
        let twice = async |name: &str| {
            c.send(name, json!({ "content": "one" }))
                .await
                .expect("first");
            refusal(c.send(name, json!({ "content": "two" })).await).0
        };
        let slow = StatusCode::TOO_MANY_REQUESTS;
        assert_eq!(twice("low").await, slow);
        assert_eq!(twice("modr").await, slow, "Manage messages alone");
        assert_eq!(twice("fast").await, OK, "Bypass slow mode");
        assert_eq!(twice("mgr").await, OK, "Manage channels passes it");
        assert_eq!(twice("own").await, OK);
        c.rule("r:fast", 0, held::BYPASS_SLOWMODE).await;
        c.rule("u:modr", held::BYPASS_SLOWMODE, 0).await;
        exec(&state.db, "DELETE FROM messages").await;
        assert_eq!(twice("fast").await, slow, "denied here");
        assert_eq!(twice("modr").await, OK, "allowed here");
        drop(temp);
    }
}

#[tokio::test]
async fn a_site_admin_edits_their_own_message_in_a_channel() {
    for (state, _db) in each_db("bit_gates_admin_edit").await {
        let c = Club::new(state.clone()).await;
        let sent = c
            .send("low", json!({ "content": "first" }))
            .await
            .expect("send");
        let Json(edited) = edit_message(
            State(state.clone()),
            Path(sent.id),
            Authed(mem_user("low", true)),
            Json(serde_json::from_value(json!({ "content": "second" })).expect("body")),
        )
        .await
        .expect("the edit of a member who is a site admin");
        assert_eq!(edited.content, "second");
    }
}
