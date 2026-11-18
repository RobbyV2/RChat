use sqlx::{AnyConnection, Row};

use super::{Db, NEXT, store_next, stored_next};

const BACKFILL_ROWS: i64 = 2048;

pub(in crate::db) async fn install(conn: &mut AnyConnection) -> anyhow::Result<()> {
    if stored_next(conn).await?.is_some() {
        return Ok(());
    }
    for statement in [
        "CREATE FUNCTION rchat_search_grams(body text) RETURNS integer[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
            WITH bytes AS MATERIALIZED (SELECT convert_to(body, 'UTF8') AS b)
            SELECT ARRAY(SELECT DISTINCT hashint4((get_byte(b,i) << 16) | (get_byte(b,i+1) << 8) | get_byte(b,i+2)) & 2147483647
                         FROM bytes, generate_series(0, octet_length(b)-3) i)
         $$",
        "CREATE FUNCTION rchat_message_root_date() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
             NEW.search_root_at := NULL;
             IF NEW.thread_root_id IS NOT NULL THEN
                 SELECT created_at INTO NEW.search_root_at FROM messages WHERE id = NEW.thread_root_id FOR SHARE;
             END IF;
             RETURN NEW;
         END $$",
        "CREATE TRIGGER messages_search_root BEFORE INSERT OR UPDATE OF thread_root_id ON messages
         FOR EACH ROW EXECUTE FUNCTION rchat_message_root_date()",
        "CREATE FUNCTION rchat_finish_reply_date() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
             UPDATE messages SET search_root_at=(SELECT created_at FROM messages WHERE id=NEW.thread_root_id FOR SHARE)
             WHERE id=NEW.id;
             RETURN NULL;
         END $$",
        "CREATE TRIGGER messages_search_root_inserted AFTER INSERT OR UPDATE OF thread_root_id ON messages
         FOR EACH ROW WHEN (NEW.thread_root_id IS NOT NULL AND NEW.search_root_at IS NULL) EXECUTE FUNCTION rchat_finish_reply_date()",
        "CREATE FUNCTION rchat_update_reply_dates() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
             UPDATE messages SET search_root_at = NEW.created_at WHERE thread_root_id = NEW.id;
             RETURN NULL;
         END $$",
        "CREATE TRIGGER messages_search_replies AFTER UPDATE OF created_at ON messages
         FOR EACH ROW WHEN (OLD.created_at IS DISTINCT FROM NEW.created_at) EXECUTE FUNCTION rchat_update_reply_dates()",
    ] {
        sqlx::query(statement).execute(&mut *conn).await?;
    }
    let top: Option<i64> = sqlx::query_scalar("SELECT MAX(id) FROM messages")
        .fetch_one(&mut *conn)
        .await?;
    store_next(conn, top.unwrap_or(0)).await?;
    Ok(())
}

pub(super) async fn backfill(db: &Db) -> anyhow::Result<bool> {
    let mut tx = db.begin().await?;
    let next: i64 = sqlx::query("SELECT value FROM settings WHERE key = $1 FOR UPDATE")
        .bind(NEXT)
        .fetch_one(&mut *tx)
        .await?
        .try_get::<String, _>(0)?
        .parse()?;
    if next == 0 {
        tx.commit().await?;
        return Ok(true);
    }
    let low: Option<i64> = sqlx::query_scalar("SELECT MIN(id) FROM (SELECT id FROM messages WHERE id <= $1 ORDER BY id DESC LIMIT $2) batch")
        .bind(next).bind(BACKFILL_ROWS).fetch_one(&mut *tx).await?;
    if let Some(low) = low {
        sqlx::query("UPDATE messages SET thread_root_id = thread_root_id WHERE id BETWEEN $1 AND $2 AND thread_root_id IS NOT NULL AND search_root_at IS NULL")
            .bind(low).bind(next).execute(&mut *tx).await?;
    }
    let left = low.unwrap_or(1).saturating_sub(1).max(0);
    store_next(&mut tx, left).await?;
    tx.commit().await?;
    Ok(left == 0)
}
