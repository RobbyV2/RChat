-- Initial database schema for RChat

-- Users table (username IS the primary key)
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_type TEXT NOT NULL CHECK(password_type IN ('text', 'word_sequence')),
    word_sequence TEXT,
    profile_type TEXT NOT NULL CHECK(profile_type IN ('identicon', 'person')),
    avatar_color TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login TEXT,
    login_attempts INTEGER NOT NULL DEFAULT 0,
    account_locked INTEGER NOT NULL DEFAULT 0,
    lock_until TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_users_created_at ON users(created_at);

-- Servers table (name is the primary key, like usernames)
CREATE TABLE IF NOT EXISTS servers (
    name TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
    creator_username TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_active INTEGER NOT NULL DEFAULT 1,
    member_count INTEGER NOT NULL DEFAULT 0,
    channel_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (creator_username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX idx_servers_creator_username ON servers(creator_username);
CREATE INDEX idx_servers_created_at ON servers(created_at);

-- Server members table
CREATE TABLE IF NOT EXISTS server_members (
    server_name TEXT NOT NULL COLLATE NOCASE,
    username TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('member', 'admin')),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    is_online INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_name, username),
    FOREIGN KEY (server_name) REFERENCES servers(name) ON DELETE CASCADE,
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX idx_server_members_username ON server_members(username);
CREATE INDEX idx_server_members_server_name ON server_members(server_name);
CREATE INDEX idx_server_members_username_position ON server_members(username, position);

-- Channels table
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY NOT NULL,
    server_name TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_active INTEGER NOT NULL DEFAULT 1,
    message_count INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (server_name) REFERENCES servers(name) ON DELETE CASCADE
);

CREATE INDEX idx_channels_server_name ON channels(server_name);
CREATE INDEX idx_channels_position ON channels(position);
CREATE UNIQUE INDEX idx_channels_server_name_name ON channels(server_name, name);

-- Direct messages table
CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY NOT NULL,
    username1 TEXT NOT NULL,
    username2 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_message_at TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (username1) REFERENCES users(username) ON DELETE CASCADE,
    FOREIGN KEY (username2) REFERENCES users(username) ON DELETE CASCADE,
    CHECK (username1 <= username2)
);

CREATE INDEX idx_direct_messages_username1 ON direct_messages(username1);
CREATE INDEX idx_direct_messages_username2 ON direct_messages(username2);
CREATE UNIQUE INDEX idx_direct_messages_users ON direct_messages(username1, username2);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT,
    dm_id TEXT,
    sender_username TEXT NOT NULL,
    content TEXT NOT NULL,
    filtered_content TEXT,
    content_type TEXT NOT NULL CHECK(content_type IN ('text', 'markdown', 'file_attachment')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    edited_at TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    filter_status TEXT NOT NULL CHECK(filter_status IN ('clean', 'filtered', 'warning')),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (dm_id) REFERENCES direct_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_username) REFERENCES users(username) ON DELETE CASCADE,
    CHECK ((channel_id IS NOT NULL AND dm_id IS NULL) OR (channel_id IS NULL AND dm_id IS NOT NULL))
);

CREATE INDEX idx_messages_channel_id ON messages(channel_id);
CREATE INDEX idx_messages_dm_id ON messages(dm_id);
CREATE INDEX idx_messages_sender_username ON messages(sender_username);
CREATE INDEX idx_messages_created_at ON messages(created_at);

-- Files table
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY NOT NULL,
    original_name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    file_hash TEXT NOT NULL,
    upload_time TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    download_count INTEGER NOT NULL DEFAULT 0,
    uploader_username TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (uploader_username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX idx_files_hash ON files(file_hash);
CREATE INDEX idx_files_expires_at ON files(expires_at);
CREATE INDEX idx_files_uploader_username ON files(uploader_username);

-- File attachments table
CREATE TABLE IF NOT EXISTS file_attachments (
    file_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    caption TEXT,
    PRIMARY KEY (file_id, message_id),
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX idx_file_attachments_message_id ON file_attachments(message_id);

-- Login attempts table
CREATE TABLE IF NOT EXISTS login_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    success INTEGER NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    attempted_username TEXT,
    failure_reason TEXT,
    FOREIGN KEY (attempted_username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX idx_login_attempts_username ON login_attempts(username);
CREATE INDEX idx_login_attempts_ip_address ON login_attempts(ip_address);
CREATE INDEX idx_login_attempts_timestamp ON login_attempts(timestamp);

-- User sessions table
CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT,
    server_preferences TEXT,
    last_activity TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX idx_user_sessions_username ON user_sessions(username);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);

-- Server bans table
CREATE TABLE IF NOT EXISTS server_bans (
    server_name TEXT NOT NULL COLLATE NOCASE,
    username TEXT NOT NULL,
    banned_at TEXT NOT NULL DEFAULT (datetime('now')),
    banned_by TEXT NOT NULL,
    reason TEXT,
    PRIMARY KEY (server_name, username),
    FOREIGN KEY (server_name) REFERENCES servers(name) ON DELETE CASCADE,
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE INDEX idx_server_bans_server_name ON server_bans(server_name);
CREATE INDEX idx_server_bans_username ON server_bans(username);

-- Triggers to automatically update server member_count and channel_count

-- Increment member_count when a member joins
CREATE TRIGGER IF NOT EXISTS increment_member_count
AFTER INSERT ON server_members
BEGIN
    UPDATE servers
    SET member_count = member_count + 1
    WHERE name = NEW.server_name;
END;

-- Decrement member_count when a member leaves
CREATE TRIGGER IF NOT EXISTS decrement_member_count
AFTER DELETE ON server_members
BEGIN
    UPDATE servers
    SET member_count = member_count - 1
    WHERE name = OLD.server_name;
END;

-- Increment channel_count when a channel is created
CREATE TRIGGER IF NOT EXISTS increment_channel_count
AFTER INSERT ON channels
BEGIN
    UPDATE servers
    SET channel_count = channel_count + 1
    WHERE name = NEW.server_name;
END;

-- Decrement channel_count when a channel is deleted
CREATE TRIGGER IF NOT EXISTS decrement_channel_count
AFTER DELETE ON channels
BEGIN
    UPDATE servers
    SET channel_count = channel_count - 1
    WHERE name = OLD.server_name;
END;

-- Banned usernames table (Site-wide bans)
CREATE TABLE IF NOT EXISTS banned_usernames (
    username TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
    banned_at TEXT NOT NULL DEFAULT (datetime('now')),
    banned_by TEXT NOT NULL,
    reason TEXT
);

CREATE INDEX idx_banned_usernames_username ON banned_usernames(username);
