use axum::{Json, http::HeaderMap};
use serde::Serialize;

pub fn to_json<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).expect("Failed to serialize to JSON")
}

pub fn json_response<T: Serialize>(value: &T) -> Json<serde_json::Value> {
    Json(to_json(value))
}

pub fn json_list<T: Serialize>(items: Vec<T>) -> Json<Vec<serde_json::Value>> {
    Json(items.into_iter().map(|item| to_json(&item)).collect())
}

pub fn extract_username(headers: &HeaderMap) -> Option<String> {
    headers
        .get(crate::middleware::auth::AUTH_USERNAME_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

pub fn system_username() -> String {
    "system".to_string()
}
