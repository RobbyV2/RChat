use crate::database::DbPool;
use crate::models::file::File;
use crate::services::file_validation::validate_file;
use crate::utils::crypto::hash_file;
use crate::utils::error::{AppError, AppResult};
use std::path::PathBuf;
use tokio::fs;
use tokio::io::AsyncWriteExt;

const UPLOAD_DIR: &str = "./uploads";

pub async fn save_file(
    pool: &DbPool,
    original_name: String,
    content_type: String,
    data: Vec<u8>,
    uploader_username: String,
) -> AppResult<File> {
    tracing::info!(
        "Uploading file: {} ({} bytes, type: {})",
        original_name,
        data.len(),
        content_type
    );

    let validation_result = validate_file(&data, &content_type)?;

    tracing::info!(
        "File validation passed: detected_mime={}",
        validation_result.detected_mime
    );

    fs::create_dir_all(UPLOAD_DIR)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to create upload directory: {}", e)))?;

    let file_hash = hash_file(&data);
    let file_name = format!("{}.bin", uuid::Uuid::new_v4());
    let file_path = PathBuf::from(UPLOAD_DIR).join(&file_name);

    let existing =
        sqlx::query_as::<_, File>("SELECT * FROM files WHERE file_hash = ? AND is_deleted = 0")
            .bind(&file_hash)
            .fetch_optional(pool.as_ref())
            .await?;

    if let Some(existing_file) = existing {
        tracing::info!(
            "File deduplicated: hash={}, existing_id={}",
            file_hash,
            existing_file.id
        );
        return Ok(existing_file);
    }

    let mut file = fs::File::create(&file_path)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to create file: {}", e)))?;

    file.write_all(&data)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to write file: {}", e)))?;

    let file_model = File::new(
        original_name,
        file_name,
        validation_result.detected_mime,
        data.len() as i64,
        file_hash,
        uploader_username,
    );

    sqlx::query(
        "INSERT INTO files (id, original_name, file_name, content_type, size, file_hash, upload_time, expires_at, download_count, uploader_username, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&file_model.id)
    .bind(&file_model.original_name)
    .bind(&file_model.file_name)
    .bind(&file_model.content_type)
    .bind(file_model.size)
    .bind(&file_model.file_hash)
    .bind(&file_model.upload_time)
    .bind(&file_model.expires_at)
    .bind(file_model.download_count)
    .bind(&file_model.uploader_username)
    .bind(file_model.is_deleted)
    .execute(pool.as_ref())
    .await?;

    tracing::info!(
        "File saved: id={}, name={}, size={} bytes, hash={}",
        file_model.id,
        file_model.original_name,
        file_model.size,
        &file_model.file_hash
    );

    Ok(file_model)
}

pub async fn get_file_path(pool: &DbPool, file_id: &str) -> AppResult<(PathBuf, File)> {
    tracing::debug!("Retrieving file: id={}", file_id);

    let file = sqlx::query_as::<_, File>("SELECT * FROM files WHERE id = ? AND is_deleted = 0")
        .bind(file_id)
        .fetch_optional(pool.as_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("File not found".to_string()))?;

    let path = PathBuf::from(UPLOAD_DIR).join(&file.file_name);

    if !path.exists() {
        tracing::error!("File not found on disk: id={}, path={:?}", file_id, path);
        return Err(AppError::NotFound("File not found on disk".to_string()));
    }

    sqlx::query("UPDATE files SET download_count = download_count + 1 WHERE id = ?")
        .bind(file_id)
        .execute(pool.as_ref())
        .await?;

    tracing::info!(
        "File downloaded: id={}, name={}, download_count={}",
        file_id,
        file.original_name,
        file.download_count + 1
    );

    Ok((path, file))
}

pub async fn list_user_files(pool: &DbPool, username: &str) -> AppResult<Vec<File>> {
    tracing::debug!("Listing files for user: {}", username);

    let files = sqlx::query_as::<_, File>(
        "SELECT * FROM files WHERE uploader_username = ? AND is_deleted = 0 ORDER BY upload_time DESC",
    )
    .bind(username)
    .fetch_all(pool.as_ref())
    .await?;

    tracing::debug!("Found {} files for user {}", files.len(), username);
    Ok(files)
}

pub async fn delete_file(pool: &DbPool, file_id: &str, username: &str) -> AppResult<()> {
    tracing::info!("User {} deleting file {}", username, file_id);

    let file = sqlx::query_as::<_, File>(
        "SELECT * FROM files WHERE id = ? AND uploader_username = ? AND is_deleted = 0",
    )
    .bind(file_id)
    .bind(username)
    .fetch_optional(pool.as_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("File not found or access denied".to_string()))?;

    sqlx::query("UPDATE files SET is_deleted = 1 WHERE id = ?")
        .bind(file_id)
        .execute(pool.as_ref())
        .await?;

    tracing::info!(
        "File marked as deleted: id={}, name={}, uploader={}",
        file_id,
        file.original_name,
        username
    );

    Ok(())
}
