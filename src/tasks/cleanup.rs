use chrono::Utc;
use sqlx::{FromRow, Row, SqlitePool};
use std::path::Path;
use std::sync::Arc;
use tokio::fs;

#[derive(FromRow)]
struct ExpiredFile {
    id: String,
    file_name: String,
}

pub async fn cleanup_expired_files(db: &SqlitePool) -> anyhow::Result<usize> {
    let now = Utc::now().to_rfc3339();

    tracing::info!("Starting cleanup of expired files");

    let expired_files = sqlx::query_as::<_, ExpiredFile>(
        "SELECT id, file_name FROM files WHERE expires_at < ? AND is_deleted = 0",
    )
    .bind(&now)
    .fetch_all(db)
    .await?;

    let count = expired_files.len();
    tracing::info!("Found {} expired files to delete", count);

    for file in expired_files {
        let file_path = format!("./uploads/{}", file.file_name);

        if Path::new(&file_path).exists() {
            match fs::remove_file(&file_path).await {
                Ok(_) => {
                    tracing::info!("Deleted file from disk: {}", file_path);
                }
                Err(e) => {
                    tracing::warn!("Failed to delete file {}: {}", file_path, e);
                }
            }
        }

        let file_metadata = sqlx::query("SELECT original_name FROM files WHERE id = ?")
            .bind(&file.id)
            .fetch_one(db)
            .await?;
        let original_name: String = file_metadata.get("original_name");

        sqlx::query("UPDATE files SET is_deleted = 1 WHERE id = ?")
            .bind(&file.id)
            .execute(db)
            .await?;

        let message_ids = sqlx::query("SELECT message_id FROM file_attachments WHERE file_id = ?")
            .bind(&file.id)
            .fetch_all(db)
            .await?;

        for row in message_ids {
            let message_id: String = row.get("message_id");
            let removal_notice = format!(
                "[File '{}' was removed after 1 day of posting]",
                original_name
            );

            sqlx::query("UPDATE messages SET content = ? WHERE id = ?")
                .bind(&removal_notice)
                .bind(&message_id)
                .execute(db)
                .await?;

            sqlx::query("DELETE FROM file_attachments WHERE message_id = ? AND file_id = ?")
                .bind(&message_id)
                .bind(&file.id)
                .execute(db)
                .await?;

            tracing::info!("Updated message {} with file removal notice", message_id);
        }

        tracing::info!("Marked file as deleted in database: {}", file.id);
    }

    tracing::info!("Cleanup completed: {} files processed", count);
    Ok(count)
}

pub fn start_cleanup_task(db: Arc<SqlitePool>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(3600));

        loop {
            interval.tick().await;

            match cleanup_expired_files(db.as_ref()).await {
                Ok(count) => {
                    tracing::info!("File cleanup task completed: {} files cleaned", count);
                }
                Err(e) => {
                    tracing::error!("File cleanup task failed: {}", e);
                }
            }
        }
    });
}
