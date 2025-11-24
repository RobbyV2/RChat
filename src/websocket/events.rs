use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Subscribe { channel_id: String },
    Unsubscribe { channel_id: String },
    SendMessage { channel_id: String, content: String },
    Typing { channel_id: String },
    Heartbeat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Connected {
        username: String,
    },
    NewMessage {
        message_id: String,
        channel_id: String,
        sender_username: String,
        content: String,
        filtered_content: Option<String>,
        content_type: String,
        filter_status: String,
        created_at: String,
        sender_profile_type: Option<String>,
        sender_avatar_color: Option<String>,
        attachments: Option<Vec<serde_json::Value>>,
    },
    MessageDeleted {
        message_id: String,
        channel_id: Option<String>,
        dm_id: Option<String>,
    },
    UserJoined {
        username: String,
        channel_id: String,
    },
    UserLeft {
        username: String,
        channel_id: String,
    },
    UserTyping {
        username: String,
        channel_id: String,
    },
    ServerCreated {
        server_name: String,
        owner_username: String,
    },
    ServerDeleted {
        server_name: String,
    },
    ServerMemberJoined {
        server_name: String,
        username: String,
    },
    ServerMemberLeft {
        server_name: String,
        username: String,
    },
    ServerMemberRoleUpdated {
        server_name: String,
        username: String,
        new_role: String,
    },
    UserOnlineStatusChanged {
        server_name: String,
        username: String,
        is_online: bool,
    },
    ChannelCreated {
        server_name: String,
        channel_id: String,
        channel_name: String,
    },
    ChannelDeleted {
        server_name: String,
        channel_id: String,
    },
    ChannelRenamed {
        server_name: String,
        channel_id: String,
        new_name: String,
    },
    UserBanned {
        username: String,
    },
    NewDmMessage {
        message_id: String,
        dm_id: String,
        sender_username: String,
        content: String,
        filtered_content: Option<String>,
        content_type: String,
        filter_status: String,
        created_at: String,
        sender_profile_type: Option<String>,
        sender_avatar_color: Option<String>,
        attachments: Option<Vec<serde_json::Value>>,
    },
    DmCreated {
        dm_id: String,
        username1: String,
        username2: String,
    },
    ServerStatsUpdated {
        server_name: String,
        member_count: i64,
        channel_count: i64,
    },
    FileDownloaded {
        file_id: String,
        download_count: i64,
    },
    Error {
        message: String,
    },
    Pong,
}
