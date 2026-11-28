//! Rich embeds: cards with an author line, a title, text, fields, a footer and a time. Webhooks
//! post them, and members attach them to their own messages. A message stores them in its parts
//! (`Parts::embeds`), so they are sealed with its text where its place is stored encrypted.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use url::Url;
use utoipa::ToSchema;

use crate::api::access::perms::{ChannelAccess, held};
use crate::api::{ApiError, ProfanityTarget, Settings, check_len};

/// Rich embeds a webhook may post with one message.
pub const HOOK_MAX: usize = 10;
/// Rich embeds a member may attach to one message.
pub const MEMBER_MAX: usize = 5;
/// Characters of all the text of one message's rich embeds together.
pub const TEXT_MAX: usize = 6000;
pub const FIELDS_MAX: usize = 25;
pub const URL_MAX: usize = 2048;
/// The last second of the year 9999.
pub const TIMESTAMP_MAX: i64 = 253_402_300_799;

/// A field of a rich embed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct EmbedField {
    /// At most 256 characters, not blank.
    pub name: String,
    /// At most 1024 characters, not blank.
    pub value: String,
    /// Shown next to other inline fields. Defaults to `false`.
    #[serde(default)]
    pub inline: bool,
}

/// The footer of a rich embed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct EmbedFooter {
    /// At most 2048 characters, not blank.
    pub text: String,
}

/// The line above a rich embed's title.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct EmbedAuthor {
    /// At most 256 characters, not blank.
    pub name: String,
    /// An `http(s)` link for the name, at most 2048 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// A rich embed: a card with an author line, a title (linked when `url` is set), text, fields, a
/// footer and a time. Webhooks post them, and members attach them to their messages. All text
/// counts toward 6000 characters per message, and passes the profanity filter like message text
/// in server channels. Nothing in it is fetched: it names no images.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct RichEmbed {
    /// At most 256 characters.
    #[serde(default)]
    pub title: Option<String>,
    /// At most 4096 characters. Rendered like message text (markdown, so `[text](https://...)`
    /// links).
    #[serde(default)]
    pub description: Option<String>,
    /// An `http(s)` link for the title, at most 2048 characters.
    #[serde(default)]
    pub url: Option<String>,
    /// Accent color as an integer `0xRRGGBB` (0 to 16777215).
    #[serde(default)]
    pub color: Option<i64>,
    /// At most 25.
    #[serde(default)]
    pub fields: Vec<EmbedField>,
    /// Small text at the bottom.
    #[serde(default)]
    pub footer: Option<EmbedFooter>,
    /// The line above the title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<EmbedAuthor>,
    /// A time shown next to the footer, in Unix seconds from 0 to 253402300799. An RFC 3339 date
    /// (`2026-11-27T10:00:00Z`) is also taken, and stored as seconds.
    #[serde(
        default,
        deserialize_with = "seconds",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(value_type = Option<i64>, example = 1795773600)]
    pub timestamp: Option<i64>,
}

fn seconds<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Stamp {
        Seconds(i64),
        Date(String),
    }
    match Option::<Stamp>::deserialize(d)? {
        None => Ok(None),
        Some(Stamp::Seconds(s)) => Ok(Some(s)),
        Some(Stamp::Date(text)) => OffsetDateTime::parse(&text, &Rfc3339)
            .map(|t| Some(t.unix_timestamp()))
            .map_err(|_| D::Error::custom("timestamp must be Unix seconds or an RFC 3339 date")),
    }
}

/// Rich embeds as a message's parts store them; nothing when unreadable.
pub fn parse_embeds(stored: Option<&str>) -> Vec<RichEmbed> {
    stored
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

fn blank(s: &str) -> bool {
    s.trim().is_empty()
}

fn web_url(raw: &str) -> bool {
    raw.chars().count() <= URL_MAX
        && Url::parse(raw).is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.has_host())
}

fn bad(text: &str) -> ApiError {
    ApiError::invalid(text, "embeds")
}

