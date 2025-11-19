use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{RwLock, broadcast};
use uuid::Uuid;

use super::events::{ClientMessage, ServerMessage};

pub type Connections = Arc<RwLock<HashMap<String, broadcast::Sender<ServerMessage>>>>;

pub struct ConnectionManager {
    connections: Connections,
    broadcast_tx: broadcast::Sender<ServerMessage>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        let (broadcast_tx, _) = broadcast::channel(1000);
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            broadcast_tx,
        }
    }

    async fn set_user_online(&self, db: &SqlitePool, username: &str) {
        if username != "guest" {
            let _ = sqlx::query(
                "UPDATE server_members
                 SET is_online = 1, last_seen = datetime('now')
                 WHERE LOWER(username) = LOWER(?)",
            )
            .bind(username)
            .execute(db)
            .await;

            let server_names: Vec<String> = sqlx::query_scalar(
                "SELECT server_name FROM server_members WHERE LOWER(username) = LOWER(?)",
            )
            .bind(username)
            .fetch_all(db)
            .await
            .unwrap_or_default();

            for server_name in server_names {
                let _ = self
                    .broadcast_tx
                    .send(ServerMessage::UserOnlineStatusChanged {
                        server_name,
                        username: username.to_string(),
                        is_online: true,
                    });
            }
        }
    }

    async fn set_user_offline(&self, db: &SqlitePool, username: &str) {
        if username != "guest" {
            let _ = sqlx::query(
                "UPDATE server_members
                 SET is_online = 0, last_seen = datetime('now')
                 WHERE LOWER(username) = LOWER(?)",
            )
            .bind(username)
            .execute(db)
            .await;

            let server_names: Vec<String> = sqlx::query_scalar(
                "SELECT server_name FROM server_members WHERE LOWER(username) = LOWER(?)",
            )
            .bind(username)
            .fetch_all(db)
            .await
            .unwrap_or_default();

            for server_name in server_names {
                let _ = self
                    .broadcast_tx
                    .send(ServerMessage::UserOnlineStatusChanged {
                        server_name,
                        username: username.to_string(),
                        is_online: false,
                    });
            }
        }
    }

    pub async fn handle_connection(
        &self,
        socket: WebSocket,
        username: String,
        db: Arc<SqlitePool>,
    ) {
        let (mut sender, mut receiver) = socket.split();
        let mut rx = self.broadcast_tx.subscribe();

        let connection_id = Uuid::new_v4().to_string();

        {
            let mut conns = self.connections.write().await;
            conns.insert(connection_id.clone(), self.broadcast_tx.clone());
        }

        let send_task = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(msg) => {
                        if let Ok(json) = serde_json::to_string(&msg)
                            && sender.send(Message::Text(json)).await.is_err()
                        {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
        });

        let broadcast_tx_recv = self.broadcast_tx.clone();
        let connections_clone = self.connections.clone();
        let connection_id_clone = connection_id.clone();

        let recv_task = tokio::spawn(async move {
            while let Some(Ok(msg)) = receiver.next().await {
                if let Message::Text(text) = msg
                    && let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text)
                    && let ClientMessage::Heartbeat = client_msg
                {
                    let _ = broadcast_tx_recv.send(ServerMessage::Pong);
                }
            }

            let mut conns = connections_clone.write().await;
            conns.remove(&connection_id_clone);
        });

        tokio::task::yield_now().await;

        self.set_user_online(&db, &username).await;

        tokio::select! {
            _ = send_task => {},
            _ = recv_task => {},
        }

        self.set_user_offline(&db, &username).await;
    }

    pub async fn broadcast(&self, message: ServerMessage) {
        let _ = self.broadcast_tx.send(message);
    }
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}
