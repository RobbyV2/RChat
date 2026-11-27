use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::any::AnyRow;
use utoipa::ToSchema;

use crate::api::{ApiError, ServerSummaryLite};
use crate::db::{Db, LIVE_AUTHOR, User};

/// A person as a report keeps them: the names they had when the report was sent. Once the
/// account is deleted only `deleted` is left.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(default)]
pub struct SnapUser {
    /// The username.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// The display name at the time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// The account was deleted after the report.
    #[serde(skip_serializing_if = "is_false")]
    pub deleted: bool,
}

fn is_false(on: &bool) -> bool {
    !*on
}

impl SnapUser {
    pub fn of(user: &User) -> SnapUser {
        SnapUser::named(&user.username, &user.display_name)
    }

    pub fn named(username: &str, display_name: &str) -> SnapUser {
        SnapUser {
            username: Some(username.to_string()),
            display_name: Some(display_name.to_string()),
            deleted: false,
        }
    }
}

/// The file a reported message carried: its name, type and size, never its content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SnapFile {
    /// The file's name.
    pub filename: String,
    /// Its media type.
    pub mime: Option<String>,
    /// Bytes.
    pub size: Option<i64>,
}

/// A message as it was when the report was sent. Later edits and deletes don't change it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SnapMessage {
    /// The message id.
    pub id: i64,
    /// Who wrote it; `null` for a webhook's post.
    pub author: Option<SnapUser>,
    /// The name a webhook posted it under.
    pub webhook: Option<String>,
    /// `user` or `poll`.
    pub kind: String,
    /// The text.
    pub content: String,
    /// When it was sent, unix seconds.
    pub created_at: i64,
    /// When it was last edited before the report, unix seconds.
    pub edited_at: Option<i64>,
    /// The thread it is a reply in.
    pub thread_root_id: Option<i64>,
    /// The file it carried.
    pub file: Option<SnapFile>,
}

/// A reported server as it was when the report was sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SnapServer {
    /// The server's name, its key.
    pub name: String,
    /// The name in its original casing.
    pub display_name: String,
    /// Username of its creator.
    pub creator: Option<String>,
    /// How many members it had.
    pub member_count: i64,
    /// Whether joining it needed a password.
    #[serde(default)]
    pub has_password: bool,
    /// Its "Anyone can read this server" option: `null` followed the instance.
    #[serde(default)]
    pub public_read: Option<bool>,
    /// Its description, when it had one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// What a report keeps of its target, taken when it was sent.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(default)]
pub struct Snapshot {
    /// The reported message.
    pub message: Option<SnapMessage>,
    /// Up to 10 messages before it from the same channel, thread or direct conversation,
    /// oldest first, when the reporter chose to include them.
    pub context: Vec<SnapMessage>,
    /// The reported account.
    pub user: Option<SnapUser>,
    /// The reported server.
    pub server: Option<SnapServer>,
    /// The name of the channel the message was in.
    pub channel: Option<String>,
}

const MESSAGE: &str = "SELECT m.id, m.author, m.kind, m.content, m.created_at, m.edited_at, m.thread_root_id, m.media_filename, COALESCE(m.media_mime, md.mime), COALESCE(m.media_size, md.size), m.media_removed, m.webhook_id, m.webhook_name, u.display_name FROM messages m LEFT JOIN users u ON u.username = m.author LEFT JOIN media md ON md.id = m.media_id";

fn message_of(r: &AnyRow) -> sqlx::Result<SnapMessage> {
    let author: String = r.try_get(1)?;
    let webhook = r.try_get::<Option<i64>, _>(11)?.is_some();
    let removed = r.try_get::<i64, _>(10)? != 0;
    let file = match (r.try_get::<Option<String>, _>(7)?, removed) {
        (Some(filename), false) => Some(SnapFile {
            filename,
            mime: r.try_get(8)?,
            size: r.try_get(9)?,
        }),
        (_, _) => None,
    };
    Ok(SnapMessage {
        id: r.try_get(0)?,
        author: match webhook {
            true => None,
            false => {
                let display: Option<String> = r.try_get(13)?;
                Some(SnapUser::named(
                    &author,
                    display.as_deref().unwrap_or(&author),
                ))
            }
        },
        webhook: match webhook {
            true => r.try_get(12)?,
            false => None,
        },
        kind: r.try_get(2)?,
        content: r.try_get(3)?,
        created_at: r.try_get(4)?,
        edited_at: r.try_get(5)?,
        thread_root_id: r.try_get(6)?,
        file,
    })
}

/// Where a reported message is, for its context.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Place {
    /// The top level of a channel.
    Channel(i64),
    /// A thread, by its first message.
    Thread(i64),
    Dm(i64),
}

/// The message `id` as it is now.
pub(crate) async fn message(db: &Db, id: i64) -> Result<Option<SnapMessage>, ApiError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!("{MESSAGE} WHERE m.id = $1")))
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(row.as_ref().map(message_of).transpose()?)
}

/// The `count` newest messages before `id` in `place`, oldest first: only what people wrote
/// (`user` and `poll`), by accounts that are not being deleted, and nothing from before
/// `since`, the start of what the reporter may read there.
pub(crate) async fn context(
    db: &Db,
    id: i64,
    place: Place,
    since: Option<i64>,
    count: u8,
) -> Result<Vec<SnapMessage>, ApiError> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let (clause, key) = match place {
        Place::Channel(channel) => ("m.channel_id = $2 AND m.thread_root_id IS NULL", channel),
        Place::Thread(root) => ("(m.thread_root_id = $2 OR m.id = $2)", root),
        Place::Dm(dm) => ("m.dm_id = $2", dm),
    };
    let sql = format!(
        "{MESSAGE} WHERE m.id < $1 AND {clause} AND m.kind IN ('user', 'poll') AND m.created_at >= $3 AND {LIVE_AUTHOR} ORDER BY m.id DESC LIMIT $4"
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(key)
        .bind(since.unwrap_or(0))
        .bind(i64::from(count))
        .fetch_all(db)
        .await?;
    let mut out = rows
        .iter()
        .map(message_of)
        .collect::<sqlx::Result<Vec<_>>>()?;
    out.reverse();
    Ok(out)
}

/// The server `lite` as a report about it keeps it.
pub(crate) async fn server(db: &Db, lite: &ServerSummaryLite) -> Result<SnapServer, ApiError> {
    let member_count: i64 = sqlx::query("SELECT member_count FROM servers WHERE name = $1")
        .bind(&lite.name)
        .fetch_optional(db)
        .await?
        .map(|r| r.try_get(0))
        .transpose()?
        .unwrap_or(0);
    Ok(SnapServer {
        name: lite.name.clone(),
        display_name: lite.display_name.clone(),
        creator: lite.creator.clone(),
        member_count,
        has_password: lite.has_password,
        public_read: lite.public_read,
        description: lite.description.clone(),
    })
}