/// Checks `list` (counts, lengths, links, colors, times, and with `filter` the profanity
/// filter) and trims nothing. The first problem found is the answer; the client checks in the
/// same order (`apps/web/app/lib/rich_embeds.ts`, cases in `assets/rich_embed_cases.json`).
fn check(list: &[RichEmbed], max: usize, filter: Option<&Settings>) -> Result<(), ApiError> {
    if list.len() > max {
        return Err(bad(&format!("At most {max} embeds")));
    }
    let mut total = 0;
    for e in list {
        let RichEmbed {
            title,
            description,
            url,
            color,
            fields,
            footer,
            author,
            timestamp,
        } = e;
        let mut texts: Vec<(&str, usize, &str)> = Vec::new();
        if let Some(t) = title {
            texts.push((t, 256, "Embed title"));
        }
        if let Some(d) = description {
            texts.push((d, 4096, "Embed description"));
        }
        if let Some(a) = author {
            if blank(&a.name) {
                return Err(bad("Embed author is empty"));
            }
            texts.push((&a.name, 256, "Embed author"));
        }
        if fields.len() > FIELDS_MAX {
            return Err(bad("At most 25 embed fields"));
        }
        for f in fields {
            if blank(&f.name) || blank(&f.value) {
                return Err(bad("Embed fields need a name and a value"));
            }
            texts.push((&f.name, 256, "Embed field name"));
            texts.push((&f.value, 1024, "Embed field value"));
        }
        if let Some(f) = footer {
            if blank(&f.text) {
                return Err(bad("Embed footer is empty"));
            }
            texts.push((&f.text, 2048, "Embed footer"));
        }
        if let Some(u) = url
            && !web_url(u)
        {
            return Err(bad("Embed url must be an http or https link"));
        }
        if let Some(u) = author.as_ref().and_then(|a| a.url.as_deref())
            && !web_url(u)
        {
            return Err(bad("Embed author url must be an http or https link"));
        }
        if let Some(c) = color
            && !(0..=0xff_ffff).contains(c)
        {
            return Err(bad("Embed color must be between 0 and 16777215"));
        }
        if let Some(t) = timestamp
            && !(0..=TIMESTAMP_MAX).contains(t)
        {
            return Err(bad("Embed timestamp is out of range"));
        }
        let shown = title.as_deref().is_some_and(|t| !blank(t))
            || description.as_deref().is_some_and(|d| !blank(d))
            || author.is_some()
            || !fields.is_empty()
            || footer.is_some();
        if !shown {
            return Err(bad("Embed is empty"));
        }
        for (text, max, what) in texts {
            check_len(text, max, what)?;
            total += text.chars().count();
            if let Some(settings) = filter {
                settings.check_profanity(ProfanityTarget::Messages, text)?;
            }
        }
    }
    match total > TEXT_MAX {
        true => Err(bad("Embeds must have at most 6000 characters in total")),
        false => Ok(()),
    }
}

/// The rich embeds of a message, checked for where they go. Only these constructors make one,
/// so a message stores no embed that skipped the checks.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Cards(Vec<RichEmbed>);

impl Cards {
    pub fn none() -> Cards {
        Cards(Vec::new())
    }

    /// A webhook's: at most 10, through the profanity filter (webhooks post only in server
    /// channels).
    pub fn hook(list: Vec<RichEmbed>, settings: &Settings) -> Result<Cards, ApiError> {
        check(&list, HOOK_MAX, Some(settings))?;
        Ok(Cards(list))
    }

    /// A member's: at most 5. In a server channel (`rights`, as the access gate resolved them)
    /// only with Embed links there, and through the profanity filter; in a DM (`None`) always.
    pub fn member(
        list: Vec<RichEmbed>,
        rights: Option<&ChannelAccess>,
        settings: &Settings,
    ) -> Result<Cards, ApiError> {
        if list.is_empty() {
            return Ok(Cards::none());
        }
        if rights.is_some_and(|held| !held.holds(held::EMBED)) {
            return Err(ApiError::perm(
                "No permission to embed links in this channel",
                "EmbedLinks",
            ));
        }
        check(&list, MEMBER_MAX, rights.map(|_| settings))?;
        Ok(Cards(list))
    }

    /// What a stored message carries (checked when it was written).
    pub fn stored(stored: Option<&str>) -> Cards {
        Cards(parse_embeds(stored))
    }

