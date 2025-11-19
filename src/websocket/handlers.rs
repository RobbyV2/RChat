use axum::{
    extract::{
        FromRequest, Query, Request, State,
        ws::{WebSocket, WebSocketUpgrade},
    },
    http::header,
    response::Response,
};
use serde::Deserialize;
use std::sync::Arc;

use crate::api::AppState;

#[derive(Deserialize)]
pub struct WsQuery {
    token: Option<String>,
}

pub async fn ws_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<WsQuery>,
    request: Request,
) -> Result<Response, axum::http::StatusCode> {
    let token = query.token.or_else(|| {
        request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .map(|t| t.to_string())
    });

    let username = token
        .and_then(|t| state.jwt_service.extract_username(&t).ok())
        .unwrap_or_else(|| "guest".to_string());

    let state_clone = state.clone();
    let ws = WebSocketUpgrade::from_request(request, &state)
        .await
        .map_err(|_| axum::http::StatusCode::BAD_REQUEST)?;

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, state_clone, username)))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, username: String) {
    state
        .ws_manager
        .handle_connection(socket, username, state.db.clone())
        .await;
}
