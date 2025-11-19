use crate::utils::error::{AppError, AppResult};

const MAX_FILE_SIZE: usize = 25 * 1024 * 1024;

const ALLOWED_MIME_TYPES: &[&str] = &[
    "application/octet-stream", // Generic binary
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "video/mp4",
    "video/webm",
    "video/ogg",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/json",
    "application/zip",
    "application/x-zip-compressed",
];

pub struct FileValidationResult {
    pub is_valid: bool,
    pub detected_mime: String,
    pub error: Option<String>,
}

pub fn validate_file_size(data: &[u8]) -> AppResult<()> {
    if data.is_empty() {
        return Err(AppError::Validation("File is empty".to_string()));
    }

    if data.len() > MAX_FILE_SIZE {
        return Err(AppError::Validation(format!(
            "File too large: {} bytes (max {} bytes)",
            data.len(),
            MAX_FILE_SIZE
        )));
    }

    Ok(())
}

pub fn validate_mime_type(content_type: &str) -> AppResult<()> {
    let normalized = content_type.to_lowercase();
    let base_type = normalized.split(';').next().unwrap_or(&normalized).trim();

    if !ALLOWED_MIME_TYPES.contains(&base_type) {
        return Err(AppError::Validation(format!(
            "File type not allowed: {}. Allowed types: images, videos, audio, PDF, text, JSON, ZIP",
            base_type
        )));
    }

    Ok(())
}

pub fn detect_mime_from_bytes(data: &[u8]) -> String {
    if data.len() < 12 {
        return "application/octet-stream".to_string();
    }

    match &data[0..4] {
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg".to_string(),
        [0x89, 0x50, 0x4E, 0x47] => "image/png".to_string(),
        [0x47, 0x49, 0x46, 0x38] => "image/gif".to_string(),
        [0x25, 0x50, 0x44, 0x46] => "application/pdf".to_string(),
        [0x50, 0x4B, 0x03, 0x04] => "application/zip".to_string(),
        [0x50, 0x4B, 0x05, 0x06] => "application/zip".to_string(),
        [0x50, 0x4B, 0x07, 0x08] => "application/zip".to_string(),
        _ => {
            if data.len() >= 12 {
                match &data[0..12] {
                    [0x00, 0x00, 0x00, _, 0x66, 0x74, 0x79, 0x70, ..] => "video/mp4".to_string(),
                    [0x1A, 0x45, 0xDF, 0xA3, ..] => "video/webm".to_string(),
                    [0x49, 0x44, 0x33, ..] => "audio/mpeg".to_string(),
                    [0xFF, 0xFB, ..] => "audio/mpeg".to_string(),
                    [0xFF, 0xF3, ..] => "audio/mpeg".to_string(),
                    [0xFF, 0xF2, ..] => "audio/mpeg".to_string(),
                    [0x52, 0x49, 0x46, 0x46, _, _, _, _, 0x57, 0x41, 0x56, 0x45] => {
                        "audio/wav".to_string()
                    }
                    _ => {
                        if is_likely_text(data) {
                            "text/plain".to_string()
                        } else {
                            "application/octet-stream".to_string()
                        }
                    }
                }
            } else {
                "application/octet-stream".to_string()
            }
        }
    }
}

fn is_likely_text(data: &[u8]) -> bool {
    let sample_size = data.len().min(512);
    let sample = &data[0..sample_size];

    let mut text_chars = 0;
    let mut total_chars = 0;

    for &byte in sample {
        total_chars += 1;
        if byte == b'\n'
            || byte == b'\r'
            || byte == b'\t'
            || (32..=126).contains(&byte)
            || byte >= 128
        {
            text_chars += 1;
        }
    }

    text_chars as f64 / total_chars as f64 > 0.85
}

pub fn validate_file(data: &[u8], claimed_mime: &str) -> AppResult<FileValidationResult> {
    validate_file_size(data)?;

    let detected_mime = detect_mime_from_bytes(data);

    let normalized_claimed = claimed_mime.to_lowercase();
    let normalized_detected = detected_mime.to_lowercase();

    let claimed_base = normalized_claimed
        .split(';')
        .next()
        .unwrap_or(&normalized_claimed)
        .trim();
    let detected_base = normalized_detected
        .split(';')
        .next()
        .unwrap_or(&normalized_detected)
        .trim();

    if claimed_base != detected_base
        && claimed_base != "application/octet-stream"
        && detected_base != "application/octet-stream"
    {
        tracing::warn!(
            "MIME type mismatch: claimed={}, detected={}",
            claimed_base,
            detected_base
        );
    }

    let final_mime = if detected_base != "application/octet-stream" {
        detected_base.to_string()
    } else {
        claimed_base.to_string()
    };

    validate_mime_type(&final_mime)?;

    Ok(FileValidationResult {
        is_valid: true,
        detected_mime: final_mime,
        error: None,
    })
}