    pub fn list(&self) -> &[RichEmbed] {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The stored form, for `Parts::embeds`.
    pub fn stored_form(&self) -> Option<String> {
        match self.0.is_empty() {
            true => None,
            false => serde_json::to_string(&self.0).ok(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Json;
    use axum::extract::{Path, Query, State};
    use axum::http::HeaderMap;
    use serde_json::json;

    use crate::api::messages::{
        EditReq, PageQuery, SendReq, channel_messages, edit_message, send_channel_message,
        send_dm_message,
    };
    use crate::api::test_util::{add_member, each_db_keyed, mem_user};
    use crate::api::{Authed, MaybeAuthed, Message};
    use crate::state::AppState;

    fn req(body: serde_json::Value) -> SendReq {
        serde_json::from_value(body).expect("send req")
    }

    async fn post(
        state: &AppState,
        cid: i64,
        body: serde_json::Value,
    ) -> Result<Message, ApiError> {
        send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(mem_user("bob", false)),
            Json(req(body)),
        )
        .await
        .map(|Json(m)| m)
    }

    async fn edit(state: &AppState, id: i64, body: serde_json::Value) -> Result<Message, ApiError> {
        let edit: EditReq = serde_json::from_value(body).expect("edit req");
        edit_message(
            State(state.clone()),
            Path(id),
            Authed(mem_user("bob", false)),
            Json(edit),
        )
        .await
        .map(|Json(m)| m)
    }

    async fn page(state: &AppState, cid: i64) -> Vec<Message> {
        channel_messages(
            State(state.clone()),
            MaybeAuthed(Some(mem_user("alice", false))),
            HeaderMap::new(),
            Path(cid),
            Query(PageQuery::default()),
        )
        .await
        .expect("page")
        .0
    }

    fn card(title: &str) -> RichEmbed {
        RichEmbed {
            title: Some(title.to_string()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn a_member_sends_edits_and_removes_embeds_sealed_with_the_text() {
        for (state, temp) in each_db_keyed("member_embeds").await {
            let db = &state.db;
            for name in ["alice", "bob"] {
                crate::db::NewUser::plain(name).add(db).await;
                add_member(db, "rchat", name, i64::from(name == "alice"), 0, 1).await;
            }
            let cid: i64 = sqlx::query_scalar(
                "SELECT id FROM channels WHERE server = 'rchat' ORDER BY id LIMIT 1",
            )
            .fetch_one(db)
            .await
            .expect("channel");
            let sent = post(
                &state,
                cid,
                json!({"content": "", "embeds": [{"title": "Release", "author": {"name": "Team"}, "timestamp": "2026-11-27T10:00:00Z"}]}),
            )
            .await
            .unwrap_or_else(|e| panic!("send: {}", e.1));
            let want = RichEmbed {
                author: Some(EmbedAuthor {
                    name: "Team".to_string(),
                    url: None,
                }),
                timestamp: Some(1_795_773_600),
                ..card("Release")
            };
            assert_eq!(
                sent.rich_embeds,
                std::slice::from_ref(&want),
                "a message of embeds alone"
            );
            assert!(sent.webhook.is_none());
            let shown = page(&state, cid).await;
            assert_eq!(
                shown.last().map(|m| m.rich_embeds.clone()),
                Some(vec![want])
            );
            let refused = post(
                &state,
                cid,
                json!({"content": "", "embeds": [{"title": "T"}], "poll": {"kind": "single", "question": "Q", "options": [{"text": "A"}, {"text": "B"}]}}),
            )
            .await;
            assert_eq!(
                refused.err().map(|e| e.1).as_deref(),
                Some("Polls cannot have embeds")
            );
            let bad = post(&state, cid, json!({"content": "x", "embeds": [{}]})).await;
            assert_eq!(bad.err().map(|e| e.1).as_deref(), Some("Embed is empty"));

            let changed = edit(
                &state,
                sent.id,
                json!({"content": "words", "embeds": [{"title": "One"}, {"title": "Two"}]}),
            )
            .await
            .unwrap_or_else(|e| panic!("edit: {}", e.1));
            assert_eq!(changed.rich_embeds, [card("One"), card("Two")]);
            let kept = edit(&state, sent.id, json!({"content": "other words"}))
                .await
                .unwrap_or_else(|e| panic!("keep: {}", e.1));
            assert_eq!(kept.rich_embeds.len(), 2, "omitted embeds stay");
            let emptied = edit(&state, sent.id, json!({"content": "", "embeds": []})).await;
            assert_eq!(
                emptied.err().map(|e| e.1).as_deref(),
                Some("Message is empty")
            );

            crate::api::servers::update_server(
                State(state.clone()),
                Authed(mem_user("alice", false)),
                Path("rchat".to_string()),
                Json(serde_json::from_value(json!({"seal": true})).expect("patch")),
            )
            .await
            .map(|_| ())
            .expect("switch");
            let sealed = post(
                &state,
                cid,
                json!({"content": "secret words", "embeds": [{"title": "Secret card"}]}),
            )
            .await
            .unwrap_or_else(|e| panic!("sealed send: {}", e.1));
            let (plain, body): (Option<String>, Option<Vec<u8>>) =
                sqlx::query_as("SELECT webhook_embeds, body FROM messages WHERE id = $1")
                    .bind(sealed.id)
                    .fetch_one(db)
                    .await
                    .expect("row");
            assert_eq!(plain, None, "no plain copy of the embeds");
            assert!(body.is_some(), "sealed with the text");
            let shown = page(&state, cid).await;
            assert_eq!(
                shown.last().map(|m| m.rich_embeds.clone()),
                Some(vec![card("Secret card")])
            );
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn a_dm_takes_embeds_without_a_permission() {
        for (state, temp) in each_db_keyed("dm_embeds").await {
            let db = &state.db;
            for name in ["alice", "bob"] {
                crate::db::NewUser::plain(name).add(db).await;
            }
            let dm: i64 = sqlx::query_scalar(
                "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
            )
            .fetch_one(db)
            .await
            .expect("dm");
            let sent = send_dm_message(
                State(state.clone()),
                Path(dm),
                Authed(mem_user("bob", false)),
                Json(req(json!({"content": "", "embeds": [{"title": "Hi"}]}))),
            )
            .await
            .unwrap_or_else(|e| panic!("dm send: {}", e.1))
            .0;
            assert_eq!(sent.rich_embeds, [card("Hi")]);
            temp.done(state).await;
        }
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        embeds: Vec<RichEmbed>,
        error: Option<String>,
    }

    #[derive(Deserialize)]
    struct Cases {
        max: usize,
        cases: Vec<Case>,
    }

    #[test]
    fn embeds_are_checked_like_the_client_checks_them() {
        let Cases { max, cases } =
            serde_json::from_str(include_str!("../../../../assets/rich_embed_cases.json"))
                .expect("cases");
        assert_eq!(max, MEMBER_MAX);
        assert!(cases.len() > 20);
        for Case {
            name,
            embeds,
            error,
        } in cases
        {
            let got = check(&embeds, max, None).err().map(|e| e.1);
            assert_eq!(got, error, "{name}");
        }
    }

    #[test]
    fn times_are_taken_as_seconds_or_dates() {
        let parsed: RichEmbed =
            serde_json::from_str(r#"{"title":"T","timestamp":"2026-11-27T10:00:00.500+01:00"}"#)
                .expect("date");
        assert_eq!(parsed.timestamp, Some(1_795_770_000));
        let parsed: RichEmbed =
            serde_json::from_str(r#"{"title":"T","timestamp":12}"#).expect("seconds");
        assert_eq!(parsed.timestamp, Some(12));
        let parsed: RichEmbed =
            serde_json::from_str(r#"{"title":"T","timestamp":null}"#).expect("null");
        assert_eq!(parsed.timestamp, None);
        assert!(serde_json::from_str::<RichEmbed>(r#"{"timestamp":"yesterday"}"#).is_err());
        let back = serde_json::to_value(RichEmbed {
            timestamp: Some(5),
            ..Default::default()
        })
        .expect("json");
        assert_eq!(back["timestamp"], 5);
    }

    #[test]
    fn webhooks_post_more_embeds_than_members() {
        let one = || RichEmbed {
            title: Some("T".to_string()),
            ..Default::default()
        };
        let settings = Settings::DENY;
        assert!(Cards::hook(vec![one(); HOOK_MAX], &settings).is_ok());
        assert_eq!(
            Cards::hook(vec![one(); HOOK_MAX + 1], &settings)
                .err()
                .map(|e| e.1),
            Some("At most 10 embeds".to_string())
        );
        assert!(Cards::hook(vec![one(), RichEmbed::default()], &settings).is_err());
        assert_eq!(
            Cards::member(vec![one(); MEMBER_MAX + 1], None, &settings)
                .err()
                .map(|e| e.1),
            Some("At most 5 embeds".to_string())
        );
        let two = Cards::member(vec![one(), one()], None, &settings).expect("two");
        assert_eq!(Cards::stored(two.stored_form().as_deref()), two);
        assert_eq!(Cards::none().stored_form(), None);
    }
}
