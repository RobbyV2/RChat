use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::any::{AnyPoolOptions, AnyRow, install_default_drivers};
use sqlx::{AnyConnection, AnyPool, Row};

pub type Db = AnyPool;

const SCHEMA_LOCK: i64 = 0x7263_6861_7400;

const SQLITE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  password_kind TEXT NOT NULL CHECK(password_kind IN ('text','words')),
  avatar_kind TEXT NOT NULL CHECK(avatar_kind IN ('identicon','color')), avatar_color TEXT, banner_color TEXT, bio TEXT,
  is_site_admin INTEGER NOT NULL DEFAULT 0, appear_offline INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, presence_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(username TEXT PRIMARY KEY, day TEXT NOT NULL, count INTEGER NOT NULL, last_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS change_attempts(session TEXT PRIMARY KEY, day TEXT NOT NULL, failures INTEGER NOT NULL, last_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS banned_usernames(username TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS pending_purges(kind TEXT NOT NULL, key TEXT NOT NULL, created_at INTEGER NOT NULL, claimed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind, key));
CREATE TABLE IF NOT EXISTS servers(name TEXT PRIMARY KEY, display_name TEXT NOT NULL, creator TEXT, password_hash TEXT, member_count INTEGER NOT NULL DEFAULT 0, banner_color TEXT, name_color TEXT, system_channel_id INTEGER, join_messages INTEGER NOT NULL DEFAULT 1, leave_messages INTEGER NOT NULL DEFAULT 1, layout_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channels(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','voice')), slowmode_seconds INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, restrict_view INTEGER NOT NULL DEFAULT 0, restrict_send INTEGER NOT NULL DEFAULT 0, topic TEXT, category_id INTEGER, position INTEGER NOT NULL DEFAULT 0, UNIQUE(server, name));
CREATE TABLE IF NOT EXISTS channel_categories(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS members(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, perms INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, joined_via INTEGER, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS roles(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, perms INTEGER NOT NULL DEFAULT 0, mentionable INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS user_roles(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(server, username, role_id));
CREATE TABLE IF NOT EXISTS channel_perms(channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, subject TEXT NOT NULL, can_view INTEGER NOT NULL DEFAULT 1, can_send INTEGER NOT NULL DEFAULT 1, can_read_history INTEGER NOT NULL DEFAULT 1, restrict_set INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(channel_id, subject));
CREATE TABLE IF NOT EXISTS dms(id INTEGER PRIMARY KEY AUTOINCREMENT, user_a TEXT NOT NULL, user_b TEXT NOT NULL, last_message_id INTEGER NOT NULL DEFAULT 0, closed_a INTEGER NOT NULL DEFAULT 0, closed_b INTEGER NOT NULL DEFAULT 0, UNIQUE(user_a, user_b));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, dm_id INTEGER REFERENCES dms(id) ON DELETE CASCADE, thread_root_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, author TEXT NOT NULL, content TEXT NOT NULL, media_id TEXT, media_filename TEXT, media_removed INTEGER NOT NULL DEFAULT 0, media_spoiler INTEGER NOT NULL DEFAULT 0, media_kind TEXT NOT NULL DEFAULT 'server' CHECK(media_kind IN ('server','p2p')), media_hoster TEXT, media_expires_at INTEGER, media_size INTEGER, media_mime TEXT, media_sha256 TEXT, kind TEXT NOT NULL DEFAULT 'user', call_answered_at INTEGER, call_ended_at INTEGER, call_outcome TEXT, call_kind TEXT, call_video INTEGER, reply_to INTEGER, reply_mention INTEGER NOT NULL DEFAULT 0, edited_at INTEGER, fwd_author TEXT, fwd_created_at INTEGER, fwd_source_id INTEGER, fwd_origin TEXT, fwd_dropped TEXT, pinned_at INTEGER, pinned_by TEXT, pin_message_id INTEGER, group_mentions TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB, uploader TEXT, uploaded_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media_chunks(media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(media_id, seq));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embeds(url TEXT PRIMARY KEY, site_name TEXT, title TEXT, description TEXT, image_url TEXT, fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS message_embeds(message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, ord INTEGER NOT NULL, url TEXT NOT NULL, banner_removed INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(message_id, ord));
CREATE TABLE IF NOT EXISTS interactions(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS guest_grants(\"grant\" TEXT PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL DEFAULT 0, password_id INTEGER, network TEXT);
CREATE TABLE IF NOT EXISTS server_passwords(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, label TEXT, hash TEXT NOT NULL, lookup TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER, used_up_at INTEGER, UNIQUE(server, lookup));
CREATE TABLE IF NOT EXISTS read_state(username TEXT NOT NULL, scope TEXT NOT NULL, last_read INTEGER NOT NULL, PRIMARY KEY(username, scope));
CREATE TABLE IF NOT EXISTS server_bans(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, banned_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS pings(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('mention','reply','reaction')), scope TEXT NOT NULL, server TEXT REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, thread_root_id INTEGER, actor TEXT NOT NULL, emoji TEXT, created_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reactions(message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, username TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(message_id, username, emoji));
CREATE TABLE IF NOT EXISTS config_shares(id TEXT PRIMARY KEY, owner TEXT NOT NULL, blob TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_pings(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('everyone','here','role')), role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE, actor TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS here_pings(ping_id INTEGER NOT NULL REFERENCES group_pings(id) ON DELETE CASCADE, username TEXT NOT NULL, PRIMARY KEY(username, ping_id));
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, actor TEXT, staff INTEGER NOT NULL DEFAULT 0, action TEXT NOT NULL, target_kind TEXT, target_id INTEGER, target_name TEXT, target_staff INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_channels(entry_id INTEGER NOT NULL REFERENCES audit_log(id) ON DELETE CASCADE, channel_id INTEGER NOT NULL, private INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(entry_id, channel_id));
CREATE TABLE IF NOT EXISTS member_timeouts(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, until INTEGER NOT NULL, reason TEXT, set_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS blocks(blocker TEXT NOT NULL, blocked TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(blocker, blocked));
CREATE TABLE IF NOT EXISTS friends(username TEXT NOT NULL, friend TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(username, friend));
CREATE TABLE IF NOT EXISTS friend_requests(sender TEXT NOT NULL, recipient TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(sender, recipient));
CREATE TABLE IF NOT EXISTS friend_pings(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('friend_request','friend_accept')), actor TEXT NOT NULL, created_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS privacy(username TEXT PRIMARY KEY, dms TEXT NOT NULL DEFAULT 'everyone' CHECK(dms IN ('everyone','friends')), friend_requests TEXT NOT NULL DEFAULT 'everyone' CHECK(friend_requests IN ('everyone','servers','nobody')));
CREATE TABLE IF NOT EXISTS polls(message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('single','multiple','ranked','rating','yes_no')), question TEXT NOT NULL, anonymous INTEGER NOT NULL DEFAULT 0, results TEXT NOT NULL DEFAULT 'always' CHECK(results IN ('always','after_vote','after_close')), allow_change INTEGER NOT NULL DEFAULT 1, allow_add INTEGER NOT NULL DEFAULT 0, min_choices INTEGER NOT NULL DEFAULT 1, max_choices INTEGER NOT NULL DEFAULT 1, scale INTEGER, closes_at INTEGER, closed_at INTEGER, closed_by TEXT, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS poll_options(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, position INTEGER NOT NULL, text TEXT NOT NULL, emoji TEXT, added_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS poll_votes(message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, voter TEXT NOT NULL, option_id INTEGER NOT NULL, value INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(message_id, voter, option_id));
CREATE TABLE IF NOT EXISTS poll_snapshots(message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_members_username ON members(username);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_dm_id ON messages(dm_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author);
CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages(thread_root_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_top ON messages(channel_id, id) WHERE thread_root_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_dms_user_b ON dms(user_b);
CREATE INDEX IF NOT EXISTS idx_media_uploaded_at ON media(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_messages_media ON messages(media_id) WHERE media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_channel_author ON messages(channel_id, author, id);
CREATE INDEX IF NOT EXISTS idx_message_embeds_url ON message_embeds(url);
CREATE INDEX IF NOT EXISTS idx_user_roles_username ON user_roles(username);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server, id);
CREATE INDEX IF NOT EXISTS idx_tokens_username ON tokens(username);
CREATE INDEX IF NOT EXISTS idx_guest_grants_server ON guest_grants(server);
CREATE INDEX IF NOT EXISTS idx_guest_grants_used ON guest_grants(last_used_at);
CREATE INDEX IF NOT EXISTS idx_guest_grants_password ON guest_grants(password_id) WHERE password_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_server_passwords_server ON server_passwords(server, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_last ON login_attempts(last_at);
CREATE INDEX IF NOT EXISTS idx_change_attempts_last ON change_attempts(last_at);
CREATE INDEX IF NOT EXISTS idx_users_purging ON users(username) WHERE password_hash = '!purging';
CREATE INDEX IF NOT EXISTS idx_embeds_fetched ON embeds(fetched_at);
CREATE INDEX IF NOT EXISTS idx_channel_perms_subject ON channel_perms(subject);
CREATE INDEX IF NOT EXISTS idx_interactions_username ON interactions(username);
CREATE INDEX IF NOT EXISTS idx_interactions_recent ON interactions(server, last_at, username);
CREATE INDEX IF NOT EXISTS idx_server_bans_recent ON server_bans(server, created_at, username);
CREATE INDEX IF NOT EXISTS idx_members_user_joined ON members(username, joined_at, server);
CREATE INDEX IF NOT EXISTS idx_servers_creator ON servers(creator, name);
CREATE INDEX IF NOT EXISTS idx_dms_a_latest ON dms(user_a, last_message_id, id);
CREATE INDEX IF NOT EXISTS idx_dms_b_latest ON dms(user_b, last_message_id, id);
CREATE INDEX IF NOT EXISTS idx_members_admins ON members(server, username) WHERE is_admin <> 0;
CREATE INDEX IF NOT EXISTS idx_pings_user ON pings(username, seen, id);
CREATE INDEX IF NOT EXISTS idx_pings_message ON pings(message_id);
CREATE INDEX IF NOT EXISTS idx_pings_created ON pings(created_at);
CREATE INDEX IF NOT EXISTS idx_pings_seen ON pings(id) WHERE seen <> 0;
CREATE INDEX IF NOT EXISTS idx_pings_actor ON pings(actor);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, emoji, created_at);
CREATE INDEX IF NOT EXISTS idx_reactions_username ON reactions(username);
CREATE INDEX IF NOT EXISTS idx_messages_fwd_author ON messages(fwd_author) WHERE fwd_author IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_channel_pins ON messages(channel_id, pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_dm_pins ON messages(dm_id, pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_system ON messages(author, kind, created_at) WHERE kind IN ('join','leave');
CREATE INDEX IF NOT EXISTS idx_config_shares_owner ON config_shares(owner, expires_at);
CREATE INDEX IF NOT EXISTS idx_config_shares_expires ON config_shares(expires_at);
CREATE INDEX IF NOT EXISTS idx_channel_categories_server ON channel_categories(server, position);
CREATE INDEX IF NOT EXISTS idx_group_pings_channel ON group_pings(channel_id, message_id);
CREATE INDEX IF NOT EXISTS idx_group_pings_message ON group_pings(message_id);
CREATE INDEX IF NOT EXISTS idx_group_pings_created ON group_pings(created_at);
CREATE INDEX IF NOT EXISTS idx_group_pings_role ON group_pings(role_id) WHERE role_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_here_pings_ping ON here_pings(ping_id);
CREATE INDEX IF NOT EXISTS idx_group_pings_server ON group_pings(server);
CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log(server, created_at, id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(server, action, created_at, id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(server, actor, created_at, id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_member_timeouts_until ON member_timeouts(until);
CREATE INDEX IF NOT EXISTS idx_blocks_recent ON blocks(blocker, created_at, blocked);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked);
CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend);
CREATE INDEX IF NOT EXISTS idx_friend_requests_in ON friend_requests(recipient, created_at, sender);
CREATE INDEX IF NOT EXISTS idx_friend_requests_out ON friend_requests(sender, created_at, recipient);
CREATE INDEX IF NOT EXISTS idx_friend_pings_user ON friend_pings(username, seen, id);
CREATE INDEX IF NOT EXISTS idx_polls_due ON polls(closes_at) WHERE closed_at IS NULL AND closes_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_poll_options_message ON poll_options(message_id, position);
CREATE INDEX IF NOT EXISTS idx_poll_votes_option ON poll_votes(message_id, option_id, created_at, voter);
CREATE INDEX IF NOT EXISTS idx_poll_votes_voter ON poll_votes(voter);
";

const POSTGRES_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  password_kind TEXT NOT NULL CHECK(password_kind IN ('text','words')),
  avatar_kind TEXT NOT NULL CHECK(avatar_kind IN ('identicon','color')), avatar_color TEXT, banner_color TEXT, bio TEXT,
  is_site_admin BIGINT NOT NULL DEFAULT 0, appear_offline BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, presence_seq BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(username TEXT PRIMARY KEY, day TEXT NOT NULL, count BIGINT NOT NULL, last_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS change_attempts(session TEXT PRIMARY KEY, day TEXT NOT NULL, failures BIGINT NOT NULL, last_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS banned_usernames(username TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS pending_purges(kind TEXT NOT NULL, key TEXT NOT NULL, created_at BIGINT NOT NULL, claimed_at BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(kind, key));
CREATE TABLE IF NOT EXISTS servers(name TEXT PRIMARY KEY, display_name TEXT NOT NULL, creator TEXT, password_hash TEXT, member_count BIGINT NOT NULL DEFAULT 0, banner_color TEXT, name_color TEXT, system_channel_id BIGINT, join_messages BIGINT NOT NULL DEFAULT 1, leave_messages BIGINT NOT NULL DEFAULT 1, layout_version BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS channels(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','voice')), slowmode_seconds BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, restrict_view BIGINT NOT NULL DEFAULT 0, restrict_send BIGINT NOT NULL DEFAULT 0, topic TEXT, category_id BIGINT, position BIGINT NOT NULL DEFAULT 0, UNIQUE(server, name));
CREATE TABLE IF NOT EXISTS channel_categories(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, position BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS members(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, is_admin BIGINT NOT NULL DEFAULT 0, perms BIGINT NOT NULL DEFAULT 0, joined_at BIGINT NOT NULL, joined_via BIGINT, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS roles(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, perms BIGINT NOT NULL DEFAULT 0, mentionable BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS user_roles(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(server, username, role_id));
CREATE TABLE IF NOT EXISTS channel_perms(channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, subject TEXT NOT NULL, can_view BIGINT NOT NULL DEFAULT 1, can_send BIGINT NOT NULL DEFAULT 1, can_read_history BIGINT NOT NULL DEFAULT 1, restrict_set BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(channel_id, subject));
CREATE TABLE IF NOT EXISTS dms(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, last_message_id BIGINT NOT NULL DEFAULT 0, closed_a BIGINT NOT NULL DEFAULT 0, closed_b BIGINT NOT NULL DEFAULT 0, UNIQUE(user_a, user_b));
CREATE TABLE IF NOT EXISTS messages(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, channel_id BIGINT REFERENCES channels(id) ON DELETE CASCADE, dm_id BIGINT REFERENCES dms(id) ON DELETE CASCADE, thread_root_id BIGINT REFERENCES messages(id) ON DELETE CASCADE, author TEXT NOT NULL, content TEXT NOT NULL, media_id TEXT, media_filename TEXT, media_removed BIGINT NOT NULL DEFAULT 0, media_spoiler BIGINT NOT NULL DEFAULT 0, media_kind TEXT NOT NULL DEFAULT 'server' CHECK(media_kind IN ('server','p2p')), media_hoster TEXT, media_expires_at BIGINT, media_size BIGINT, media_mime TEXT, media_sha256 TEXT, kind TEXT NOT NULL DEFAULT 'user', call_answered_at BIGINT, call_ended_at BIGINT, call_outcome TEXT, call_kind TEXT, call_video BIGINT, reply_to BIGINT, reply_mention BIGINT NOT NULL DEFAULT 0, edited_at BIGINT, fwd_author TEXT, fwd_created_at BIGINT, fwd_source_id BIGINT, fwd_origin TEXT, fwd_dropped TEXT, pinned_at BIGINT, pinned_by TEXT, pin_message_id BIGINT, group_mentions TEXT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, data BYTEA, uploader TEXT, uploaded_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS media_chunks(media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, seq BIGINT NOT NULL, data BYTEA NOT NULL, PRIMARY KEY(media_id, seq));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embeds(url TEXT PRIMARY KEY, site_name TEXT, title TEXT, description TEXT, image_url TEXT, fetched_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS message_embeds(message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, ord BIGINT NOT NULL, url TEXT NOT NULL, banner_removed BIGINT NOT NULL DEFAULT 0, removed BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(message_id, ord));
CREATE TABLE IF NOT EXISTS interactions(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, last_at BIGINT NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS guest_grants(\"grant\" TEXT PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, created_at BIGINT NOT NULL, last_used_at BIGINT NOT NULL DEFAULT 0, password_id BIGINT, network TEXT);
CREATE TABLE IF NOT EXISTS server_passwords(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, label TEXT, hash TEXT NOT NULL, lookup TEXT NOT NULL, created_by TEXT, created_at BIGINT NOT NULL, expires_at BIGINT, max_uses BIGINT, uses BIGINT NOT NULL DEFAULT 0, revoked_at BIGINT, used_up_at BIGINT, UNIQUE(server, lookup));
CREATE TABLE IF NOT EXISTS read_state(username TEXT NOT NULL, scope TEXT NOT NULL, last_read BIGINT NOT NULL, PRIMARY KEY(username, scope));
CREATE TABLE IF NOT EXISTS server_bans(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, banned_by TEXT, created_at BIGINT NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS pings(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, username TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('mention','reply','reaction')), scope TEXT NOT NULL, server TEXT REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, thread_root_id BIGINT, actor TEXT NOT NULL, emoji TEXT, created_at BIGINT NOT NULL, seen BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reactions(message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, username TEXT NOT NULL, emoji TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(message_id, username, emoji));
CREATE TABLE IF NOT EXISTS config_shares(id TEXT PRIMARY KEY, owner TEXT NOT NULL, blob TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS group_pings(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('everyone','here','role')), role_id BIGINT REFERENCES roles(id) ON DELETE CASCADE, actor TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS here_pings(ping_id BIGINT NOT NULL REFERENCES group_pings(id) ON DELETE CASCADE, username TEXT NOT NULL, PRIMARY KEY(username, ping_id));
CREATE TABLE IF NOT EXISTS audit_log(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, actor TEXT, staff BIGINT NOT NULL DEFAULT 0, action TEXT NOT NULL, target_kind TEXT, target_id BIGINT, target_name TEXT, target_staff BIGINT NOT NULL DEFAULT 0, details TEXT NOT NULL DEFAULT '{}', created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_channels(entry_id BIGINT NOT NULL REFERENCES audit_log(id) ON DELETE CASCADE, channel_id BIGINT NOT NULL, private BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(entry_id, channel_id));
CREATE TABLE IF NOT EXISTS member_timeouts(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, until BIGINT NOT NULL, reason TEXT, set_by TEXT, created_at BIGINT NOT NULL, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS blocks(blocker TEXT NOT NULL, blocked TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(blocker, blocked));
CREATE TABLE IF NOT EXISTS friends(username TEXT NOT NULL, friend TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(username, friend));
CREATE TABLE IF NOT EXISTS friend_requests(sender TEXT NOT NULL, recipient TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(sender, recipient));
CREATE TABLE IF NOT EXISTS friend_pings(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, username TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('friend_request','friend_accept')), actor TEXT NOT NULL, created_at BIGINT NOT NULL, seen BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS privacy(username TEXT PRIMARY KEY, dms TEXT NOT NULL DEFAULT 'everyone' CHECK(dms IN ('everyone','friends')), friend_requests TEXT NOT NULL DEFAULT 'everyone' CHECK(friend_requests IN ('everyone','servers','nobody')));
CREATE TABLE IF NOT EXISTS polls(message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('single','multiple','ranked','rating','yes_no')), question TEXT NOT NULL, anonymous BIGINT NOT NULL DEFAULT 0, results TEXT NOT NULL DEFAULT 'always' CHECK(results IN ('always','after_vote','after_close')), allow_change BIGINT NOT NULL DEFAULT 1, allow_add BIGINT NOT NULL DEFAULT 0, min_choices BIGINT NOT NULL DEFAULT 1, max_choices BIGINT NOT NULL DEFAULT 1, scale BIGINT, closes_at BIGINT, closed_at BIGINT, closed_by TEXT, created_at BIGINT NOT NULL, version BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS poll_options(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, position BIGINT NOT NULL, text TEXT NOT NULL, emoji TEXT, added_by TEXT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS poll_votes(message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, voter TEXT NOT NULL, option_id BIGINT NOT NULL, value BIGINT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(message_id, voter, option_id));
CREATE TABLE IF NOT EXISTS poll_snapshots(message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_members_username ON members(username);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_dm_id ON messages(dm_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author);
CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages(thread_root_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_top ON messages(channel_id, id) WHERE thread_root_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_dms_user_b ON dms(user_b);
CREATE INDEX IF NOT EXISTS idx_media_uploaded_at ON media(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_messages_media ON messages(media_id) WHERE media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_channel_author ON messages(channel_id, author, id);
CREATE INDEX IF NOT EXISTS idx_message_embeds_url ON message_embeds(url);
CREATE INDEX IF NOT EXISTS idx_user_roles_username ON user_roles(username);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server, id);
CREATE INDEX IF NOT EXISTS idx_tokens_username ON tokens(username);
CREATE INDEX IF NOT EXISTS idx_guest_grants_server ON guest_grants(server);
CREATE INDEX IF NOT EXISTS idx_guest_grants_used ON guest_grants(last_used_at);
CREATE INDEX IF NOT EXISTS idx_guest_grants_password ON guest_grants(password_id) WHERE password_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_server_passwords_server ON server_passwords(server, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_last ON login_attempts(last_at);
CREATE INDEX IF NOT EXISTS idx_change_attempts_last ON change_attempts(last_at);
CREATE INDEX IF NOT EXISTS idx_users_purging ON users(username) WHERE password_hash = '!purging';
CREATE INDEX IF NOT EXISTS idx_embeds_fetched ON embeds(fetched_at);
CREATE INDEX IF NOT EXISTS idx_channel_perms_subject ON channel_perms(subject);
CREATE INDEX IF NOT EXISTS idx_interactions_username ON interactions(username);
CREATE INDEX IF NOT EXISTS idx_interactions_recent ON interactions(server, last_at, username);
CREATE INDEX IF NOT EXISTS idx_server_bans_recent ON server_bans(server, created_at, username);
CREATE INDEX IF NOT EXISTS idx_members_user_joined ON members(username, joined_at, server);
CREATE INDEX IF NOT EXISTS idx_servers_creator ON servers(creator, name);
CREATE INDEX IF NOT EXISTS idx_dms_a_latest ON dms(user_a, last_message_id, id);
CREATE INDEX IF NOT EXISTS idx_dms_b_latest ON dms(user_b, last_message_id, id);
CREATE INDEX IF NOT EXISTS idx_members_name_c ON members(server, (username COLLATE \"C\"));
CREATE INDEX IF NOT EXISTS idx_members_admins_c ON members(server, (username COLLATE \"C\")) WHERE is_admin <> 0;
CREATE INDEX IF NOT EXISTS idx_pings_user ON pings(username, seen, id);
CREATE INDEX IF NOT EXISTS idx_pings_message ON pings(message_id);
CREATE INDEX IF NOT EXISTS idx_pings_created ON pings(created_at);
CREATE INDEX IF NOT EXISTS idx_pings_seen ON pings(id) WHERE seen <> 0;
CREATE INDEX IF NOT EXISTS idx_pings_actor ON pings(actor);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, emoji, created_at);
CREATE INDEX IF NOT EXISTS idx_reactions_username ON reactions(username);
CREATE INDEX IF NOT EXISTS idx_messages_fwd_author ON messages(fwd_author) WHERE fwd_author IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_channel_pins ON messages(channel_id, pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_dm_pins ON messages(dm_id, pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_system ON messages(author, kind, created_at) WHERE kind IN ('join','leave');
CREATE INDEX IF NOT EXISTS idx_config_shares_owner ON config_shares(owner, expires_at);
CREATE INDEX IF NOT EXISTS idx_config_shares_expires ON config_shares(expires_at);
CREATE INDEX IF NOT EXISTS idx_channel_categories_server ON channel_categories(server, position);
CREATE INDEX IF NOT EXISTS idx_group_pings_channel ON group_pings(channel_id, message_id);
CREATE INDEX IF NOT EXISTS idx_group_pings_message ON group_pings(message_id);
CREATE INDEX IF NOT EXISTS idx_group_pings_created ON group_pings(created_at);
CREATE INDEX IF NOT EXISTS idx_group_pings_role ON group_pings(role_id) WHERE role_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_here_pings_ping ON here_pings(ping_id);
CREATE INDEX IF NOT EXISTS idx_group_pings_server ON group_pings(server);
CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log(server, created_at, id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(server, action, created_at, id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(server, actor, created_at, id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_member_timeouts_until ON member_timeouts(until);
CREATE INDEX IF NOT EXISTS idx_blocks_recent ON blocks(blocker, created_at, blocked);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked);
CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend);
CREATE INDEX IF NOT EXISTS idx_friend_requests_in ON friend_requests(recipient, created_at, sender);
CREATE INDEX IF NOT EXISTS idx_friend_requests_out ON friend_requests(sender, created_at, recipient);
CREATE INDEX IF NOT EXISTS idx_friend_pings_user ON friend_pings(username, seen, id);
CREATE INDEX IF NOT EXISTS idx_polls_due ON polls(closes_at) WHERE closed_at IS NULL AND closes_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_poll_options_message ON poll_options(message_id, position);
CREATE INDEX IF NOT EXISTS idx_poll_votes_option ON poll_votes(message_id, option_id, created_at, voter);
CREATE INDEX IF NOT EXISTS idx_poll_votes_voter ON poll_votes(voter);
";

const SQLITE_SEARCH: &[&str] = &[
    "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id', tokenize='trigram')",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content) VALUES(new.id, new.content); END",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content); END",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content); INSERT INTO messages_fts(rowid, content) VALUES(new.id, new.content); END",
];

const POSTGRES_SEARCH: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_messages_content_trgm ON messages USING gin (lower(content) gin_trgm_ops)",
    "CREATE INDEX IF NOT EXISTS idx_users_username_trgm ON users USING gin (lower(username) gin_trgm_ops)",
    "CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm ON users USING gin (lower(display_name) gin_trgm_ops)",
    "CREATE INDEX IF NOT EXISTS idx_servers_name_trgm ON servers USING gin (lower(name) gin_trgm_ops)",
    "CREATE INDEX IF NOT EXISTS idx_servers_display_name_trgm ON servers USING gin (lower(display_name) gin_trgm_ops)",
];

const SQLITE_TRIGGERS: &[&str] = &[
    "CREATE TRIGGER IF NOT EXISTS messages_dm_latest_insert AFTER INSERT ON messages WHEN new.dm_id IS NOT NULL BEGIN UPDATE dms SET last_message_id = new.id WHERE id = new.dm_id AND last_message_id < new.id; END",
    "CREATE TRIGGER IF NOT EXISTS messages_dm_latest_delete AFTER DELETE ON messages WHEN old.dm_id IS NOT NULL BEGIN UPDATE dms SET last_message_id = COALESCE((SELECT MAX(id) FROM messages WHERE dm_id = old.dm_id), 0) WHERE id = old.dm_id AND last_message_id = old.id; END",
    "CREATE TRIGGER IF NOT EXISTS members_count_insert AFTER INSERT ON members BEGIN UPDATE servers SET member_count = member_count + 1 WHERE name = new.server; END",
    "CREATE TRIGGER IF NOT EXISTS members_count_delete AFTER DELETE ON members BEGIN UPDATE servers SET member_count = member_count - 1 WHERE name = old.server; END",
];

const POSTGRES_TRIGGERS: &[&str] = &[
    "CREATE OR REPLACE FUNCTION rchat_dm_latest_insert() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE dms SET last_message_id = NEW.id WHERE id = NEW.dm_id AND last_message_id < NEW.id; RETURN NULL; END $f$",
    "CREATE OR REPLACE FUNCTION rchat_dm_latest_delete() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE dms SET last_message_id = COALESCE((SELECT MAX(id) FROM messages WHERE dm_id = OLD.dm_id), 0) WHERE id = OLD.dm_id AND last_message_id = OLD.id; RETURN NULL; END $f$",
    "CREATE OR REPLACE FUNCTION rchat_members_count_insert() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE servers SET member_count = member_count + 1 WHERE name = NEW.server; RETURN NULL; END $f$",
    "CREATE OR REPLACE FUNCTION rchat_members_count_delete() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE servers SET member_count = member_count - 1 WHERE name = OLD.server; RETURN NULL; END $f$",
    "DROP TRIGGER IF EXISTS messages_dm_latest_insert ON messages",
    "CREATE TRIGGER messages_dm_latest_insert AFTER INSERT ON messages FOR EACH ROW WHEN (NEW.dm_id IS NOT NULL) EXECUTE FUNCTION rchat_dm_latest_insert()",
    "DROP TRIGGER IF EXISTS messages_dm_latest_delete ON messages",
    "CREATE TRIGGER messages_dm_latest_delete AFTER DELETE ON messages FOR EACH ROW WHEN (OLD.dm_id IS NOT NULL) EXECUTE FUNCTION rchat_dm_latest_delete()",
    "DROP TRIGGER IF EXISTS members_count_insert ON members",
    "CREATE TRIGGER members_count_insert AFTER INSERT ON members FOR EACH ROW EXECUTE FUNCTION rchat_members_count_insert()",
    "DROP TRIGGER IF EXISTS members_count_delete ON members",
    "CREATE TRIGGER members_count_delete AFTER DELETE ON members FOR EACH ROW EXECUTE FUNCTION rchat_members_count_delete()",
];

static FTS_READY: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
static READERS: LazyLock<Mutex<HashMap<String, Db>>> = LazyLock::new(Default::default);
static PEPPERS: LazyLock<Mutex<HashMap<String, Vec<u8>>>> = LazyLock::new(Default::default);

/// A secret from the environment: `NAME`, or the contents of the file named by `NAME_FILE`.
/// Blank values count as unset.
pub fn env_secret(name: &str) -> Option<String> {
    let direct = std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let file = std::env::var(format!("{name}_FILE"))
        .ok()
        .filter(|p| !p.trim().is_empty())
        .and_then(|p| match std::fs::read_to_string(p.trim()) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::error!("{name}_FILE can not be read: {e}");
                None
            }
        });
    direct
        .or(file)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The pepper of server password lookups: `PASSWORD_PEPPER` when it is set, else the value
/// stored in the database at first start.
pub async fn pepper(db: &Db) -> sqlx::Result<Vec<u8>> {
    let key = pool_key(db);
    if let Some(pepper) = PEPPERS.lock().ok().and_then(|m| m.get(&key).cloned()) {
        return Ok(pepper);
    }
    let value: String = match env_secret("PASSWORD_PEPPER") {
        Some(value) => value,
        None => sqlx::query("SELECT value FROM settings WHERE key = 'password_pepper'")
            .fetch_one(db)
            .await?
            .try_get(0)?,
    };
    let pepper = value.into_bytes();
    if let Ok(mut peppers) = PEPPERS.lock() {
        peppers.insert(key, pepper.clone());
    }
    Ok(pepper)
}

/// Stored form of a bearer secret (session token or guest grant): `h:` and the hex SHA-256.
/// The database never holds the secret itself.
pub fn secret_key(raw: &str) -> String {
    format!("h:{}", hex::encode(Sha256::digest(raw.as_bytes())))
}

pub fn reader(db: &Db) -> Db {
    READERS
        .lock()
        .ok()
        .and_then(|readers| readers.get(&pool_key(db)).cloned())
        .unwrap_or_else(|| db.clone())
}

pub async fn close(db: &Db) {
    if let Ok(mut peppers) = PEPPERS.lock() {
        peppers.remove(&pool_key(db));
    }
    let read = READERS
        .lock()
        .ok()
        .and_then(|mut readers| readers.remove(&pool_key(db)));
    if let Some(read) = read {
        read.close().await;
    }
    db.close().await;
}

pub(crate) fn pool_key(db: &Db) -> String {
    db.connect_options().database_url.to_string()
}

pub fn is_sqlite(db: &Db) -> bool {
    db.connect_options()
        .database_url
        .scheme()
        .starts_with("sqlite")
}

pub fn has_fts(db: &Db) -> bool {
    FTS_READY
        .lock()
        .is_ok_and(|ready| ready.contains(&pool_key(db)))
}

pub(crate) fn set_fts(db: &Db, ready: bool) {
    if let Ok(mut set) = FTS_READY.lock() {
        match ready {
            true => {
                set.insert(pool_key(db));
            }
            false => {
                set.remove(&pool_key(db));
            }
        }
    }
}

async fn probe_fts(db: &Db) -> bool {
    is_sqlite(db)
        && sqlx::query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
            .fetch_optional(db)
            .await
            .is_ok_and(|r| r.is_some())
}

async fn sqlite_search_index(pool: &Db) -> anyhow::Result<()> {
    let existed = probe_fts(pool).await;
    let mut tx = pool.begin().await?;
    for stmt in SQLITE_SEARCH {
        sqlx::query(*stmt).execute(&mut *tx).await?;
    }
    if !existed {
        sqlx::query("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    if !existed {
        tracing::info!("built message search index");
    }
    Ok(())
}

async fn guarded(conn: &mut AnyConnection, stmt: &'static str) -> Result<(), sqlx::Error> {
    let mut savepoint = sqlx::Connection::begin(&mut *conn).await?;
    sqlx::query(stmt).execute(&mut *savepoint).await?;
    savepoint.commit().await
}

async fn postgres_search_index(conn: &mut AnyConnection) {
    if let Err(e) = guarded(conn, "CREATE EXTENSION IF NOT EXISTS pg_trgm").await {
        tracing::warn!("pg_trgm unavailable, search falls back to unindexed LIKE: {e}");
        return;
    }
    for stmt in POSTGRES_SEARCH {
        if let Err(e) = guarded(conn, stmt).await {
            tracing::warn!("search index not created: {e}");
        }
    }
}

const MIGRATIONS: &[(&str, &str)] = &[
    ("servers", "password_hash TEXT"),
    ("members", "perms {INT} NOT NULL DEFAULT 0"),
    (
        "channels",
        "kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','voice'))",
    ),
    ("channels", "slowmode_seconds {INT} NOT NULL DEFAULT 0"),
    ("messages", "media_spoiler {INT} NOT NULL DEFAULT 0"),
    (
        "messages",
        "media_kind TEXT NOT NULL DEFAULT 'server' CHECK(media_kind IN ('server','p2p'))",
    ),
    ("messages", "media_hoster TEXT"),
    ("messages", "media_expires_at {INT}"),
    ("messages", "media_size {INT}"),
    ("messages", "media_mime TEXT"),
    ("messages", "kind TEXT NOT NULL DEFAULT 'user'"),
    ("messages", "call_answered_at {INT}"),
    ("messages", "call_ended_at {INT}"),
    ("messages", "call_outcome TEXT"),
    ("users", "appear_offline {INT} NOT NULL DEFAULT 0"),
    ("users", "banner_color TEXT"),
    ("users", "bio TEXT"),
    ("media", "uploader TEXT"),
    ("dms", "last_message_id {INT} NOT NULL DEFAULT 0"),
    ("servers", "member_count {INT} NOT NULL DEFAULT 0"),
    ("servers", "banner_color TEXT"),
    ("servers", "name_color TEXT"),
    ("guest_grants", "last_used_at {INT} NOT NULL DEFAULT 0"),
    ("members", "joined_via {INT}"),
    ("pings", "thread_root_id {INT}"),
    ("guest_grants", "password_id {INT}"),
    ("messages", "reply_to {INT}"),
    ("messages", "reply_mention {INT} NOT NULL DEFAULT 0"),
    ("messages", "edited_at {INT}"),
    ("messages", "fwd_author TEXT"),
    ("messages", "fwd_created_at {INT}"),
    ("messages", "fwd_source_id {INT}"),
    ("messages", "fwd_origin TEXT"),
    ("messages", "fwd_dropped TEXT"),
    ("messages", "pinned_at {INT}"),
    ("messages", "pinned_by TEXT"),
    ("messages", "pin_message_id {INT}"),
    ("servers", "system_channel_id {INT}"),
    ("servers", "join_messages {INT} NOT NULL DEFAULT 1"),
    ("servers", "leave_messages {INT} NOT NULL DEFAULT 1"),
    ("channels", "restrict_view {INT} NOT NULL DEFAULT 0"),
    ("channels", "restrict_send {INT} NOT NULL DEFAULT 0"),
    ("messages", "media_sha256 TEXT"),
    ("channel_perms", "restrict_set {INT} NOT NULL DEFAULT 0"),
    ("guest_grants", "network TEXT"),
    ("messages", "call_kind TEXT"),
    ("messages", "call_video {INT}"),
    ("channels", "topic TEXT"),
    ("channels", "category_id {INT}"),
    ("channels", "position {INT} NOT NULL DEFAULT 0"),
    ("servers", "layout_version {INT} NOT NULL DEFAULT 0"),
    ("roles", "mentionable {INT} NOT NULL DEFAULT 0"),
    ("messages", "group_mentions TEXT"),
    ("audit_log", "actor TEXT"),
    ("audit_log", "staff {INT} NOT NULL DEFAULT 0"),
    ("audit_log", "target_kind TEXT"),
    ("audit_log", "target_id {INT}"),
    ("audit_log", "target_name TEXT"),
    ("audit_log", "target_staff {INT} NOT NULL DEFAULT 0"),
    ("audit_log", "details TEXT NOT NULL DEFAULT '{}'"),
    ("users", "presence_seq {INT} NOT NULL DEFAULT 0"),
    ("dms", "closed_a {INT} NOT NULL DEFAULT 0"),
    ("dms", "closed_b {INT} NOT NULL DEFAULT 0"),
    ("polls", "version {INT} NOT NULL DEFAULT 0"),
];

const BACKFILLS: &[(&str, &str, &str)] = &[
    (
        "dms",
        "last_message_id",
        "UPDATE dms SET last_message_id = COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.dm_id = dms.id), 0)",
    ),
    (
        "servers",
        "member_count",
        "UPDATE servers SET member_count = (SELECT COUNT(*) FROM members m WHERE m.server = servers.name)",
    ),
    (
        "guest_grants",
        "last_used_at",
        "UPDATE guest_grants SET last_used_at = $1",
    ),
    (
        "channel_perms",
        "restrict_set",
        "UPDATE channel_perms SET restrict_set = 1 WHERE EXISTS(SELECT 1 FROM settings WHERE key = 'restrict_backfill_v1')",
    ),
    (
        "channels",
        "position",
        "UPDATE channels SET position = (SELECT COUNT(*) FROM channels c WHERE c.server = channels.server AND ((c.kind = 'text' AND channels.kind <> 'text') OR (c.kind = channels.kind AND c.id < channels.id)))",
    ),
];

const RESTRICT_BACKFILL: &str = "restrict_backfill_v1";

/// The newest schema this binary knows. Raise it with every schema change (new tables, columns,
/// indexes or data conversions), or older binaries of this line keep starting on a database they
/// do not understand. A database marked with a newer version was upgraded by a newer binary,
/// and this one refuses to start on it.
/// 1: hashed secrets and the 0.3.0 indexes. 2: `channel_perms.restrict_set` and
/// `guest_grants.network`. 3: channel categories and channel positions. 4: group mentions
/// (`group_pings`, `here_pings`, `roles.mentionable`, `messages.group_mentions`) and the Mention
/// everyone permission bit. 5: the audit log (`audit_log`) and the View audit log permission bit.
/// 6: `users.presence_seq`, the version of the appear-offline setting. 7: timeouts
/// (`member_timeouts`) and the Timeout members permission bit.
/// 8: `dms.closed_a` and `dms.closed_b`.
/// 9: `blocks`.
/// 10: `friends`, `friend_requests`, `friend_pings` and `privacy`.
/// 11: polls (`polls`, `poll_options`, `poll_votes`, `poll_snapshots`).
pub const SCHEMA_VERSION: i64 = 11;

/// Indexes on columns that `MIGRATIONS` may add, created after `reconcile_columns`.
fn late_indexes(is_sqlite: bool) -> [&'static str; 9] {
    [
        "CREATE INDEX IF NOT EXISTS idx_server_passwords_revoked ON server_passwords(revoked_at) WHERE revoked_at IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_server_passwords_expires ON server_passwords(expires_at) WHERE expires_at IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_server_passwords_used_up ON server_passwords(used_up_at) WHERE used_up_at IS NOT NULL",
        match is_sqlite {
            true => {
                "CREATE INDEX IF NOT EXISTS idx_users_display_lower ON users(lower(display_name))"
            }
            false => {
                "CREATE INDEX IF NOT EXISTS idx_users_display_lower ON users((lower(display_name) COLLATE \"C\"))"
            }
        },
        "CREATE INDEX IF NOT EXISTS idx_reactions_agg ON reactions(message_id, emoji, created_at, username)",
        "CREATE INDEX IF NOT EXISTS idx_pings_kept ON pings(username, id) WHERE seen <> 0",
        "CREATE INDEX IF NOT EXISTS idx_messages_system_channel ON messages(channel_id, created_at) WHERE kind IN ('join','leave')",
        "CREATE INDEX IF NOT EXISTS idx_messages_pin_notice ON messages(pin_message_id, created_at) WHERE kind = 'pin'",
        "CREATE INDEX IF NOT EXISTS idx_guest_grants_network ON guest_grants(server, network) WHERE network IS NOT NULL",
    ]
}

/// Placeholder for `server_passwords.hash`: extra passwords are checked through `lookup`
/// only, so no second verifier is kept.
pub const NO_EXTRA_HASH: &str = "!lookup";

async fn stored_setting(conn: &mut AnyConnection, key: &str) -> sqlx::Result<Option<String>> {
    sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(&mut *conn)
        .await?
        .map(|r| r.try_get(0))
        .transpose()
}

async fn store_setting(conn: &mut AnyConnection, key: &str, value: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

async fn seed_setting(conn: &mut AnyConnection, key: &str, value: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING")
        .bind(key)
        .bind(value)
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

async fn schema_version(conn: &mut AnyConnection) -> anyhow::Result<i64> {
    let have = stored_setting(conn, "schema_version").await?;
    Ok(have.and_then(|v| v.trim().parse().ok()).unwrap_or(0))
}

const HASH_BATCH: i64 = 500;

/// Replaces stored session tokens and guest grants that are still raw with their
/// `secret_key`. Keyed on the stored form, so rows that an older binary writes are converted
/// on the next start. The clients keep their raw values, which still match.
async fn hash_stored_secrets(conn: &mut AnyConnection) -> anyhow::Result<()> {
    for (table, col) in [("tokens", "token"), ("guest_grants", "\"grant\"")] {
        let mut total = 0;
        loop {
            let sql = format!(
                "SELECT {col} FROM {table} WHERE substr({col}, 1, 2) <> 'h:' LIMIT {HASH_BATCH}"
            );
            let raw: Vec<String> = sqlx::query(sqlx::AssertSqlSafe(sql))
                .fetch_all(&mut *conn)
                .await?
                .iter()
                .map(|r| r.try_get(0))
                .collect::<Result<_, _>>()?;
            if raw.is_empty() {
                break;
            }
            let update = format!("UPDATE {table} SET {col} = $1 WHERE {col} = $2");
            for value in &raw {
                sqlx::query(sqlx::AssertSqlSafe(update.clone()))
                    .bind(secret_key(value))
                    .bind(value)
                    .execute(&mut *conn)
                    .await?;
            }
            total += raw.len();
        }
        if total > 0 {
            tracing::info!("hashed {total} stored {table} rows");
        }
    }
    Ok(())
}

async fn reconcile_columns(
    conn: &mut AnyConnection,
    is_sqlite: bool,
) -> anyhow::Result<Vec<(&'static str, String)>> {
    let int = match is_sqlite {
        true => "INTEGER",
        false => "BIGINT",
    };
    let mut added = Vec::new();
    for (table, col) in MIGRATIONS {
        let coldef = col.replace("{INT}", int);
        let name = coldef.split_whitespace().next().unwrap_or(&coldef);
        if !is_sqlite {
            let present = sqlx::query(
                "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
            )
            .bind(*table)
            .bind(name)
            .fetch_optional(&mut *conn)
            .await?
            .is_some();
            if present {
                continue;
            }
        }
        let sql = format!("ALTER TABLE {table} ADD COLUMN {coldef}");
        match sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut *conn)
            .await
        {
            Ok(_) => {
                tracing::info!("added missing column {table}.{name}");
                added.push((*table, name.to_string()));
            }
            Err(e)
                if matches!(&e, sqlx::Error::Database(d)
                    if d.message().contains("duplicate column")
                        || d.message().contains("already exists")) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(added)
}

/// How an avatar is drawn: `identicon` is a pattern generated from the username, `color` is a
/// solid `avatar_color` circle.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum AvatarKind {
    Identicon,
    Color,
}

impl AvatarKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AvatarKind::Identicon => "identicon",
            AvatarKind::Color => "color",
        }
    }

    pub fn parse(s: &str) -> sqlx::Result<AvatarKind> {
        match s {
            "identicon" => Ok(AvatarKind::Identicon),
            "color" => Ok(AvatarKind::Color),
            other => Err(sqlx::Error::Decode(
                format!("invalid avatar_kind: {other}").into(),
            )),
        }
    }
}

/// `text` channels hold messages; `voice` channels hold voice and video calls.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKind {
    Text,
    Voice,
}

impl ChannelKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelKind::Text => "text",
            ChannelKind::Voice => "voice",
        }
    }

    pub fn parse(s: &str) -> sqlx::Result<ChannelKind> {
        match s {
            "text" => Ok(ChannelKind::Text),
            "voice" => Ok(ChannelKind::Voice),
            other => Err(sqlx::Error::Decode(
                format!("invalid channel kind: {other}").into(),
            )),
        }
    }
}

/// `server`: uploaded through `POST /api/media` and stored by the instance. `p2p`: kept in the
/// sender's browser and shared peer to peer while they are online; the server stores only the
/// metadata.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Server,
    P2p,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Server => "server",
            MediaKind::P2p => "p2p",
        }
    }

    pub fn parse(s: &str) -> sqlx::Result<MediaKind> {
        match s {
            "server" => Ok(MediaKind::Server),
            "p2p" => Ok(MediaKind::P2p),
            other => Err(sqlx::Error::Decode(
                format!("invalid media kind: {other}").into(),
            )),
        }
    }
}

#[derive(Clone)]
pub struct User {
    pub username: String,
    pub display_name: String,
    pub password_hash: String,
    pub password_kind: String,
    pub avatar_kind: AvatarKind,
    pub avatar_color: Option<String>,
    pub banner_color: Option<String>,
    pub bio: Option<String>,
    pub is_site_admin: bool,
    pub appear_offline: bool,
    pub created_at: i64,
}

impl User {
    pub fn from_row(row: &AnyRow) -> sqlx::Result<User> {
        Ok(User {
            username: row.try_get("username")?,
            display_name: row.try_get("display_name")?,
            password_hash: row.try_get("password_hash")?,
            password_kind: row.try_get("password_kind")?,
            avatar_kind: AvatarKind::parse(&row.try_get::<String, _>("avatar_kind")?)?,
            avatar_color: row.try_get("avatar_color")?,
            banner_color: row.try_get("banner_color")?,
            bio: row.try_get("bio")?,
            is_site_admin: row.try_get::<i64, _>("is_site_admin")? != 0,
            appear_offline: row.try_get::<i64, _>("appear_offline")? != 0,
            created_at: row.try_get("created_at")?,
        })
    }
}

pub const PURGING_HASH: &str = "!purging";

pub const NO_PERMANENT_HASH: &str = "!none";

pub const LIVE_DM: &str = "NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username IN (user_a, user_b) AND pu.password_hash = '!purging')";

pub const LIVE_AUTHOR: &str = "NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username = m.author AND pu.password_hash = '!purging')";

pub async fn get_user<'e, E>(ex: E, username: &str) -> sqlx::Result<Option<User>>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    sqlx::query("SELECT * FROM users WHERE username = $1 AND password_hash <> '!purging'")
        .bind(username.to_lowercase())
        .fetch_optional(ex)
        .await?
        .as_ref()
        .map(User::from_row)
        .transpose()
}

pub async fn user_row<'e, E>(ex: E, username: &str) -> sqlx::Result<Option<User>>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    sqlx::query("SELECT * FROM users WHERE username = $1")
        .bind(username.to_lowercase())
        .fetch_optional(ex)
        .await?
        .as_ref()
        .map(User::from_row)
        .transpose()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Perm {
    ManageChannels = 1,
    DeleteMessages = 2,
    Kick = 4,
    DeleteServer = 8,
    ManageAdmins = 16,
    MentionEveryone = 32,
    ViewAuditLog = 64,
    TimeoutMembers = 128,
}

pub const ALL_PERMS: i64 = 255;
/// Every permission before `MentionEveryone` existed.
const OLD_ALL_PERMS: i64 = 31;
/// Every permission before `ViewAuditLog` existed.
const PRE_AUDIT_PERMS: i64 = 63;
/// Every permission before `TimeoutMembers` existed.
const PRE_TIMEOUT_PERMS: i64 = 127;

pub fn perm_bits(is_admin: bool, perms: i64, roles: i64) -> i64 {
    match (is_admin, perms) {
        (true, 0) => ALL_PERMS,
        (true, p) => p & ALL_PERMS,
        (false, _) => roles & ALL_PERMS,
    }
}

pub fn can_moderate(actor: i64, actor_site_admin: bool, target: i64) -> bool {
    actor_site_admin || ((target & !actor) == 0 && target != actor)
}

pub fn can_grant(actor: i64, actor_site_admin: bool, perms: i64) -> bool {
    actor_site_admin || (perms & ALL_PERMS & !actor) == 0
}

#[derive(Clone, Copy)]
pub struct ChannelAccess {
    pub view: bool,
    pub send: bool,
    pub history: bool,
}

impl ChannelAccess {
    pub fn all(v: bool) -> ChannelAccess {
        ChannelAccess {
            view: v,
            send: v,
            history: v,
        }
    }
}

pub async fn perm_subjects(
    db: &Db,
    server: Option<&str>,
    username: &str,
) -> sqlx::Result<Vec<String>> {
    let rows = match server {
        Some(server) => {
            sqlx::query("SELECT role_id FROM user_roles WHERE server = $1 AND username = $2")
                .bind(server)
                .bind(username)
                .fetch_all(db)
                .await?
        }
        None => {
            sqlx::query("SELECT role_id FROM user_roles WHERE username = $1")
                .bind(username)
                .fetch_all(db)
                .await?
        }
    };
    let mut subjects = Vec::with_capacity(rows.len() + 1);
    subjects.push(format!("u:{username}"));
    for r in &rows {
        subjects.push(format!("r:{}", r.try_get::<i64, _>(0)?));
    }
    Ok(subjects)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PermRow {
    pub subject: String,
    pub view: bool,
    pub send: bool,
    pub history: bool,
}

pub fn perm_row(r: &AnyRow, at: usize) -> sqlx::Result<PermRow> {
    Ok(PermRow {
        subject: r.try_get(at)?,
        view: r.try_get::<i64, _>(at + 1)? != 0,
        send: r.try_get::<i64, _>(at + 2)? != 0,
        history: r.try_get::<i64, _>(at + 3)? != 0,
    })
}

/// Which actions of a channel need an explicit allow from one of its rules (`restrict_view`,
/// `restrict_send`).
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Restrict {
    pub view: bool,
    pub send: bool,
}

impl Restrict {
    pub fn read(r: &AnyRow, at: usize) -> sqlx::Result<Restrict> {
        Ok(Restrict {
            view: r.try_get::<i64, _>(at)? != 0,
            send: r.try_get::<i64, _>(at + 1)? != 0,
        })
    }
}

/// The channel rule: managers pass. Otherwise each action is allowed by any rule matching one of
/// `subjects` that allows it; without a matching rule, actions are allowed unless the channel
/// restricts them (history only follows view). No view means nothing.
pub fn fold_access<'a>(
    rows: impl IntoIterator<Item = &'a PermRow>,
    subjects: &[String],
    manages: bool,
    restrict: Restrict,
) -> ChannelAccess {
    if manages {
        return ChannelAccess::all(true);
    }
    let mut matched = false;
    let mut acc = ChannelAccess::all(false);
    for row in rows {
        let PermRow {
            subject,
            view,
            send,
            history,
        } = row;
        if subjects.contains(subject) {
            matched = true;
            acc.view |= *view;
            acc.send |= *send;
            acc.history |= *history;
        }
    }
    let Restrict {
        view: restrict_view,
        send: restrict_send,
    } = restrict;
    let acc = match matched {
        true => acc,
        false => ChannelAccess {
            view: !restrict_view,
            send: !restrict_send,
            history: true,
        },
    };
    match acc.view {
        true => acc,
        false => ChannelAccess::all(false),
    }
}

/// Whether taking `rule` away from a member can widen their access: for a member it was the only
/// match for, it allows less than a member matching no rule gets in that channel. Deleting or
/// unassigning a role with such a rule needs Manage channels.
pub fn rule_narrows(rule: &PermRow, restrict: Restrict) -> bool {
    let subject = [rule.subject.clone()];
    let ChannelAccess {
        view,
        send,
        history,
    } = fold_access([rule], &subject, false, restrict);
    let open = fold_access([], &subject, false, restrict);
    (open.view && !view) || (open.send && !send) || (open.history && !history)
}

pub async fn setting_on<'e, E>(ex: E, key: &str) -> sqlx::Result<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let row = sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(ex)
        .await?;
    Ok(match row {
        Some(row) => row.try_get::<String, _>(0)? == "1",
        None => true,
    })
}

const TOUCH_EVERY: Duration = Duration::from_secs(60);
const TOUCH_MAX: usize = 100_000;

type Touched = HashMap<(String, String, String), Instant>;

static TOUCHED: LazyLock<Mutex<Touched>> = LazyLock::new(Default::default);

fn recently_touched(db: &Db, server: &str, username: &str) -> bool {
    let key = (pool_key(db), server.to_string(), username.to_string());
    let Ok(mut map) = TOUCHED.lock() else {
        return false;
    };
    if map.get(&key).is_some_and(|at| at.elapsed() < TOUCH_EVERY) {
        return true;
    }
    if map.len() >= TOUCH_MAX {
        map.retain(|_, at| at.elapsed() < TOUCH_EVERY);
        if map.len() >= TOUCH_MAX {
            map.clear();
        }
    }
    map.insert(key, Instant::now());
    false
}

pub async fn touch_interaction(db: &Db, server: &str, username: &str) -> sqlx::Result<()> {
    if recently_touched(db, server, username) {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO interactions(server, username, last_at) VALUES($1, $2, $3) ON CONFLICT(server, username) DO UPDATE SET last_at = excluded.last_at",
    )
    .bind(server)
    .bind(username)
    .bind(now())
    .execute(db)
    .await
    .map(|_| ())
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn env_num<T: std::str::FromStr>(key: &str) -> Option<T> {
    std::env::var(key).ok().and_then(|v| v.trim().parse().ok())
}

pub fn trigger_version(stmts: &[&str]) -> String {
    let hash = Sha256::digest(stmts.join(";\n").as_bytes());
    hash.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

async fn postgres_triggers(conn: &mut AnyConnection) -> anyhow::Result<()> {
    let want = trigger_version(POSTGRES_TRIGGERS);
    if stored_setting(conn, "trigger_version").await?.as_deref() == Some(want.as_str()) {
        return Ok(());
    }
    for stmt in POSTGRES_TRIGGERS {
        sqlx::query(*stmt).execute(&mut *conn).await?;
    }
    store_setting(conn, "trigger_version", &want).await?;
    tracing::info!("installed database triggers version {want}");
    Ok(())
}

async fn init_schema(conn: &mut AnyConnection, is_sqlite: bool) -> anyhow::Result<()> {
    let schema = match is_sqlite {
        true => SQLITE_SCHEMA,
        false => POSTGRES_SCHEMA,
    };
    let (tables, rest): (Vec<&str>, Vec<&str>) = schema
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .partition(|s| s.starts_with("CREATE TABLE"));
    sqlx::query("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        .execute(&mut *conn)
        .await?;
    let version = schema_version(conn).await?;
    if version > SCHEMA_VERSION {
        anyhow::bail!(
            "the database has schema version {version}, but this build only knows version {SCHEMA_VERSION}. A newer release upgraded it. Run that release or a newer one"
        );
    }
    for stmt in tables {
        sqlx::query(stmt).execute(&mut *conn).await?;
    }
    let added = reconcile_columns(conn, is_sqlite).await?;
    for stmt in rest {
        sqlx::query(stmt).execute(&mut *conn).await?;
    }
    for stmt in late_indexes(is_sqlite) {
        sqlx::query(stmt).execute(&mut *conn).await?;
    }
    hash_stored_secrets(conn).await?;
    sqlx::query("UPDATE server_passwords SET hash = $1 WHERE hash <> $1")
        .bind(NO_EXTRA_HASH)
        .execute(&mut *conn)
        .await?;
    match is_sqlite {
        true => {
            for stmt in SQLITE_TRIGGERS {
                sqlx::query(*stmt).execute(&mut *conn).await?;
            }
        }
        false => postgres_triggers(conn).await?,
    }
    for (table, col, sql) in BACKFILLS {
        if added.iter().any(|(t, c)| t == table && c == col) {
            let query = sqlx::query(*sql);
            let query = match sql.contains("$1") {
                true => query.bind(now()),
                false => query,
            };
            query.execute(&mut *conn).await?;
            tracing::info!("backfilled {table}.{col}");
        }
    }
    if stored_setting(conn, RESTRICT_BACKFILL).await?.is_none() {
        let n = sqlx::query("UPDATE channels SET restrict_view = 1 WHERE restrict_view = 0 AND EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = channels.id)")
            .execute(&mut *conn)
            .await?
            .rows_affected();
        seed_setting(conn, RESTRICT_BACKFILL, "1").await?;
        tracing::info!("backfilled channels.restrict_view on {n} channels with rules");
    }
    restrict_old_rules(conn).await?;
    if version < 4 {
        let n = sqlx::query("UPDATE members SET perms = $1 WHERE is_admin <> 0 AND perms = $2")
            .bind(PRE_AUDIT_PERMS)
            .bind(OLD_ALL_PERMS)
            .execute(&mut *conn)
            .await?
            .rows_affected();
        if n > 0 {
            tracing::info!("gave {n} admins with every permission the Mention everyone permission");
        }
    }
    if version < 5 {
        let n = sqlx::query("UPDATE members SET perms = $1 WHERE is_admin <> 0 AND perms = $2")
            .bind(PRE_TIMEOUT_PERMS)
            .bind(PRE_AUDIT_PERMS)
            .execute(&mut *conn)
            .await?
            .rows_affected();
        if n > 0 {
            tracing::info!("gave {n} admins with every permission the View audit log permission");
        }
    }
    if version < 7 {
        let n = sqlx::query("UPDATE members SET perms = $1 WHERE is_admin <> 0 AND perms = $2")
            .bind(ALL_PERMS)
            .bind(PRE_TIMEOUT_PERMS)
            .execute(&mut *conn)
            .await?
            .rows_affected();
        if n > 0 {
            tracing::info!("gave {n} admins with every permission the Timeout members permission");
        }
    }
    let t = now();
    sqlx::query("INSERT INTO servers(name, display_name, creator, created_at) VALUES('rchat', 'RChat', NULL, $1) ON CONFLICT(name) DO NOTHING")
        .bind(t)
        .execute(&mut *conn)
        .await?;
    sqlx::query("INSERT INTO channels(server, name, created_at) SELECT 'rchat', 'general', $1 WHERE NOT EXISTS(SELECT 1 FROM channels WHERE server = 'rchat')")
        .bind(t)
        .execute(&mut *conn)
        .await?;
    let guests = match std::env::var("GUESTS_ENABLED") {
        Ok(v) if matches!(v.trim().to_lowercase().as_str(), "0" | "false" | "off") => "0",
        _ => "1",
    };
    seed_setting(conn, "guests_enabled", guests).await?;
    let profanity = crate::api::profanity_seed(
        std::env::var("PROFANITY_FILTER").ok().as_deref(),
        std::env::var("PROFANITY_TARGETS").ok().as_deref(),
    );
    seed_settings(&mut *conn, &profanity).await?;
    let p2p = crate::api::switch_seed(std::env::var("P2P_ATTACHMENTS").ok().as_deref());
    seed_settings(&mut *conn, &[("p2p_attachments", p2p)]).await?;
    for (key, value) in [
        ("instance_id", crate::identity::random_id()),
        ("instance_signing_key", crate::identity::new_seed()),
        ("password_pepper", crate::api::auth::new_token()),
        ("relay_secret", crate::api::auth::new_token()),
        ("p2p_secret", crate::api::auth::new_token()),
    ] {
        seed_setting(conn, key, &value).await?;
    }
    store_setting(conn, "schema_version", &SCHEMA_VERSION.to_string()).await?;
    Ok(())
}

/// Rules that a binary without `restrict_view` wrote (`restrict_set` = 0) made their channel
/// private there, so the channel needs the view restriction here too. Runs at every start, so
/// rules that an older binary adds after the first upgrade are covered as well. Rules this
/// binary writes are marked, so a channel an admin opened stays open.
async fn restrict_old_rules(conn: &mut AnyConnection) -> sqlx::Result<()> {
    let n = sqlx::query("UPDATE channels SET restrict_view = 1 WHERE restrict_view = 0 AND EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = channels.id AND cp.restrict_set = 0)")
        .execute(&mut *conn)
        .await?
        .rows_affected();
    sqlx::query("UPDATE channel_perms SET restrict_set = 1 WHERE restrict_set = 0")
        .execute(&mut *conn)
        .await?;
    if n > 0 {
        tracing::info!("restricted {n} channels with rules from an older binary");
    }
    Ok(())
}

pub(crate) async fn seed_settings(
    conn: &mut AnyConnection,
    pairs: &[(&str, bool)],
) -> sqlx::Result<()> {
    for (key, on) in pairs {
        let value = match on {
            true => "1",
            false => "0",
        };
        seed_setting(conn, key, value).await?;
    }
    Ok(())
}

pub async fn open(database_url: Option<&str>) -> anyhow::Result<Db> {
    install_default_drivers();
    let url = match database_url {
        Some(u)
            if u.starts_with("postgres://")
                || u.starts_with("postgresql://")
                || u.starts_with("sqlite:") =>
        {
            u.to_string()
        }
        Some(path) => format!("sqlite://{path}?mode=rwc"),
        None => "sqlite://rchat.db?mode=rwc".to_string(),
    };
    let is_sqlite = url.starts_with("sqlite:");
    let max = env_num::<u32>("DATABASE_MAX_CONNECTIONS");
    if is_sqlite && max.is_some_and(|n| n != 1) {
        tracing::warn!(
            "DATABASE_MAX_CONNECTIONS is ignored for sqlite: it has a single writer; use DATABASE_READ_CONNECTIONS for reads"
        );
    }
    let mut options = pool_options(writer_connections(is_sqlite, max));
    if let Some(min) = env_num("DATABASE_MIN_CONNECTIONS") {
        options = options.min_connections(min);
    }
    let pragmas: &'static [&'static str] = match is_sqlite {
        true => &[
            "PRAGMA journal_mode=WAL",
            "PRAGMA foreign_keys=ON",
            "PRAGMA busy_timeout=5000",
            "PRAGMA synchronous=NORMAL",
            "PRAGMA mmap_size=268435456",
        ],
        false => &[],
    };
    let pool = with_pragmas(options, pragmas).connect(&url).await?;
    let mut tx = pool.begin().await?;
    if !is_sqlite {
        sqlx::query("SELECT COUNT(*) FROM pg_advisory_xact_lock($1)")
            .bind(SCHEMA_LOCK)
            .execute(&mut *tx)
            .await?;
    }
    init_schema(&mut tx, is_sqlite).await?;
    if !is_sqlite {
        postgres_search_index(&mut tx).await;
    }
    tx.commit().await?;
    match is_sqlite {
        true => {
            if let Err(e) = sqlite_search_index(&pool).await {
                tracing::warn!("FTS5 trigram unavailable, search falls back to LIKE: {e}");
            }
            set_fts(&pool, probe_fts(&pool).await);
            let in_memory = url.contains(":memory:") || url.contains("mode=memory");
            let readers = match in_memory {
                true => 0,
                false => env_num("DATABASE_READ_CONNECTIONS").unwrap_or_else(|| {
                    std::thread::available_parallelism()
                        .map(|n| n.get() as u32)
                        .unwrap_or(4)
                        .clamp(2, 8)
                }),
            };
            if readers > 0 {
                let read = open_reader(&url, readers).await?;
                if let Ok(mut map) = READERS.lock() {
                    map.insert(pool_key(&pool), read);
                }
            }
        }
        false => set_fts(&pool, false),
    }
    pepper(&pool).await?;
    Ok(pool)
}

pub fn writer_connections(is_sqlite: bool, configured: Option<u32>) -> u32 {
    match (is_sqlite, configured) {
        (true, _) => 1,
        (false, Some(n)) => n,
        (false, None) => 8,
    }
}

fn pool_options(max: u32) -> AnyPoolOptions {
    let options = AnyPoolOptions::new().max_connections(max);
    match env_num("DATABASE_ACQUIRE_TIMEOUT_SECS") {
        Some(secs) => options.acquire_timeout(Duration::from_secs(secs)),
        None => options,
    }
}

fn with_pragmas(options: AnyPoolOptions, pragmas: &'static [&'static str]) -> AnyPoolOptions {
    options.after_connect(move |conn, _| {
        Box::pin(async move {
            for pragma in pragmas {
                sqlx::query(*pragma).execute(&mut *conn).await?;
            }
            Ok(())
        })
    })
}

async fn open_reader(url: &str, max: u32) -> anyhow::Result<Db> {
    let pragmas = &[
        "PRAGMA busy_timeout=5000",
        "PRAGMA query_only=ON",
        "PRAGMA mmap_size=268435456",
    ];
    Ok(with_pragmas(pool_options(max), pragmas)
        .connect(url)
        .await?)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub guest_grants: u64,
    pub server_passwords: u64,
    pub login_attempts: u64,
    pub password_attempts: u64,
    pub embeds: u64,
    pub pings: u64,
    pub config_shares: u64,
    pub audit_log: u64,
    pub member_timeouts: u64,
}

async fn delete_batched(db: &Db, sql: &'static str, cutoff: i64) -> sqlx::Result<u64> {
    let mut total = 0;
    loop {
        let n = sqlx::query(sql)
            .bind(cutoff)
            .bind(PURGE_BATCH)
            .execute(db)
            .await?
            .rows_affected();
        total += n;
        if n < PURGE_BATCH as u64 {
            return Ok(total);
        }
        tokio::task::yield_now().await;
    }
}

fn days(key: &str, default: i64) -> i64 {
    env_num::<i64>(key).unwrap_or(default).max(1) * 86400
}

pub fn guest_grant_ttl() -> i64 {
    days("GUEST_GRANT_DAYS", 30)
}

pub const GRANT_TOUCH_SECS: i64 = 86400;

static GRANT_TOUCHES: LazyLock<Mutex<HashMap<String, HashSet<String>>>> =
    LazyLock::new(Default::default);

pub const GRANT_TOUCHES_MAX: usize = 10_000;

#[cfg(test)]
pub(crate) fn grant_touch_queued(db: &Db, grant: &str) -> bool {
    GRANT_TOUCHES
        .lock()
        .ok()
        .and_then(|touches| touches.get(&pool_key(db)).map(|set| set.contains(grant)))
        .unwrap_or(false)
}

pub fn queue_grant_touches(db: &Db, grants: impl IntoIterator<Item = String>) {
    if let Ok(mut touches) = GRANT_TOUCHES.lock() {
        let queued = touches.entry(pool_key(db)).or_default();
        for grant in grants {
            if queued.len() >= GRANT_TOUCHES_MAX {
                break;
            }
            queued.insert(grant);
        }
    }
}

pub async fn flush_grant_touches(db: &Db) -> sqlx::Result<u64> {
    let grants: Vec<String> = GRANT_TOUCHES
        .lock()
        .ok()
        .and_then(|mut touches| touches.remove(&pool_key(db)))
        .map(|set| set.into_iter().collect())
        .unwrap_or_default();
    let t = now();
    let cutoff = t - guest_grant_ttl();
    let mut total = 0;
    for (i, chunk) in grants.chunks(100).enumerate() {
        let sql = format!(
            "UPDATE guest_grants SET last_used_at = $1 WHERE last_used_at <= $2 AND (last_used_at >= $3 OR (last_used_at = 0 AND created_at >= $3)) AND \"grant\" IN ({})",
            (0..chunk.len())
                .map(|i| format!("${}", i + 4))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(t)
            .bind(t - GRANT_TOUCH_SECS)
            .bind(cutoff);
        for grant in chunk {
            query = query.bind(grant);
        }
        match query.execute(db).await {
            Ok(done) => total += done.rows_affected(),
            Err(e) => {
                queue_grant_touches(db, grants.chunks(100).skip(i).flatten().cloned());
                return Err(e);
            }
        }
    }
    Ok(total)
}

pub const SERVER_PASSWORD_KEEP: i64 = 30 * 86400;

pub const PING_KEEP: i64 = 30 * 86400;

/// How long audit log entries are kept.
pub const AUDIT_KEEP: i64 = 90 * 86400;

/// How long an ended timeout row is kept before the sweep deletes it (the checks ignore it).
pub const TIMEOUT_KEEP: i64 = 3600;

/// Most seen and retracted pings kept per recipient. Seen reaction pings stay until they age
/// out so that taking a reaction back and adding it again does not ping again; this caps them.
pub const PINGS_KEPT: i64 = 2000;

pub async fn sweep_stale(db: &Db) -> sqlx::Result<Swept> {
    let t = now();
    let stale_grants = delete_batched(
        db,
        "DELETE FROM guest_grants WHERE \"grant\" IN (SELECT \"grant\" FROM guest_grants WHERE last_used_at < $1 AND (last_used_at > 0 OR created_at < $1) LIMIT $2)",
        t - guest_grant_ttl(),
    )
    .await?;
    let ended_grants = delete_batched(
        db,
        "DELETE FROM guest_grants WHERE \"grant\" IN (SELECT g.\"grant\" FROM guest_grants g WHERE g.password_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM server_passwords p WHERE p.id = g.password_id AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > $1)) LIMIT $2)",
        t,
    )
    .await?;
    Ok(Swept {
        guest_grants: stale_grants + ended_grants,
        server_passwords: delete_batched(
            db,
            "DELETE FROM server_passwords WHERE id IN (SELECT id FROM server_passwords WHERE revoked_at < $1 OR expires_at < $1 OR used_up_at < $1 LIMIT $2)",
            t - SERVER_PASSWORD_KEEP,
        )
        .await?,
        login_attempts: delete_batched(
            db,
            "DELETE FROM login_attempts WHERE username IN (SELECT username FROM login_attempts WHERE last_at < $1 LIMIT $2)",
            t - 2 * 86400,
        )
        .await?,
        password_attempts: delete_batched(
            db,
            "DELETE FROM change_attempts WHERE session IN (SELECT session FROM change_attempts WHERE last_at < $1 LIMIT $2)",
            t - 2 * 86400,
        )
        .await?,
        embeds: delete_batched(
            db,
            "DELETE FROM embeds WHERE url IN (SELECT e.url FROM embeds e WHERE e.fetched_at < $1 AND NOT EXISTS(SELECT 1 FROM message_embeds me WHERE me.url = e.url) LIMIT $2)",
            t - days("EMBED_CACHE_DAYS", 30),
        )
        .await?,
        pings: delete_batched(
            db,
            "DELETE FROM pings WHERE id IN (SELECT id FROM pings WHERE (seen <> 0 AND seen <> 2 AND kind <> 'reaction') OR created_at < $1 LIMIT $2)",
            t - PING_KEEP,
        )
        .await?
            + trim_kept_pings(db).await?
            + delete_batched(
                db,
                "DELETE FROM group_pings WHERE id IN (SELECT id FROM group_pings WHERE created_at < $1 LIMIT $2)",
                t - PING_KEEP,
            )
            .await?
            + delete_batched(
                db,
                "DELETE FROM friend_pings WHERE id IN (SELECT id FROM friend_pings WHERE seen <> 0 OR created_at < $1 LIMIT $2)",
                t - PING_KEEP,
            )
            .await?,
        config_shares: delete_batched(
            db,
            "DELETE FROM config_shares WHERE id IN (SELECT id FROM config_shares WHERE expires_at <= $1 LIMIT $2)",
            t,
        )
        .await?,
        audit_log: delete_batched(
            db,
            "DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < $1 LIMIT $2)",
            t - AUDIT_KEEP,
        )
        .await?,
        member_timeouts: delete_batched(
            db,
            "DELETE FROM member_timeouts WHERE (server, username) IN (SELECT server, username FROM member_timeouts WHERE until < $1 LIMIT $2)",
            t - TIMEOUT_KEEP,
        )
        .await?,
    })
}

pub const PURGE_BATCH: i64 = 500;

/// Recipients with more than `PINGS_KEPT` seen pings handled per sweep.
const KEPT_USERS_MAX: i64 = 1000;

/// Keeps the newest `PINGS_KEPT` seen and retracted pings of each recipient. One pass over the
/// seen-ping index finds the recipients above the cap; only their pings are looked at.
async fn trim_kept_pings(db: &Db) -> sqlx::Result<u64> {
    let users = sqlx::query("SELECT username FROM pings WHERE seen <> 0 GROUP BY username HAVING COUNT(*) > $1 LIMIT $2")
        .bind(PINGS_KEPT)
        .bind(KEPT_USERS_MAX)
        .fetch_all(db)
        .await?;
    let mut total = 0;
    for row in &users {
        let username: String = row.try_get(0)?;
        let Some(cut) = sqlx::query("SELECT id FROM pings WHERE username = $1 AND seen <> 0 ORDER BY id DESC LIMIT 1 OFFSET $2")
            .bind(&username)
            .bind(PINGS_KEPT)
            .fetch_optional(db)
            .await?
        else {
            continue;
        };
        let cut: i64 = cut.try_get(0)?;
        loop {
            let n = sqlx::query("DELETE FROM pings WHERE id IN (SELECT id FROM pings WHERE username = $1 AND seen <> 0 AND id <= $2 LIMIT $3)")
                .bind(&username)
                .bind(cut)
                .bind(PURGE_BATCH)
                .execute(db)
                .await?
                .rows_affected();
            total += n;
            if n < PURGE_BATCH as u64 {
                break;
            }
            tokio::task::yield_now().await;
        }
    }
    Ok(total)
}

pub async fn purge_messages(db: &Db, cond: &'static str, key: &str) -> sqlx::Result<u64> {
    let sql = format!(
        "DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE {cond} LIMIT {PURGE_BATCH})"
    );
    let mut total = 0;
    loop {
        let n = sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
            .bind(key)
            .execute(db)
            .await?
            .rows_affected();
        total += n;
        if n == 0 {
            return Ok(total);
        }
        tokio::task::yield_now().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_util::{add_member, done, temp_state};

    async fn general_id(db: &Db) -> i64 {
        sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general channel")
            .try_get(0)
            .expect("channel id")
    }

    #[test]
    fn moderation_needs_a_strict_superset() {
        let kick = Perm::Kick as i64;
        let channels = Perm::ManageChannels as i64;
        let cases: [(i64, bool, i64, bool); 9] = [
            (kick, false, 0, true),
            (kick, false, kick, false),
            (kick, false, ALL_PERMS, false),
            (kick, false, channels, false),
            (kick | channels, false, channels, true),
            (kick | channels, false, kick, true),
            (ALL_PERMS, false, ALL_PERMS, false),
            (ALL_PERMS, false, ALL_PERMS & !channels, true),
            (ALL_PERMS, true, ALL_PERMS, true),
        ];
        for (actor, site_admin, target, expected) in cases {
            assert_eq!(
                can_moderate(actor, site_admin, target),
                expected,
                "actor {actor} site admin {site_admin} target {target}"
            );
        }
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect("count")
            .try_get(0)
            .expect("count value")
    }

    #[tokio::test]
    async fn reader_pool_reads_committed_writes_and_refuses_writes() {
        let (state, path) = temp_state("reader_pool").await;
        let read = state.read();
        assert!(
            sqlx::query("INSERT INTO settings(key, value) VALUES('x', '1')")
                .execute(&read)
                .await
                .is_err(),
            "reader must be query_only"
        );
        let mut tx = state.db.begin().await.expect("begin");
        sqlx::query("INSERT INTO settings(key, value) VALUES('held', '1')")
            .execute(&mut *tx)
            .await
            .expect("write in open tx");
        let started = Instant::now();
        assert_eq!(
            count(&read, "SELECT COUNT(*) FROM settings WHERE key = 'held'").await,
            0
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "readers do not wait for an open write transaction"
        );
        tx.commit().await.expect("commit");
        assert_eq!(
            count(&read, "SELECT COUNT(*) FROM settings WHERE key = 'held'").await,
            1
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn triggers_keep_dm_latest_and_member_counts() {
        let (state, path) = temp_state("triggers").await;
        let db = &state.db;
        let dm: i64 = sqlx::query("INSERT INTO dms(user_a, user_b) VALUES('a', 'b') RETURNING id")
            .fetch_one(db)
            .await
            .expect("dm")
            .try_get(0)
            .expect("id");
        let mut ids = Vec::new();
        for _ in 0..3 {
            let id: i64 = sqlx::query("INSERT INTO messages(dm_id, author, content, created_at) VALUES($1, 'a', 'x', 1) RETURNING id")
                .bind(dm)
                .fetch_one(db)
                .await
                .expect("msg")
                .try_get(0)
                .expect("id");
            ids.push(id);
        }
        let latest = || async {
            count(
                db,
                &format!("SELECT last_message_id FROM dms WHERE id = {dm}"),
            )
            .await
        };
        assert_eq!(latest().await, ids[2]);
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(ids[2])
            .execute(db)
            .await
            .expect("delete latest");
        assert_eq!(latest().await, ids[1]);
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(ids[0])
            .execute(db)
            .await
            .expect("delete older");
        assert_eq!(latest().await, ids[1]);
        sqlx::query("DELETE FROM messages WHERE dm_id = $1")
            .bind(dm)
            .execute(db)
            .await
            .expect("delete all");
        assert_eq!(latest().await, 0);
        let members =
            || async { count(db, "SELECT member_count FROM servers WHERE name = 'rchat'").await };
        assert_eq!(members().await, 0);
        for name in ["x", "y", "z"] {
            add_member(db, "rchat", name, 0, 0, now()).await;
        }
        sqlx::query("INSERT INTO members(server, username, joined_at) VALUES('rchat', 'x', 1) ON CONFLICT(server, username) DO NOTHING")
            .execute(db)
            .await
            .expect("duplicate join");
        assert_eq!(members().await, 3);
        sqlx::query("DELETE FROM members WHERE server = 'rchat' AND username = 'y'")
            .execute(db)
            .await
            .expect("leave");
        assert_eq!(members().await, 2);
        sqlx::query("INSERT INTO servers(name, display_name, created_at) VALUES('old', 'Old', 1)")
            .execute(db)
            .await
            .expect("server");
        add_member(db, "old", "x", 1, 0, now()).await;
        sqlx::query("UPDATE servers SET name = 'new' WHERE name = 'old'")
            .execute(db)
            .await
            .expect("rename");
        assert_eq!(
            count(db, "SELECT member_count FROM servers WHERE name = 'new'").await,
            1
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn new_columns_are_backfilled_on_existing_databases() {
        let path = std::env::temp_dir().join(format!("rchat_backfill_{}.db", std::process::id()));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP TRIGGER messages_dm_latest_insert",
            "DROP TRIGGER messages_dm_latest_delete",
            "DROP TRIGGER members_count_insert",
            "DROP TRIGGER members_count_delete",
            "DROP INDEX idx_dms_a_latest",
            "DROP INDEX idx_dms_b_latest",
            "DROP INDEX idx_guest_grants_used",
            "ALTER TABLE dms DROP COLUMN last_message_id",
            "ALTER TABLE servers DROP COLUMN member_count",
            "ALTER TABLE guest_grants DROP COLUMN last_used_at",
            "INSERT INTO dms(user_a, user_b) VALUES('a', 'b')",
            "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'a', 'x', 1)",
            "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'b', 'y', 2)",
            "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'a', 1)",
            "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'b', 1)",
            "INSERT INTO guest_grants(\"grant\", server, created_at) VALUES('g', 'rchat', 77)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        let db = open(path.to_str()).await.expect("reopen");
        assert_eq!(
            count(&db, "SELECT last_message_id FROM dms WHERE id = 1").await,
            2
        );
        assert_eq!(
            count(&db, "SELECT member_count FROM servers WHERE name = 'rchat'").await,
            2
        );
        assert!(count(&db, "SELECT last_used_at FROM guest_grants").await >= now() - 60);
        add_member(&db, "rchat", "c", 0, 0, now()).await;
        assert_eq!(
            count(&db, "SELECT member_count FROM servers WHERE name = 'rchat'").await,
            3
        );
        close(&db).await;
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[tokio::test]
    async fn existing_users_get_a_presence_seq_column() {
        let path =
            std::env::temp_dir().join(format!("rchat_presence_seq_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE users DROP COLUMN presence_seq",
            "UPDATE settings SET value = '5' WHERE key = 'schema_version'",
            "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, appear_offline, created_at) VALUES('alice', 'Alice', 'h', 'text', 'identicon', 1, 5)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert!(
            sqlx::query("SELECT presence_seq FROM users")
                .fetch_all(&db)
                .await
                .is_err()
        );
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM users WHERE username = 'alice' AND appear_offline = 1 AND created_at = 5 AND presence_seq = 0").await,
                1
            );
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM settings WHERE key = 'schema_version' AND value = '{SCHEMA_VERSION}'")).await,
                1
            );
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn existing_channels_get_an_empty_topic_column() {
        let path = std::env::temp_dir().join(format!("rchat_topic_col_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE channels DROP COLUMN topic",
            "DELETE FROM settings WHERE key = 'profanity_channel_topics'",
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('old', 'Old', 'alice', 3)",
            "INSERT INTO channels(server, name, kind, slowmode_seconds, created_at, restrict_send) VALUES('old', 'chat', 'text', 30, 3, 1)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'talk', 'voice', 3)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert!(
            sqlx::query("SELECT topic FROM channels")
                .fetch_all(&db)
                .await
                .is_err()
        );
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            let rows = sqlx::query("SELECT name, kind, slowmode_seconds, restrict_send, topic FROM channels WHERE server = 'old' ORDER BY id")
                .fetch_all(&db)
                .await
                .expect("rows");
            let got: Vec<(String, String, i64, i64, Option<String>)> = rows
                .iter()
                .map(|r| {
                    (
                        r.try_get(0).expect("name"),
                        r.try_get(1).expect("kind"),
                        r.try_get(2).expect("slowmode"),
                        r.try_get(3).expect("restrict_send"),
                        r.try_get(4).expect("topic"),
                    )
                })
                .collect();
            assert_eq!(
                got,
                [
                    ("chat".into(), "text".into(), 30, 1, None),
                    ("talk".into(), "voice".into(), 0, 0, None),
                ]
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM settings WHERE key = 'profanity_channel_topics' AND value = '1'").await,
                1
            );
            close(&db).await;
        }
        let db = open(path.to_str()).await.expect("reopen");
        sqlx::query("UPDATE channels SET topic = 'hi' WHERE name = 'talk'")
            .execute(&db)
            .await
            .expect("write topic");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM channels WHERE topic = 'hi'").await,
            1
        );
        close(&db).await;
        wipe();
    }

    #[tokio::test]
    async fn existing_channels_keep_their_order_after_categories() {
        let path = std::env::temp_dir().join(format!("rchat_layout_col_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_channel_categories_server",
            "DROP TABLE channel_categories",
            "ALTER TABLE channels DROP COLUMN category_id",
            "ALTER TABLE channels DROP COLUMN position",
            "ALTER TABLE servers DROP COLUMN layout_version",
            "DELETE FROM settings WHERE key = 'profanity_category_names'",
            "UPDATE settings SET value = '2' WHERE key = 'schema_version'",
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('old', 'Old', 'alice', 3)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'talk', 'voice', 3)",
            "INSERT INTO channels(server, name, kind, created_at, topic) VALUES('old', 'chat', 'text', 3, 'hi')",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'music', 'voice', 3)",
            "INSERT INTO channels(server, name, kind, created_at, restrict_view) VALUES('old', 'staff', 'text', 3, 1)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            let rows = sqlx::query("SELECT name, kind, topic, restrict_view, category_id, position FROM channels WHERE server = 'old' ORDER BY position, id")
                .fetch_all(&db)
                .await
                .expect("rows");
            type Got = (String, String, Option<String>, i64, Option<i64>, i64);
            let got: Vec<Got> = rows
                .iter()
                .map(|r| {
                    (
                        r.try_get(0).expect("name"),
                        r.try_get(1).expect("kind"),
                        r.try_get(2).expect("topic"),
                        r.try_get(3).expect("restrict_view"),
                        r.try_get(4).expect("category"),
                        r.try_get(5).expect("position"),
                    )
                })
                .collect();
            assert_eq!(
                got,
                [
                    ("chat".into(), "text".into(), Some("hi".into()), 0, None, 0),
                    ("staff".into(), "text".into(), None, 1, None, 1),
                    ("talk".into(), "voice".into(), None, 0, None, 2),
                    ("music".into(), "voice".into(), None, 0, None, 3),
                ]
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM servers WHERE layout_version = 0").await,
                count(&db, "SELECT COUNT(*) FROM servers").await
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM channel_categories").await,
                0
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM settings WHERE key = 'profanity_category_names' AND value = '1'").await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
                )
                .await,
                SCHEMA_VERSION
            );
            close(&db).await;
        }
        let db = open(path.to_str()).await.expect("reopen");
        let id = count(&db, "INSERT INTO channel_categories(server, name, position, created_at) VALUES('old', 'Games', 0, 4) RETURNING id").await;
        sqlx::query("UPDATE channels SET category_id = $1 WHERE name = 'talk'")
            .bind(id)
            .execute(&db)
            .await
            .expect("move");
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM channels WHERE category_id IS NOT NULL"
            )
            .await,
            1
        );
        close(&db).await;
        wipe();
    }

    #[tokio::test]
    async fn existing_dms_start_open() {
        let path = std::env::temp_dir().join(format!("rchat_dm_closed_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE dms DROP COLUMN closed_a",
            "ALTER TABLE dms DROP COLUMN closed_b",
            "UPDATE settings SET value = '7' WHERE key = 'schema_version'",
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob')",
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'alice')",
            "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'bob', 'hi', 3)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM dms WHERE closed_a = 0 AND closed_b = 0"
                )
                .await,
                2
            );
            assert_eq!(
                count(&db, "SELECT last_message_id FROM dms WHERE id = 1").await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM messages WHERE dm_id = 1 AND content = 'hi'"
                )
                .await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
                )
                .await,
                SCHEMA_VERSION
            );
            close(&db).await;
        }
        let db = open(path.to_str()).await.expect("reopen");
        sqlx::query("UPDATE dms SET closed_a = 1 WHERE id = 1")
            .execute(&db)
            .await
            .expect("close");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM dms WHERE closed_a = 1").await,
            1
        );
        close(&db).await;
        wipe();
    }

    #[tokio::test]
    async fn existing_databases_get_blocks() {
        let path = std::env::temp_dir().join(format!("rchat_blocks_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_blocks_recent",
            "DROP INDEX idx_blocks_blocked",
            "DROP TABLE blocks",
            "UPDATE settings SET value = '8' WHERE key = 'schema_version'",
            "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('alice', 'Alice', '', 'text', 'identicon', 1)",
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob')",
            "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'bob', 'hi', 3)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(count(&db, "SELECT COUNT(*) FROM blocks").await, 0);
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_blocks_recent', 'idx_blocks_blocked')"
                )
                .await,
                2
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM messages WHERE dm_id = 1 AND content = 'hi'"
                )
                .await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM users WHERE username = 'alice'").await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
                )
                .await,
                SCHEMA_VERSION
            );
            close(&db).await;
        }
        let db = open(path.to_str()).await.expect("reopen");
        sqlx::query("INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 5)")
            .execute(&db)
            .await
            .expect("block");
        assert!(
            sqlx::query(
                "INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 6)"
            )
            .execute(&db)
            .await
            .is_err(),
            "one row per pair"
        );
        close(&db).await;
        wipe();
    }

    #[tokio::test]
    async fn existing_databases_get_friends() {
        let path = std::env::temp_dir().join(format!("rchat_friends_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_friends_friend",
            "DROP INDEX idx_friend_requests_in",
            "DROP INDEX idx_friend_requests_out",
            "DROP INDEX idx_friend_pings_user",
            "DROP TABLE friends",
            "DROP TABLE friend_requests",
            "DROP TABLE friend_pings",
            "DROP TABLE privacy",
            "UPDATE settings SET value = '9' WHERE key = 'schema_version'",
            "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('alice', 'Alice', '', 'text', 'identicon', 1)",
            "INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 2)",
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob')",
            "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'bob', 'hi', 3)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            for table in ["friends", "friend_requests", "friend_pings", "privacy"] {
                assert_eq!(
                    count(&db, &format!("SELECT COUNT(*) FROM {table}")).await,
                    0,
                    "{table}"
                );
            }
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_friends_friend', 'idx_friend_requests_in', 'idx_friend_requests_out', 'idx_friend_pings_user')"
                )
                .await,
                4
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM messages WHERE dm_id = 1 AND content = 'hi'"
                )
                .await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM blocks WHERE blocker = 'alice'").await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
                )
                .await,
                SCHEMA_VERSION
            );
            close(&db).await;
        }
        let db = open(path.to_str()).await.expect("reopen");
        sqlx::query("INSERT INTO privacy(username) VALUES('alice')")
            .execute(&db)
            .await
            .expect("privacy");
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM privacy WHERE dms = 'everyone' AND friend_requests = 'everyone'"
            )
            .await,
            1,
            "defaults"
        );
        for bad in [
            "UPDATE privacy SET dms = 'nobody'",
            "UPDATE privacy SET friend_requests = 'friends'",
            "INSERT INTO friend_pings(username, kind, actor, created_at) VALUES('alice', 'mention', 'bob', 1)",
        ] {
            assert!(sqlx::query(bad).execute(&db).await.is_err(), "{bad}");
        }
        sqlx::query(
            "INSERT INTO friend_requests(sender, recipient, created_at) VALUES('bob', 'alice', 5)",
        )
        .execute(&db)
        .await
        .expect("request");
        assert!(
            sqlx::query("INSERT INTO friend_requests(sender, recipient, created_at) VALUES('bob', 'alice', 6)")
                .execute(&db)
                .await
                .is_err(),
            "one request per pair"
        );
        close(&db).await;
        wipe();
    }

    #[tokio::test]
    async fn existing_databases_get_polls() {
        let path = std::env::temp_dir().join(format!("rchat_polls_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_polls_due",
            "DROP INDEX idx_poll_options_message",
            "DROP INDEX idx_poll_votes_option",
            "DROP INDEX idx_poll_votes_voter",
            "DROP TABLE poll_votes",
            "DROP TABLE poll_options",
            "DROP TABLE poll_snapshots",
            "DROP TABLE polls",
            "UPDATE settings SET value = '10' WHERE key = 'schema_version'",
            "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('alice', 'Alice', '', 'text', 'identicon', 1)",
            "INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'alice', 'old message', 3 FROM channels WHERE server = 'rchat'",
            "INSERT INTO reactions(message_id, username, emoji, created_at) SELECT id, 'alice', 'x', 4 FROM messages",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            for table in ["polls", "poll_options", "poll_votes", "poll_snapshots"] {
                assert_eq!(
                    count(&db, &format!("SELECT COUNT(*) FROM {table}")).await,
                    0,
                    "{table}"
                );
            }
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_polls_due', 'idx_poll_options_message', 'idx_poll_votes_option', 'idx_poll_votes_voter')"
                )
                .await,
                4
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE content = 'old message' AND kind = 'user' AND created_at = 3").await,
                1
            );
            assert_eq!(count(&db, "SELECT COUNT(*) FROM reactions").await, 1);
            assert_eq!(
                count(
                    &db,
                    "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
                )
                .await,
                SCHEMA_VERSION
            );
            close(&db).await;
        }
        let db = open(path.to_str()).await.expect("reopen");
        let id = count(&db, "SELECT id FROM messages").await;
        sqlx::query("INSERT INTO polls(message_id, kind, question, created_at) VALUES($1, 'single', 'q', 5)")
            .bind(id)
            .execute(&db)
            .await
            .expect("poll");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM polls WHERE anonymous = 0 AND results = 'always' AND allow_change = 1 AND allow_add = 0 AND min_choices = 1 AND max_choices = 1 AND closes_at IS NULL AND closed_at IS NULL AND version = 0").await,
            1,
            "defaults"
        );
        for bad in [
            "UPDATE polls SET kind = 'other'",
            "UPDATE polls SET results = 'never'",
            "INSERT INTO polls(message_id, kind, question, created_at) VALUES(999999, 'single', 'q', 5)",
        ] {
            assert!(sqlx::query(bad).execute(&db).await.is_err(), "{bad}");
        }
        sqlx::query("INSERT INTO poll_votes(message_id, voter, option_id, value, created_at) VALUES($1, 'alice', 1, 1, 6)")
            .bind(id)
            .execute(&db)
            .await
            .expect("vote");
        sqlx::query("DELETE FROM messages WHERE id = $1")
            .bind(id)
            .execute(&db)
            .await
            .expect("delete");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM polls").await, 0, "cascade");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM poll_votes").await,
            0,
            "cascade"
        );
        for stmt in [
            "DROP INDEX idx_polls_due",
            "DROP TABLE polls",
            "CREATE TABLE polls(message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('single','multiple','ranked','rating','yes_no')), question TEXT NOT NULL, anonymous INTEGER NOT NULL DEFAULT 0, results TEXT NOT NULL DEFAULT 'always' CHECK(results IN ('always','after_vote','after_close')), allow_change INTEGER NOT NULL DEFAULT 1, allow_add INTEGER NOT NULL DEFAULT 0, min_choices INTEGER NOT NULL DEFAULT 1, max_choices INTEGER NOT NULL DEFAULT 1, scale INTEGER, closes_at INTEGER, closed_at INTEGER, closed_by TEXT, created_at INTEGER NOT NULL)",
            "INSERT INTO messages(channel_id, author, content, kind, created_at) SELECT id, 'alice', 'q', 'poll', 7 FROM channels WHERE server = 'rchat'",
            "INSERT INTO polls(message_id, kind, question, created_at) SELECT MAX(id), 'single', 'q', 7 FROM messages",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("add version");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM polls WHERE version = 0").await,
                1,
                "version"
            );
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn existing_users_get_an_empty_bio_column() {
        let path = std::env::temp_dir().join(format!("rchat_bio_col_{}.db", std::process::id()));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE users DROP COLUMN bio",
            "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('old', 'old', '', 'text', 'identicon', 1)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert!(
            sqlx::query("SELECT bio FROM users")
                .fetch_all(&db)
                .await
                .is_err()
        );
        close(&db).await;
        let db = open(path.to_str()).await.expect("reopen");
        let old = get_user(&db, "old").await.expect("load").expect("old");
        assert_eq!(old.bio, None);
        sqlx::query("UPDATE users SET bio = 'hi' WHERE username = 'old'")
            .execute(&db)
            .await
            .expect("write bio");
        let old = get_user(&db, "old").await.expect("load").expect("old");
        assert_eq!(old.bio.as_deref(), Some("hi"));
        close(&db).await;
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[tokio::test]
    async fn existing_servers_get_empty_color_columns() {
        let path =
            std::env::temp_dir().join(format!("rchat_server_colors_{}.db", std::process::id()));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE servers DROP COLUMN banner_color",
            "ALTER TABLE servers DROP COLUMN name_color",
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('old', 'Old', NULL, 1)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert!(
            sqlx::query("SELECT banner_color FROM servers")
                .fetch_all(&db)
                .await
                .is_err()
        );
        close(&db).await;
        let db = open(path.to_str()).await.expect("reopen");
        let row = sqlx::query("SELECT banner_color, name_color FROM servers WHERE name = 'old'")
            .fetch_one(&db)
            .await
            .expect("colors");
        assert_eq!(row.try_get::<Option<String>, _>(0).expect("banner"), None);
        assert_eq!(row.try_get::<Option<String>, _>(1).expect("name"), None);
        sqlx::query("UPDATE servers SET banner_color = '#123456', name_color = '#abcdef' WHERE name = 'old'")
            .execute(&db)
            .await
            .expect("write colors");
        close(&db).await;
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[tokio::test]
    async fn an_interrupted_migration_still_backfills_on_the_next_boot() {
        let path = std::env::temp_dir().join(format!("rchat_migrate_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP TRIGGER messages_dm_latest_insert",
            "DROP TRIGGER messages_dm_latest_delete",
            "DROP INDEX idx_dms_a_latest",
            "DROP INDEX idx_dms_b_latest",
            "ALTER TABLE dms DROP COLUMN last_message_id",
            "INSERT INTO dms(user_a, user_b) VALUES('a', 'b')",
            "INSERT INTO messages(dm_id, author, content, created_at) VALUES(1, 'a', 'x', 1)",
            "CREATE TABLE idx_dms_a_latest(x INTEGER)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        assert!(open(path.to_str()).await.is_err());
        let raw = AnyPoolOptions::new()
            .max_connections(1)
            .connect(&format!("sqlite://{}", path.display()))
            .await
            .expect("raw");
        let cols = sqlx::query("SELECT name FROM pragma_table_info('dms')")
            .fetch_all(&raw)
            .await
            .expect("columns");
        assert!(!cols.iter().any(|r| {
            r.try_get::<String, _>(0)
                .is_ok_and(|c| c == "last_message_id")
        }));
        sqlx::query("DROP TABLE idx_dms_a_latest")
            .execute(&raw)
            .await
            .expect("unblock");
        raw.close().await;
        let db = open(path.to_str()).await.expect("reopen");
        assert_eq!(
            count(&db, "SELECT last_message_id FROM dms WHERE id = 1").await,
            1
        );
        close(&db).await;
        wipe();
    }

    #[tokio::test]
    async fn guest_grant_networks_migrate_onto_an_old_database() {
        let path = std::env::temp_dir().join(format!(
            "rchat_grant_network_upgrade_{}.db",
            std::process::id()
        ));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_guest_grants_network",
            "ALTER TABLE guest_grants DROP COLUMN network",
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 1)",
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at, password_id) VALUES('h:old', 'club', 1, 7, 3)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM guest_grants WHERE \"grant\" = 'h:old' AND server = 'club' AND created_at = 1 AND last_used_at = 7 AND password_id = 3 AND network IS NULL").await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_guest_grants_network'").await,
                1
            );
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn call_log_kinds_migrate_onto_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_call_kind_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE messages DROP COLUMN call_kind",
            "ALTER TABLE messages DROP COLUMN call_video",
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob')",
            "INSERT INTO messages(dm_id, author, content, kind, call_answered_at, call_ended_at, call_outcome, created_at) VALUES(1, 'alice', '', 'call', 5, 9, 'completed', 4)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE kind = 'call' AND call_answered_at = 5 AND call_ended_at = 9 AND call_outcome = 'completed' AND call_kind IS NULL AND call_video IS NULL").await,
                1
            );
            sqlx::query("INSERT INTO messages(dm_id, author, content, kind, call_kind, call_video, created_at) VALUES(1, 'bob', '', 'call', 'p2p', 1, 10)")
                .execute(&db)
                .await
                .expect("new log");
            close(&db).await;
        }
        let db = open(path.to_str()).await.expect("reopen");
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM messages WHERE call_kind = 'p2p' AND call_video = 1"
            )
            .await,
            2
        );
        close(&db).await;
        wipe();
    }

    #[tokio::test]
    async fn server_passwords_migrate_onto_an_old_database() {
        let path = std::env::temp_dir().join(format!("rchat_pw_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_guest_grants_password",
            "DROP INDEX idx_server_passwords_server",
            "DROP TABLE server_passwords",
            "ALTER TABLE members DROP COLUMN joined_via",
            "ALTER TABLE guest_grants DROP COLUMN password_id",
            "DELETE FROM settings WHERE key = 'password_pepper'",
            "DELETE FROM settings WHERE key = 'relay_secret'",
            "DELETE FROM settings WHERE key = 'p2p_secret'",
            "UPDATE settings SET value = 'old-instance' WHERE key = 'instance_id'",
            "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('club', 'Club', 'alice', 'hash', 1)",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('club', 'alice', 1, 0, 5)",
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g', 'club', 1, 1)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        let mut peppers = Vec::new();
        let mut relays = Vec::new();
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM members WHERE server = 'club' AND username = 'alice' AND joined_via IS NULL AND joined_at = 5 AND is_admin = 1").await,
                1
            );
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM guest_grants WHERE \"grant\" = '{}' AND password_id IS NULL AND last_used_at = 1", secret_key("g"))).await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM servers WHERE name = 'club' AND password_hash = 'hash' AND member_count = 1").await,
                1
            );
            assert_eq!(count(&db, "SELECT COUNT(*) FROM server_passwords").await, 0);
            sqlx::query("INSERT INTO server_passwords(server, hash, lookup, created_at) VALUES('club', 'h', 'l', 1)")
                .execute(&db)
                .await
                .expect("new table");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM server_passwords WHERE uses = 0 AND label IS NULL AND expires_at IS NULL AND max_uses IS NULL AND revoked_at IS NULL AND used_up_at IS NULL").await,
                1
            );
            sqlx::query("DELETE FROM server_passwords")
                .execute(&db)
                .await
                .expect("clear");
            let instance: String =
                sqlx::query("SELECT value FROM settings WHERE key = 'instance_id'")
                    .fetch_one(&db)
                    .await
                    .expect("instance")
                    .try_get(0)
                    .expect("value");
            assert_eq!(instance, "old-instance");
            let p = pepper(&db).await.expect("pepper");
            assert_eq!(p.len(), 64);
            peppers.push(p);
            let relay: String =
                sqlx::query("SELECT value FROM settings WHERE key = 'relay_secret'")
                    .fetch_one(&db)
                    .await
                    .expect("relay secret")
                    .try_get(0)
                    .expect("value");
            assert_eq!(relay.len(), 64);
            let p2p: String = sqlx::query("SELECT value FROM settings WHERE key = 'p2p_secret'")
                .fetch_one(&db)
                .await
                .expect("p2p secret")
                .try_get(0)
                .expect("value");
            assert_eq!(p2p.len(), 64);
            assert_ne!(p2p, relay);
            relays.push(format!("{relay}{p2p}"));
            close(&db).await;
        }
        assert_eq!(peppers[0], peppers[1], "the pepper is inserted once");
        assert_eq!(
            relays[0], relays[1],
            "the relay and P2P secrets are inserted once"
        );
        wipe();
    }

    #[tokio::test]
    async fn config_shares_table_is_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_share_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_config_shares_owner",
            "DROP INDEX idx_config_shares_expires",
            "DROP TABLE config_shares",
            "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, appear_offline, created_at) VALUES('alice', 'Alice', 'h', 'text', 'identicon', 1, 5)",
            "INSERT INTO tokens(token, username, created_at) VALUES('tok', 'alice', 5)",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'config_shares'"
            )
            .await,
            0
        );
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM users WHERE username = 'alice' AND appear_offline = 1 AND created_at = 5").await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    &format!(
                        "SELECT COUNT(*) FROM tokens WHERE token = '{}' AND username = 'alice'",
                        secret_key("tok")
                    )
                )
                .await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old' AND created_at = 7").await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_config_shares_%'").await,
                2
            );
            sqlx::query("INSERT INTO config_shares(id, owner, blob, created_at, expires_at) VALUES('abcdefghijkl', 'alice', 'rc1.x', 1, 2)")
                .execute(&db)
                .await
                .expect("new table");
            assert!(
                sqlx::query("INSERT INTO config_shares(id, owner, blob, created_at, expires_at) VALUES('abcdefghijkl', 'bob', 'rc1.y', 1, 2)")
                    .execute(&db)
                    .await
                    .is_err(),
                "id is the primary key"
            );
            sqlx::query("DELETE FROM config_shares")
                .execute(&db)
                .await
                .expect("clear");
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn group_mentions_are_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_group_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_group_pings_channel",
            "DROP INDEX idx_group_pings_message",
            "DROP INDEX idx_group_pings_created",
            "DROP INDEX idx_group_pings_role",
            "DROP INDEX idx_group_pings_server",
            "DROP INDEX idx_here_pings_ping",
            "DROP TABLE here_pings",
            "DROP TABLE group_pings",
            "ALTER TABLE roles DROP COLUMN mentionable",
            "ALTER TABLE messages DROP COLUMN group_mentions",
            "UPDATE settings SET value = '3' WHERE key = 'schema_version'",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'all', 1, 31, 1)",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'kick', 1, 4, 1)",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'plain', 0, 31, 1)",
            "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'old', '#ffffff', 31)",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'all', 'old @everyone', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'all' AND content = 'old @everyone' AND created_at = 7 AND group_mentions IS NULL").await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM roles WHERE name = 'old' AND perms = 31 AND mentionable = 0").await,
                1
            );
            assert_eq!(
                count(&db, "SELECT perms FROM members WHERE username = 'all'").await,
                ALL_PERMS
            );
            assert_eq!(
                count(&db, "SELECT perms FROM members WHERE username = 'kick'").await,
                4
            );
            assert_eq!(
                count(&db, "SELECT perms FROM members WHERE username = 'plain'").await,
                31
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND (name LIKE 'idx_group_pings_%' OR name = 'idx_here_pings_ping')").await,
                6
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
                )
                .await,
                SCHEMA_VERSION
            );
            sqlx::query("INSERT INTO group_pings(message_id, channel_id, server, kind, actor, created_at) SELECT id, channel_id, 'rchat', 'everyone', 'all', 7 FROM messages WHERE author = 'all'")
                .execute(&db)
                .await
                .expect("new table");
            assert!(
                sqlx::query("INSERT INTO group_pings(message_id, channel_id, server, kind, actor, created_at) SELECT id, channel_id, 'rchat', 'nobody', 'all', 7 FROM messages WHERE author = 'all'")
                    .execute(&db)
                    .await
                    .is_err(),
                "kind is checked"
            );
            sqlx::query(
                "INSERT INTO here_pings(ping_id, username) SELECT id, 'kick' FROM group_pings",
            )
            .execute(&db)
            .await
            .expect("here");
            sqlx::query("DELETE FROM group_pings")
                .execute(&db)
                .await
                .expect("clear");
            assert_eq!(count(&db, "SELECT COUNT(*) FROM here_pings").await, 0);
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn audit_log_is_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_audit_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_audit_log_server",
            "DROP INDEX idx_audit_log_action",
            "DROP INDEX idx_audit_log_actor",
            "DROP INDEX idx_audit_log_created",
            "DROP TABLE audit_channels",
            "DROP TABLE audit_log",
            "UPDATE settings SET value = '4' WHERE key = 'schema_version'",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'all', 1, 63, 1)",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'zero', 1, 0, 1)",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'kick', 1, 4, 1)",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'plain', 0, 63, 1)",
            "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'old', '#ffffff', 63)",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'all', 'old', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'all' AND content = 'old' AND created_at = 7").await,
                1
            );
            for (name, perms) in [("all", ALL_PERMS), ("zero", 0), ("kick", 4), ("plain", 63)] {
                assert_eq!(
                    count(
                        &db,
                        &format!("SELECT perms FROM members WHERE username = '{name}'")
                    )
                    .await,
                    perms,
                    "{name}"
                );
            }
            assert_eq!(
                count(&db, "SELECT perms FROM roles WHERE name = 'old'").await,
                63
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_audit_log_%'").await,
                4
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
                )
                .await,
                SCHEMA_VERSION
            );
            sqlx::query("INSERT INTO audit_log(server, action, created_at) VALUES('rchat', 'member.kick', 1)")
                .execute(&db)
                .await
                .expect("new table");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM audit_log WHERE actor IS NULL AND staff = 0 AND target_staff = 0 AND details = '{}' AND target_kind IS NULL").await,
                1
            );
            sqlx::query(
                "INSERT INTO audit_channels(entry_id, channel_id) SELECT id, 5 FROM audit_log",
            )
            .execute(&db)
            .await
            .expect("channel refs");
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM audit_channels WHERE channel_id = 5 AND private = 0"
                )
                .await,
                1
            );
            assert!(
                sqlx::query("INSERT INTO audit_log(server, action, created_at) VALUES('nowhere', 'member.kick', 1)")
                    .execute(&db)
                    .await
                    .is_err(),
                "server is a foreign key"
            );
            sqlx::query("DELETE FROM audit_log")
                .execute(&db)
                .await
                .expect("clear");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM audit_channels").await,
                0,
                "channel refs go with their entry"
            );
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn timeouts_are_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_timeout_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_member_timeouts_until",
            "DROP TABLE member_timeouts",
            "UPDATE settings SET value = '6' WHERE key = 'schema_version'",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'all', 1, 127, 1)",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'zero', 1, 0, 1)",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'kick', 1, 4, 1)",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('rchat', 'plain', 0, 127, 1)",
            "INSERT INTO roles(server, name, color, perms) VALUES('rchat', 'old', '#ffffff', 127)",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'all', 'old', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'all' AND content = 'old' AND created_at = 7").await,
                1
            );
            for (name, perms) in [("all", 255), ("zero", 0), ("kick", 4), ("plain", 127)] {
                assert_eq!(
                    count(
                        &db,
                        &format!("SELECT perms FROM members WHERE username = '{name}'")
                    )
                    .await,
                    perms,
                    "{name}"
                );
            }
            assert_eq!(
                count(&db, "SELECT perms FROM roles WHERE name = 'old'").await,
                127
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_member_timeouts_until'").await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
                )
                .await,
                SCHEMA_VERSION
            );
            sqlx::query("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('rchat', 'plain', 9, 1)")
                .execute(&db)
                .await
                .expect("new table");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM member_timeouts WHERE reason IS NULL AND set_by IS NULL AND until = 9").await,
                1
            );
            assert!(
                sqlx::query("INSERT INTO member_timeouts(server, username, until, created_at) VALUES('nowhere', 'plain', 9, 1)")
                    .execute(&db)
                    .await
                    .is_err(),
                "server is a foreign key"
            );
            sqlx::query("DELETE FROM member_timeouts")
                .execute(&db)
                .await
                .expect("clear");
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn pings_table_is_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_ping_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_pings_user",
            "DROP INDEX idx_pings_message",
            "DROP INDEX idx_pings_created",
            "DROP INDEX idx_pings_seen",
            "DROP INDEX idx_pings_actor",
            "DROP TABLE pings",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'hi @bob', 7)",
            "INSERT INTO read_state(username, scope, last_read) VALUES('bob', 'c1', 3)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'pings'"
            )
            .await,
            0
        );
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'hi @bob' AND created_at = 7").await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM read_state WHERE username = 'bob' AND last_read = 3"
                )
                .await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_pings_%'").await,
                6
            );
            sqlx::query("INSERT INTO pings(username, kind, scope, server, message_id, actor, created_at) SELECT 'bob', 'mention', 'c' || channel_id, 'rchat', id, 'alice', 8 FROM messages WHERE author = 'alice'")
                .execute(&db)
                .await
                .expect("ping on an old message");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM pings WHERE seen = 0 AND emoji IS NULL AND thread_root_id IS NULL AND kind = 'mention'").await,
                1
            );
            assert!(
                sqlx::query("INSERT INTO pings(username, kind, scope, message_id, actor, created_at) VALUES('bob', 'other', 'c1', 1, 'alice', 8)")
                    .execute(&db)
                    .await
                    .is_err(),
                "kind is checked"
            );
            sqlx::query("DELETE FROM pings")
                .execute(&db)
                .await
                .expect("clear");
            close(&db).await;
        }
        let db = open(path.to_str()).await.expect("reopen");
        for stmt in [
            "DROP TABLE pings",
            "CREATE TABLE pings(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('mention','reply','reaction')), scope TEXT NOT NULL, server TEXT REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, actor TEXT NOT NULL, emoji TEXT, created_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0)",
            "INSERT INTO pings(username, kind, scope, message_id, actor, created_at) SELECT 'bob', 'mention', 'c1', id, 'alice', 9 FROM messages WHERE author = 'alice'",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("add thread_root_id");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM pings WHERE created_at = 9 AND thread_root_id IS NULL AND seen = 0").await,
                1,
                "a pings table without thread_root_id gains the column"
            );
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn edited_at_is_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_edit_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE messages DROP COLUMN edited_at",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'edited_at'"
            )
            .await,
            0
        );
        close(&db).await;
        for round in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'edited_at'"
                )
                .await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND created_at = 7"
                )
                .await,
                1
            );
            let old: i64 =
                sqlx::query("SELECT id FROM messages WHERE author = 'alice' AND created_at = 7")
                    .fetch_one(&db)
                    .await
                    .expect("old")
                    .try_get(0)
                    .expect("id");
            let loaded =
                crate::api::messages::load_message(&db, old, crate::api::messages::Quotes::Skip)
                    .await
                    .expect("load")
                    .expect("old message");
            match round {
                0 => {
                    assert_eq!(loaded.content, "old message");
                    assert_eq!(loaded.edited_at, None);
                    sqlx::query(
                        "UPDATE messages SET content = 'edited old', edited_at = 9 WHERE id = $1",
                    )
                    .bind(old)
                    .execute(&db)
                    .await
                    .expect("edit an old message");
                }
                _ => {
                    assert_eq!(loaded.content, "edited old");
                    assert_eq!(loaded.edited_at, Some(9), "the edit survives a restart");
                }
            }
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn forward_columns_are_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_fwd_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let cols = "('fwd_author', 'fwd_created_at', 'fwd_source_id', 'fwd_origin', 'fwd_dropped')";
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_messages_fwd_author",
            "ALTER TABLE messages DROP COLUMN fwd_author",
            "ALTER TABLE messages DROP COLUMN fwd_created_at",
            "ALTER TABLE messages DROP COLUMN fwd_source_id",
            "ALTER TABLE messages DROP COLUMN fwd_origin",
            "ALTER TABLE messages DROP COLUMN fwd_dropped",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        let present =
            format!("SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name IN {cols}");
        assert_eq!(count(&db, &present).await, 0);
        close(&db).await;
        for round in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(count(&db, &present).await, 5);
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_messages_fwd_author'"
                )
                .await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old message' AND created_at = 7 AND fwd_author IS NULL AND fwd_created_at IS NULL AND fwd_source_id IS NULL AND fwd_origin IS NULL AND fwd_dropped IS NULL").await,
                1
            );
            let old: i64 = sqlx::query("SELECT id FROM messages WHERE content = 'old message'")
                .fetch_one(&db)
                .await
                .expect("old")
                .try_get(0)
                .expect("id");
            let loaded =
                crate::api::messages::load_message(&db, old, crate::api::messages::Quotes::Skip)
                    .await
                    .expect("load")
                    .expect("old message");
            assert!(loaded.forward.is_none());
            if round == 0 {
                sqlx::query("INSERT INTO messages(channel_id, author, content, fwd_author, fwd_created_at, fwd_source_id, fwd_origin, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'bob', 'old message', 'alice', 7, $1, '#general · RChat', 8)")
                    .bind(old)
                    .execute(&db)
                    .await
                    .expect("forward an old message");
            }
            let copy: i64 = sqlx::query("SELECT id FROM messages WHERE author = 'bob'")
                .fetch_one(&db)
                .await
                .expect("copy")
                .try_get(0)
                .expect("id");
            let fwd =
                crate::api::messages::load_message(&db, copy, crate::api::messages::Quotes::Skip)
                    .await
                    .expect("load")
                    .expect("copy")
                    .forward
                    .expect("forward survives a restart");
            assert_eq!((fwd.source_id, fwd.created_at), (old, 7));
            assert_eq!(fwd.origin.as_deref(), Some("#general - RChat"));
            assert_eq!(fwd.origin_channel.as_deref(), Some("general"));
            assert_eq!(fwd.origin_server.as_deref(), Some("RChat"));
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn pin_columns_are_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_pin_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let cols = "('pinned_at', 'pinned_by', 'pin_message_id')";
        let indexes = "('idx_messages_channel_pins', 'idx_messages_dm_pins')";
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_messages_channel_pins",
            "DROP INDEX idx_messages_dm_pins",
            "DROP INDEX idx_messages_pin_notice",
            "ALTER TABLE messages DROP COLUMN pinned_at",
            "ALTER TABLE messages DROP COLUMN pinned_by",
            "ALTER TABLE messages DROP COLUMN pin_message_id",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        let present =
            format!("SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name IN {cols}");
        let indexed = format!("SELECT COUNT(*) FROM sqlite_master WHERE name IN {indexes}");
        assert_eq!(count(&db, &present).await, 0);
        assert_eq!(count(&db, &indexed).await, 0);
        close(&db).await;
        for round in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(count(&db, &present).await, 3);
            assert_eq!(count(&db, &indexed).await, 2);
            let old: i64 = sqlx::query("SELECT id FROM messages WHERE content = 'old message'")
                .fetch_one(&db)
                .await
                .expect("old")
                .try_get(0)
                .expect("id");
            if round == 0 {
                assert_eq!(
                    count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old message' AND created_at = 7 AND kind = 'user' AND pinned_at IS NULL AND pinned_by IS NULL AND pin_message_id IS NULL").await,
                    1
                );
                let loaded = crate::api::messages::load_message(
                    &db,
                    old,
                    crate::api::messages::Quotes::Skip,
                )
                .await
                .expect("load")
                .expect("old message");
                assert_eq!((loaded.pinned_at, loaded.pin_message_id), (None, None));
                sqlx::query(
                    "UPDATE messages SET pinned_at = 9000, pinned_by = 'bob' WHERE id = $1",
                )
                .bind(old)
                .execute(&db)
                .await
                .expect("pin an old message");
                sqlx::query("INSERT INTO messages(channel_id, author, content, kind, pin_message_id, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'bob', '', 'pin', $1, 9)")
                    .bind(old)
                    .execute(&db)
                    .await
                    .expect("pin notice");
            }
            let loaded =
                crate::api::messages::load_message(&db, old, crate::api::messages::Quotes::Skip)
                    .await
                    .expect("load")
                    .expect("old message");
            assert_eq!(loaded.content, "old message");
            assert_eq!(loaded.pinned_at, Some(9), "the pin survives a restart");
            let notice: i64 = sqlx::query("SELECT id FROM messages WHERE kind = 'pin'")
                .fetch_one(&db)
                .await
                .expect("notice")
                .try_get(0)
                .expect("id");
            let notice =
                crate::api::messages::load_message(&db, notice, crate::api::messages::Quotes::Skip)
                    .await
                    .expect("load")
                    .expect("notice");
            assert_eq!(notice.pin_message_id, Some(old));
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn system_message_columns_are_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_system_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let cols = "('system_channel_id', 'join_messages', 'leave_messages')";
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_messages_system",
            "ALTER TABLE servers DROP COLUMN system_channel_id",
            "ALTER TABLE servers DROP COLUMN join_messages",
            "ALTER TABLE servers DROP COLUMN leave_messages",
            "INSERT INTO servers(name, display_name, creator, banner_color, created_at) VALUES('old', 'Old', 'alice', '#123456', 3)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'talk', 'voice', 3)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'chat', 'text', 3)",
            "INSERT INTO members(server, username, is_admin, joined_at) VALUES('old', 'alice', 1, 3)",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE name = 'chat'), 'alice', 'old message', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        let present =
            format!("SELECT COUNT(*) FROM pragma_table_info('servers') WHERE name IN {cols}");
        let indexed = "SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_messages_system'";
        assert_eq!(count(&db, &present).await, 0);
        assert_eq!(count(&db, indexed).await, 0);
        close(&db).await;
        for round in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(count(&db, &present).await, 3);
            assert_eq!(count(&db, indexed).await, 1);
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM servers WHERE system_channel_id IS NULL AND join_messages = 1 AND leave_messages = 1").await,
                2,
                "existing servers default to on, in the default channel"
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM servers WHERE name = 'old' AND display_name = 'Old' AND creator = 'alice' AND banner_color = '#123456' AND created_at = 3").await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE content = 'old message' AND kind = 'user' AND created_at = 7").await,
                1
            );
            if round == 0 {
                let mut conn = db.acquire().await.expect("conn");
                let posted = crate::api::system_messages::post_system(
                    &mut conn,
                    "old",
                    "bob",
                    crate::api::system_messages::SystemKind::Join,
                )
                .await
                .expect("post");
                assert!(posted.is_some());
            }
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.name = 'chat' AND m.kind = 'join' AND m.author = 'bob' AND m.content = ''").await,
                1,
                "the join goes to the first text channel and survives a restart"
            );
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn channel_restrictions_are_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_restrict_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let cols = "('restrict_view', 'restrict_send')";
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE channels DROP COLUMN restrict_view",
            "ALTER TABLE channels DROP COLUMN restrict_send",
            "DELETE FROM settings WHERE key = 'restrict_backfill_v1'",
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('old', 'Old', 'alice', 3)",
            "INSERT INTO channels(server, name, kind, slowmode_seconds, created_at) VALUES('old', 'open', 'text', 30, 3)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'private', 'text', 3)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'talk', 'voice', 3)",
            "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES((SELECT id FROM channels WHERE name = 'private'), 'u:bob', 1, 0, 1)",
            "INSERT INTO members(server, username, is_admin, joined_at) VALUES('old', 'alice', 1, 3)",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE name = 'private'), 'alice', 'old secret', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        let present =
            format!("SELECT COUNT(*) FROM pragma_table_info('channels') WHERE name IN {cols}");
        assert_eq!(count(&db, &present).await, 0);
        close(&db).await;
        for round in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(count(&db, &present).await, 2);
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM channels WHERE restrict_send = 0").await,
                4
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM channels WHERE restrict_view = 0 AND name IN ('general', 'open', 'talk')").await,
                3,
                "channels without rules stay open"
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM channels WHERE name = 'private' AND restrict_view = 1"
                )
                .await,
                1 - round,
                "channels that had rules stay private; the backfill runs once"
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM channels WHERE name = 'open' AND slowmode_seconds = 30 AND created_at = 3").await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM channel_perms WHERE subject = 'u:bob' AND can_view = 1 AND can_send = 0").await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM messages WHERE content = 'old secret' AND created_at = 7"
                )
                .await,
                1
            );
            if round == 0 {
                let cid = count(&db, "SELECT id FROM channels WHERE name = 'private'").await;
                let rows = sqlx::query("SELECT subject, can_view, can_send, can_read_history FROM channel_perms WHERE channel_id = $1")
                    .bind(cid)
                    .fetch_all(&db)
                    .await
                    .expect("rules");
                let rows = rows
                    .iter()
                    .map(|r| perm_row(r, 0))
                    .collect::<sqlx::Result<Vec<_>>>()
                    .expect("rows");
                let restrict = Restrict {
                    view: true,
                    send: false,
                };
                let carol = fold_access(&rows, &["u:carol".to_string()], false, restrict);
                let bob = fold_access(&rows, &["u:bob".to_string()], false, restrict);
                assert!(!carol.view, "the old private channel is still hidden");
                assert!(bob.view && !bob.send && bob.history);
                sqlx::query("UPDATE channels SET restrict_view = 0 WHERE name = 'private'")
                    .execute(&db)
                    .await
                    .expect("admin opens it");
            }
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn p2p_hashes_and_the_p2p_switch_are_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_p2p_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE messages DROP COLUMN media_sha256",
            "DELETE FROM settings WHERE key = 'p2p_attachments'",
            "INSERT INTO settings(key, value) VALUES('asset_uploads', '0') ON CONFLICT(key) DO UPDATE SET value = '0'",
            "INSERT INTO messages(author, content, media_id, media_filename, media_kind, media_hoster, media_size, media_mime, created_at) VALUES('alice', 'old file', 'ab', 'a.png', 'p2p', 'alice', 3, 'image/png', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        let present =
            "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'media_sha256'";
        assert_eq!(count(&db, present).await, 0);
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(count(&db, present).await, 1);
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE content = 'old file' AND media_id = 'ab' AND media_kind = 'p2p' AND media_size = 3 AND media_sha256 IS NULL AND created_at = 7").await,
                1,
                "old P2P rows stay, without a hash (unverified)"
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM settings WHERE key = 'p2p_attachments' AND value = '1'"
                )
                .await,
                1,
                "P2P attachments are on after an upgrade"
            );
            let settings = crate::api::Settings::load(&db).await;
            assert!(settings.p2p_attachments && !settings.asset_uploads && !settings.text_only());
            close(&db).await;
        }
        wipe();
    }

    #[test]
    fn switch_seeds_are_on_unless_turned_off() {
        for (value, on) in [
            (None, true),
            (Some("true"), true),
            (Some("on"), true),
            (Some(" OFF "), false),
            (Some("false"), false),
            (Some("0"), false),
            (Some("no"), false),
        ] {
            assert_eq!(crate::api::switch_seed(value), on, "{value:?}");
        }
    }

    #[tokio::test]
    async fn restrict_backfill_survives_an_interrupted_upgrade() {
        let path =
            std::env::temp_dir().join(format!("rchat_restrict_marker_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let marker = "SELECT COUNT(*) FROM settings WHERE key = 'restrict_backfill_v1'";
        let private = "SELECT restrict_view FROM channels WHERE name = 'private'";
        let db = open(path.to_str()).await.expect("open");
        assert_eq!(count(&db, marker).await, 1, "a fresh database is marked");
        for stmt in [
            "DELETE FROM settings WHERE key = 'restrict_backfill_v1'",
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('old', 'Old', 'alice', 3)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'open', 'text', 3)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('old', 'private', 'text', 3)",
            "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES((SELECT id FROM channels WHERE name = 'private'), 'u:bob', 1, 0, 1)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert_eq!(count(&db, private).await, 0, "column added, backfill lost");
        close(&db).await;
        let db = open(path.to_str()).await.expect("reboot");
        assert_eq!(
            count(&db, private).await,
            1,
            "the missing marker runs the backfill"
        );
        assert_eq!(
            count(
                &db,
                "SELECT restrict_view FROM channels WHERE name = 'open'"
            )
            .await,
            0
        );
        assert_eq!(count(&db, marker).await, 1);
        sqlx::query("UPDATE channels SET restrict_view = 0 WHERE name = 'private'")
            .execute(&db)
            .await
            .expect("admin opens it");
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("later boot");
            assert_eq!(count(&db, private).await, 0, "the admin's opening survives");
            assert_eq!(count(&db, marker).await, 1);
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn the_sweep_keeps_the_newest_seen_pings_of_recipients_above_the_cap() {
        let path = std::env::temp_dir().join(format!("rchat_pings_kept_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        let t = now();
        let mid = count(&db, "INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'alice', 'hi', 1 FROM channels WHERE server = 'rchat' RETURNING id").await;
        for (user, n) in [("bob", PINGS_KEPT + 600), ("carol", 5)] {
            sqlx::query(sqlx::AssertSqlSafe(format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {n}) INSERT INTO pings(username, kind, scope, message_id, actor, emoji, created_at, seen) SELECT '{user}', 'reaction', 'c1', $2, 'alice', 'x', $1, 1 FROM n")))
                .bind(t)
                .bind(mid)
                .execute(&db)
                .await
                .expect("seen pings");
        }
        let newest = count(&db, "SELECT MAX(id) FROM pings WHERE username = 'bob'").await;
        let swept = sweep_stale(&db).await.expect("sweep");
        assert_eq!(swept.pings, 600);
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM pings WHERE username = 'bob'").await,
            PINGS_KEPT
        );
        assert_eq!(
            count(&db, "SELECT MAX(id) FROM pings WHERE username = 'bob'").await,
            newest,
            "the newest are kept"
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM pings WHERE username = 'carol'").await,
            5
        );
        assert_eq!(sweep_stale(&db).await.expect("again").pings, 0);
        close(&db).await;
        wipe();
    }

    #[tokio::test]
    async fn rules_from_an_older_binary_restrict_their_channel_on_the_next_start() {
        let path =
            std::env::temp_dir().join(format!("rchat_restrict_set_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let view = |name: &str| format!("SELECT restrict_view FROM channels WHERE name = '{name}'");
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 3)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'opened', 'text', 3)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'legacy', 'text', 3)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'later', 'voice', 3)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'plain', 'text', 3)",
            "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history, restrict_set) VALUES((SELECT id FROM channels WHERE name = 'opened'), 'u:bob', 0, 0, 0, 1)",
            "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES((SELECT id FROM channels WHERE name = 'legacy'), 'u:bob', 1, 1, 1)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        let db = open(path.to_str()).await.expect("after the old binary");
        assert_eq!(
            count(&db, &view("legacy")).await,
            1,
            "a rule an older binary wrote after the first backfill restricts its channel"
        );
        assert_eq!(
            count(&db, &view("opened")).await,
            0,
            "a channel with only marked rules stays open"
        );
        assert_eq!(count(&db, &view("plain")).await, 0);
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM channel_perms WHERE restrict_set = 0"
            )
            .await,
            0
        );
        for stmt in [
            "UPDATE channels SET restrict_view = 0 WHERE name = 'legacy'",
            "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES((SELECT id FROM channels WHERE name = 'later'), 'u:bob', 1, 1, 1)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("later boot");
            assert_eq!(
                count(&db, &view("legacy")).await,
                0,
                "an admin who opens it after the upgrade keeps it open"
            );
            assert_eq!(count(&db, &view("later")).await, 1, "voice channels too");
            assert_eq!(count(&db, &view("opened")).await, 0);
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn restrict_marks_are_added_to_a_database_that_was_already_upgraded() {
        let path =
            std::env::temp_dir().join(format!("rchat_restrict_mark_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE channel_perms DROP COLUMN restrict_set",
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 3)",
            "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'opened', 'text', 3)",
            "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES((SELECT id FROM channels WHERE name = 'opened'), 'u:bob', 0, 1, 1)",
            "UPDATE settings SET value = '1' WHERE key = 'schema_version'",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(
                    &db,
                    "SELECT restrict_view FROM channels WHERE name = 'opened'"
                )
                .await,
                0,
                "rules from a binary that knew restrict_view keep an opened channel open"
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM channel_perms WHERE restrict_set = 1"
                )
                .await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
                )
                .await,
                SCHEMA_VERSION
            );
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn reply_columns_are_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_reply_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "ALTER TABLE messages DROP COLUMN reply_mention",
            "ALTER TABLE messages DROP COLUMN reply_to",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name IN ('reply_to', 'reply_mention')").await,
            0
        );
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old message' AND created_at = 7 AND reply_to IS NULL AND reply_mention = 0").await,
                1
            );
            let old: i64 = sqlx::query("SELECT id FROM messages WHERE content = 'old message'")
                .fetch_one(&db)
                .await
                .expect("old")
                .try_get(0)
                .expect("id");
            let loaded = crate::api::messages::load_message(
                &db,
                old,
                crate::api::messages::Quotes::Since(None),
            )
            .await
            .expect("load")
            .expect("old message");
            assert!(loaded.reply_to.is_none());
            sqlx::query("INSERT INTO messages(channel_id, author, content, reply_to, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'bob', 'new reply', $1, 8)")
                .bind(old)
                .execute(&db)
                .await
                .expect("reply to an old message");
            let reply: i64 = sqlx::query("SELECT id FROM messages WHERE content = 'new reply'")
                .fetch_one(&db)
                .await
                .expect("reply")
                .try_get(0)
                .expect("id");
            let quoted = crate::api::messages::load_message(
                &db,
                reply,
                crate::api::messages::Quotes::Since(None),
            )
            .await
            .expect("load")
            .expect("reply")
            .reply_to
            .expect("quote");
            assert_eq!(quoted.id, old);
            assert_eq!(quoted.content, "old message");
            assert!(!quoted.deleted && !quoted.mention);
            sqlx::query("DELETE FROM messages WHERE content = 'new reply'")
                .execute(&db)
                .await
                .expect("clear");
            close(&db).await;
        }
        wipe();
    }

    #[tokio::test]
    async fn reactions_table_is_added_to_an_old_database() {
        let path =
            std::env::temp_dir().join(format!("rchat_reaction_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in [
            "DROP INDEX idx_reactions_message",
            "DROP INDEX idx_reactions_username",
            "DROP TABLE reactions",
            "INSERT INTO messages(channel_id, author, content, created_at) VALUES((SELECT id FROM channels WHERE server = 'rchat'), 'alice', 'old message', 7)",
            "INSERT INTO pings(username, kind, scope, message_id, actor, created_at) SELECT 'alice', 'mention', 'c1', id, 'bob', 8 FROM messages WHERE content = 'old message'",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'reactions'"
            )
            .await,
            0
        );
        close(&db).await;
        for round in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM messages WHERE author = 'alice' AND content = 'old message' AND created_at = 7").await,
                1
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT COUNT(*) FROM pings WHERE username = 'alice' AND created_at = 8"
                )
                .await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_reactions_%'").await,
                3
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM reactions").await,
                round,
                "rows survive a restart"
            );
            if round == 0 {
                sqlx::query("INSERT INTO reactions(message_id, username, emoji, created_at) SELECT id, 'bob', '👍', 9 FROM messages WHERE content = 'old message'")
                    .execute(&db)
                    .await
                    .expect("react to an old message");
                assert!(
                    sqlx::query("INSERT INTO reactions(message_id, username, emoji, created_at) SELECT id, 'bob', '👍', 10 FROM messages WHERE content = 'old message'")
                        .execute(&db)
                        .await
                        .is_err(),
                    "one row per user and emoji"
                );
            }
            close(&db).await;
        }
        let db = open(path.to_str()).await.expect("reopen");
        sqlx::query("DELETE FROM messages WHERE content = 'old message'")
            .execute(&db)
            .await
            .expect("delete");
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM reactions").await,
            0,
            "cascade"
        );
        close(&db).await;
        wipe();
    }

    #[tokio::test]
    async fn dead_server_passwords_are_purged_after_30_days() {
        let (state, path) = temp_state("sweep_passwords").await;
        let db = &state.db;
        sqlx::query("UPDATE servers SET password_hash = '!none' WHERE name = 'rchat'")
            .execute(db)
            .await
            .expect("protect");
        let t = now();
        let old = t - SERVER_PASSWORD_KEEP - 10;
        let recent = t - 86400;
        let mut ids = Vec::new();
        for (expires, revoked, used_up) in [
            (Some(old), None, None),
            (None, Some(old), None),
            (None, None, Some(old)),
            (Some(recent), None, None),
            (None, Some(recent), None),
            (None, None, None),
        ] {
            let id: i64 = sqlx::query("INSERT INTO server_passwords(server, hash, lookup, created_at, expires_at, revoked_at, used_up_at) VALUES('rchat', 'h', $1, 0, $2, $3, $4) RETURNING id")
                .bind(format!("l{}", ids.len()))
                .bind(expires)
                .bind(revoked)
                .bind(used_up)
                .fetch_one(db)
                .await
                .expect("password")
                .try_get(0)
                .expect("id");
            ids.push(id);
        }
        for (grant, id) in [("dead", ids[4]), ("live", ids[5])] {
            sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at, password_id) VALUES($1, 'rchat', $2, $2, $3)")
                .bind(grant)
                .bind(t)
                .bind(id)
                .execute(db)
                .await
                .expect("grant");
        }
        let swept = sweep_stale(db).await.expect("sweep");
        assert_eq!((swept.server_passwords, swept.guest_grants), (3, 1));
        assert_eq!(count(db, "SELECT COUNT(*) FROM server_passwords").await, 3);
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM guest_grants WHERE \"grant\" = 'live'"
            )
            .await,
            1
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn in_memory_databases_read_from_the_writer() {
        let db = open(Some("sqlite::memory:")).await.expect("memory");
        sqlx::query("INSERT INTO settings(key, value) VALUES('probe', '1')")
            .execute(&db)
            .await
            .expect("write");
        let state = crate::state::AppState::new(
            db.clone(),
            crate::ws::Hub::new(),
            None,
            None,
            crate::instance::Instance::ephemeral(),
        );
        assert_eq!(
            count(
                &state.read(),
                "SELECT COUNT(*) FROM settings WHERE key = 'probe'"
            )
            .await,
            1
        );
        close(&db).await;
    }

    #[tokio::test]
    async fn purge_deletes_in_batches() {
        let (state, path) = temp_state("purge_batches").await;
        let db = &state.db;
        let cid = general_id(db).await;
        sqlx::query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1203) INSERT INTO messages(channel_id, author, content, created_at) SELECT $1, CASE WHEN i % 3 = 0 THEN 'keep' ELSE 'gone' END, 'x', i FROM n")
            .bind(cid)
            .execute(db)
            .await
            .expect("seed");
        let purged = purge_messages(db, "author = $1", "gone")
            .await
            .expect("purge");
        assert_eq!(purged, 802);
        assert_eq!(count(db, "SELECT COUNT(*) FROM messages").await, 401);
        done(state, path).await;
    }

    #[test]
    fn sqlite_keeps_one_writer_and_trigger_versions_track_definitions() {
        assert_eq!(writer_connections(true, Some(8)), 1);
        assert_eq!(writer_connections(true, None), 1);
        assert_eq!(writer_connections(false, Some(20)), 20);
        assert_eq!(writer_connections(false, None), 8);
        let v = trigger_version(POSTGRES_TRIGGERS);
        assert_eq!(v, trigger_version(POSTGRES_TRIGGERS));
        assert_eq!(v.len(), 16);
        assert_ne!(v, trigger_version(&POSTGRES_TRIGGERS[1..]));
    }

    #[tokio::test]
    async fn stale_rows_are_swept() {
        let (state, path) = temp_state("sweep_stale").await;
        let db = &state.db;
        let t = now();
        let old = t - 200 * 86400;
        for (sql, at) in [
            (
                "INSERT INTO tokens(token, username, created_at) VALUES('ancient', 'a', $1)",
                old,
            ),
            (
                "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g1', 'rchat', $1, $1)",
                old,
            ),
            (
                "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g2', 'rchat', $1, $1)",
                t,
            ),
            (
                "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('g3', 'rchat', $1, $1 + 86400 * 199)",
                old,
            ),
            (
                "INSERT INTO login_attempts(username, day, count, last_at) VALUES('a', '1', 1, $1)",
                old,
            ),
            (
                "INSERT INTO change_attempts(session, day, failures, last_at) VALUES('a', '1', 1, $1)",
                old,
            ),
            (
                "INSERT INTO change_attempts(session, day, failures, last_at) VALUES('b', '1', 1, $1)",
                t,
            ),
            (
                "INSERT INTO embeds(url, fetched_at) VALUES('https://old.example/', $1)",
                old,
            ),
            (
                "INSERT INTO embeds(url, fetched_at) VALUES('https://kept.example/', $1)",
                old,
            ),
            (
                "INSERT INTO config_shares(id, owner, blob, created_at, expires_at) VALUES('oldlinkaaaaa', 'a', 'rc1.x', 0, $1)",
                old,
            ),
            (
                "INSERT INTO config_shares(id, owner, blob, created_at, expires_at) VALUES('nowlinkaaaaa', 'a', 'rc1.x', 0, $1)",
                t - 1,
            ),
            (
                "INSERT INTO config_shares(id, owner, blob, created_at, expires_at) VALUES('livelinkaaaa', 'a', 'rc1.x', 0, $1 + 600)",
                t,
            ),
            (
                "INSERT INTO audit_log(server, actor, action, created_at) VALUES('rchat', 'a', 'member.ban', $1)",
                t - AUDIT_KEEP - 1,
            ),
            (
                "INSERT INTO audit_log(server, actor, action, created_at) VALUES('rchat', 'a', 'member.kick', $1)",
                t - AUDIT_KEEP + 60,
            ),
            (
                "INSERT INTO member_timeouts(server, username, until, created_at) VALUES('rchat', 'gone', $1, 0)",
                t - TIMEOUT_KEEP - 1,
            ),
            (
                "INSERT INTO member_timeouts(server, username, until, created_at) VALUES('rchat', 'ended', $1, 0)",
                t - 5,
            ),
            (
                "INSERT INTO member_timeouts(server, username, until, created_at) VALUES('rchat', 'live', $1, 0)",
                t + 600,
            ),
        ] {
            sqlx::query(sql).bind(at).execute(db).await.expect(sql);
        }
        let cid = general_id(db).await;
        let mid: i64 = sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, 'a', 'x', 1) RETURNING id")
            .bind(cid)
            .fetch_one(db)
            .await
            .expect("msg")
            .try_get(0)
            .expect("id");
        sqlx::query("INSERT INTO message_embeds(message_id, ord, url) VALUES($1, 0, 'https://kept.example/')")
            .bind(mid)
            .execute(db)
            .await
            .expect("embed ref");
        for (seen, at) in [(1, t), (0, old), (0, t)] {
            sqlx::query("INSERT INTO pings(username, kind, scope, message_id, actor, created_at, seen) VALUES('b', 'mention', 'c1', $1, 'a', $2, $3)")
                .bind(mid)
                .bind(at)
                .bind(seen)
                .execute(db)
                .await
                .expect("ping");
        }
        let swept = sweep_stale(db).await.expect("sweep");
        assert_eq!(
            swept,
            Swept {
                guest_grants: 1,
                server_passwords: 0,
                login_attempts: 1,
                password_attempts: 1,
                embeds: 1,
                pings: 2,
                config_shares: 2,
                audit_log: 1,
                member_timeouts: 1,
            }
        );
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM member_timeouts WHERE username IN ('ended', 'live')"
            )
            .await,
            count(db, "SELECT COUNT(*) FROM member_timeouts").await
        );
        assert_eq!(count(db, "SELECT COUNT(*) FROM member_timeouts").await, 2);
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM audit_log WHERE action = 'member.kick'"
            )
            .await,
            1
        );
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM config_shares WHERE id = 'livelinkaaaa'"
            )
            .await,
            count(db, "SELECT COUNT(*) FROM config_shares").await
        );
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM tokens WHERE token = 'ancient'").await,
            1
        );
        assert_eq!(count(db, "SELECT COUNT(*) FROM guest_grants").await, 2);
        assert_eq!(count(db, "SELECT COUNT(*) FROM embeds").await, 1);
        assert_eq!(
            count(
                db,
                &format!("SELECT COUNT(*) FROM pings WHERE seen = 0 AND created_at = {t}")
            )
            .await,
            1
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn interaction_touches_are_coalesced() {
        let (state, path) = temp_state("touch_coalesce").await;
        let db = &state.db;
        touch_interaction(db, "rchat", "a").await.expect("touch");
        sqlx::query("UPDATE interactions SET last_at = 5")
            .execute(db)
            .await
            .expect("age");
        touch_interaction(db, "rchat", "a")
            .await
            .expect("touch again");
        assert_eq!(count(db, "SELECT last_at FROM interactions").await, 5);
        touch_interaction(db, "rchat", "b")
            .await
            .expect("other user");
        assert_eq!(count(db, "SELECT COUNT(*) FROM interactions").await, 2);
        done(state, path).await;
    }

    #[tokio::test]
    async fn secrets_are_hashed_in_place_and_newer_databases_are_refused() {
        let path =
            std::env::temp_dir().join(format!("rchat_secret_upgrade_{}.db", std::process::id()));
        let wipe = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        };
        wipe();
        let db = open(path.to_str()).await.expect("open");
        for stmt in late_indexes(true) {
            let name = stmt
                .split_whitespace()
                .nth(5)
                .expect("index name")
                .to_string();
            sqlx::query(sqlx::AssertSqlSafe(format!("DROP INDEX {name}")))
                .execute(&db)
                .await
                .expect("drop index");
        }
        for stmt in [
            "DELETE FROM settings WHERE key = 'schema_version'",
            "INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('alice', 'Alice', 'h', 'text', 'identicon', 5)",
            "INSERT INTO tokens(token, username, created_at) VALUES('raw-token', 'alice', 5)",
            "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('club', 'Club', 'alice', 'hash', 1)",
            "INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES('raw-grant', 'club', 1, 1)",
            "INSERT INTO server_passwords(server, hash, lookup, created_by, created_at) VALUES('club', '$argon2id$v=19$old', 'lookup', 'alice', 1)",
        ] {
            sqlx::query(stmt).execute(&db).await.expect(stmt);
        }
        close(&db).await;
        for _ in 0..2 {
            let db = open(path.to_str()).await.expect("upgrade");
            let user = sqlx::query("SELECT u.username FROM tokens t JOIN users u ON u.username = t.username WHERE t.token = $1")
                .bind(secret_key("raw-token"))
                .fetch_optional(&db)
                .await
                .expect("lookup");
            assert!(user.is_some(), "the old login still works");
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM tokens WHERE token = 'raw-token'").await,
                0
            );
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM guest_grants WHERE \"grant\" = '{}' AND server = 'club' AND last_used_at = 1", secret_key("raw-grant"))).await,
                1
            );
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM server_passwords WHERE hash = '{NO_EXTRA_HASH}' AND lookup = 'lookup'")).await,
                1
            );
            assert_eq!(
                count(&db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_server_passwords_revoked', 'idx_server_passwords_expires', 'idx_server_passwords_used_up', 'idx_users_display_lower', 'idx_reactions_agg', 'idx_pings_kept', 'idx_messages_pin_notice', 'idx_messages_system_channel')").await,
                8
            );
            assert_eq!(
                count(
                    &db,
                    "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'schema_version'"
                )
                .await,
                SCHEMA_VERSION
            );
            close(&db).await;
        }
        let db = open(path.to_str()).await.expect("open");
        sqlx::query("UPDATE settings SET value = $1 WHERE key = 'schema_version'")
            .bind((SCHEMA_VERSION + 1).to_string())
            .execute(&db)
            .await
            .expect("newer");
        close(&db).await;
        let refused = open(path.to_str())
            .await
            .map(|_| ())
            .expect_err("older build");
        assert!(refused.to_string().contains("schema version"), "{refused}");
        wipe();
    }

    #[test]
    fn env_secrets_come_from_the_variable_or_a_file() {
        let name = format!("RCHAT_TEST_SECRET_{}", std::process::id());
        assert_eq!(env_secret(&name), None);
        let file = std::env::temp_dir().join(format!("rchat_secret_{}", std::process::id()));
        std::fs::write(&file, "from-file\n").expect("write");
        unsafe {
            std::env::set_var(format!("{name}_FILE"), &file);
        }
        assert_eq!(env_secret(&name).as_deref(), Some("from-file"));
        unsafe {
            std::env::set_var(&name, "  direct ");
        }
        assert_eq!(env_secret(&name).as_deref(), Some("direct"));
        unsafe {
            std::env::set_var(&name, " ");
            std::env::remove_var(format!("{name}_FILE"));
        }
        assert_eq!(env_secret(&name), None, "blank counts as unset");
        unsafe {
            std::env::remove_var(&name);
        }
        let _ = std::fs::remove_file(file);
    }
}
