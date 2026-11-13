use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use super::pool::{Db, is_sqlite, pool_key};

pub(super) const SQLITE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  password_kind TEXT NOT NULL CHECK(password_kind IN ('text','words')),
  avatar_kind TEXT NOT NULL CHECK(avatar_kind IN ('identicon','color')), avatar_color TEXT, banner_color TEXT, bio TEXT,
  is_site_admin INTEGER NOT NULL DEFAULT 0, appear_offline INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, presence_seq INTEGER NOT NULL DEFAULT 0, recovery_pub TEXT, recovery_set_at INTEGER, username_key TEXT, username_key_alt TEXT);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(username TEXT PRIMARY KEY, day TEXT NOT NULL, count INTEGER NOT NULL, last_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS change_attempts(session TEXT PRIMARY KEY, day TEXT NOT NULL, failures INTEGER NOT NULL, last_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_challenges(nonce TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS instance_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS banned_usernames(username TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS pending_purges(kind TEXT NOT NULL, key TEXT NOT NULL, created_at INTEGER NOT NULL, claimed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind, key));
CREATE TABLE IF NOT EXISTS servers(name TEXT PRIMARY KEY, display_name TEXT NOT NULL, creator TEXT, password_hash TEXT, member_count INTEGER NOT NULL DEFAULT 0, banner_color TEXT, name_color TEXT, system_channel_id INTEGER, join_messages INTEGER NOT NULL DEFAULT 1, leave_messages INTEGER NOT NULL DEFAULT 1, layout_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, upload_expiry INTEGER, upload_expiry_by TEXT);
CREATE TABLE IF NOT EXISTS channels(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','voice')), slowmode_seconds INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, restrict_view INTEGER NOT NULL DEFAULT 0, restrict_send INTEGER NOT NULL DEFAULT 0, topic TEXT, category_id INTEGER, position INTEGER NOT NULL DEFAULT 0, UNIQUE(server, name));
CREATE TABLE IF NOT EXISTS channel_categories(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS members(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, perms INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, joined_via INTEGER, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS roles(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, perms INTEGER NOT NULL DEFAULT 0, mentionable INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS user_roles(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(server, username, role_id));
CREATE TABLE IF NOT EXISTS channel_perms(channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, subject TEXT NOT NULL, can_view INTEGER NOT NULL DEFAULT 1, can_send INTEGER NOT NULL DEFAULT 1, can_read_history INTEGER NOT NULL DEFAULT 1, restrict_set INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(channel_id, subject));
CREATE TABLE IF NOT EXISTS dms(id INTEGER PRIMARY KEY AUTOINCREMENT, user_a TEXT NOT NULL, user_b TEXT NOT NULL, last_message_id INTEGER NOT NULL DEFAULT 0, closed_a INTEGER NOT NULL DEFAULT 0, closed_b INTEGER NOT NULL DEFAULT 0, UNIQUE(user_a, user_b));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, dm_id INTEGER REFERENCES dms(id) ON DELETE CASCADE, thread_root_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, author TEXT NOT NULL, content TEXT NOT NULL, media_id TEXT, media_filename TEXT, media_removed INTEGER NOT NULL DEFAULT 0, media_spoiler INTEGER NOT NULL DEFAULT 0, media_kind TEXT NOT NULL DEFAULT 'server' CHECK(media_kind IN ('server','p2p')), media_hoster TEXT, media_expires_at INTEGER, media_size INTEGER, media_mime TEXT, media_sha256 TEXT, kind TEXT NOT NULL DEFAULT 'user', call_answered_at INTEGER, call_ended_at INTEGER, call_outcome TEXT, call_kind TEXT, call_video INTEGER, reply_to INTEGER, reply_mention INTEGER NOT NULL DEFAULT 0, edited_at INTEGER, fwd_author TEXT, fwd_created_at INTEGER, fwd_source_id INTEGER, fwd_origin TEXT, fwd_dropped TEXT, pinned_at INTEGER, pinned_by TEXT, pin_message_id INTEGER, group_mentions TEXT, webhook_id INTEGER, webhook_name TEXT, webhook_avatar TEXT, webhook_embeds TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB, uploader TEXT, uploaded_at INTEGER NOT NULL, charged_to TEXT, charged_server TEXT, ttl INTEGER, kept_by TEXT);
CREATE TABLE IF NOT EXISTS media_chunks(media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(media_id, seq));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embeds(url TEXT PRIMARY KEY, site_name TEXT, title TEXT, description TEXT, image_url TEXT, fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS preview_images(key TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, size INTEGER NOT NULL, fetched_at INTEGER NOT NULL);
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
CREATE TABLE IF NOT EXISTS group_pings_read(username TEXT NOT NULL, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, PRIMARY KEY(username, message_id));
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
CREATE TABLE IF NOT EXISTS bulk_delete_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, scope TEXT NOT NULL, channel_id INTEGER, status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','cancelled','failed')), except_ids TEXT NOT NULL DEFAULT '[]', after_id INTEGER NOT NULL DEFAULT 0, upto_id INTEGER NOT NULL DEFAULT 0, cursor_id INTEGER NOT NULL DEFAULT 0, estimate INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, authors TEXT NOT NULL DEFAULT '{}', staff INTEGER NOT NULL DEFAULT 0, author_filter TEXT, audit_id INTEGER, error TEXT, claimed_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE IF NOT EXISTS webhooks(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, name TEXT NOT NULL, avatar_kind TEXT NOT NULL DEFAULT 'identicon' CHECK(avatar_kind IN ('identicon','color')), avatar_color TEXT, token_hash TEXT NOT NULL, creator TEXT, creator_mentions INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE TABLE IF NOT EXISTS outgoing_webhooks(id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL, secret TEXT NOT NULL, creator TEXT, enabled INTEGER NOT NULL DEFAULT 1, failures INTEGER NOT NULL DEFAULT 0, disabled_at INTEGER, disabled_reason TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT, hook_id INTEGER NOT NULL REFERENCES outgoing_webhooks(id) ON DELETE CASCADE, event TEXT NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed')), attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, claimed_at INTEGER NOT NULL DEFAULT 0, last_code INTEGER, last_ms INTEGER, last_error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
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
CREATE INDEX IF NOT EXISTS idx_preview_images_fetched ON preview_images(fetched_at);
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
CREATE INDEX IF NOT EXISTS idx_recovery_challenges_expires ON recovery_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_instance_audit_actor ON instance_audit(actor);
CREATE INDEX IF NOT EXISTS idx_instance_audit_target ON instance_audit(target);
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
CREATE INDEX IF NOT EXISTS idx_group_pings_server_time ON group_pings(server, created_at, message_id);
CREATE INDEX IF NOT EXISTS idx_group_pings_read_message ON group_pings_read(message_id);
CREATE INDEX IF NOT EXISTS idx_group_pings_read_created ON group_pings_read(created_at);
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_bulk_delete_jobs_running ON bulk_delete_jobs(username, scope) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_bulk_delete_jobs_user ON bulk_delete_jobs(username, id);
CREATE INDEX IF NOT EXISTS idx_bulk_delete_jobs_claim ON bulk_delete_jobs(status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_bulk_delete_jobs_finished ON bulk_delete_jobs(finished_at);
CREATE INDEX IF NOT EXISTS idx_webhooks_server ON webhooks(server, id);
CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks(channel_id);
CREATE INDEX IF NOT EXISTS idx_outgoing_webhooks_server ON outgoing_webhooks(server, id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries(hook_id, id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at);
";

pub(super) const POSTGRES_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  password_kind TEXT NOT NULL CHECK(password_kind IN ('text','words')),
  avatar_kind TEXT NOT NULL CHECK(avatar_kind IN ('identicon','color')), avatar_color TEXT, banner_color TEXT, bio TEXT,
  is_site_admin BIGINT NOT NULL DEFAULT 0, appear_offline BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, presence_seq BIGINT NOT NULL DEFAULT 0, recovery_pub TEXT, recovery_set_at BIGINT, username_key TEXT, username_key_alt TEXT);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(username TEXT PRIMARY KEY, day TEXT NOT NULL, count BIGINT NOT NULL, last_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS change_attempts(session TEXT PRIMARY KEY, day TEXT NOT NULL, failures BIGINT NOT NULL, last_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_challenges(nonce TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS instance_audit(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at BIGINT NOT NULL, actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS banned_usernames(username TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS pending_purges(kind TEXT NOT NULL, key TEXT NOT NULL, created_at BIGINT NOT NULL, claimed_at BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(kind, key));
CREATE TABLE IF NOT EXISTS servers(name TEXT PRIMARY KEY, display_name TEXT NOT NULL, creator TEXT, password_hash TEXT, member_count BIGINT NOT NULL DEFAULT 0, banner_color TEXT, name_color TEXT, system_channel_id BIGINT, join_messages BIGINT NOT NULL DEFAULT 1, leave_messages BIGINT NOT NULL DEFAULT 1, layout_version BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, upload_expiry BIGINT, upload_expiry_by TEXT);
CREATE TABLE IF NOT EXISTS channels(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','voice')), slowmode_seconds BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, restrict_view BIGINT NOT NULL DEFAULT 0, restrict_send BIGINT NOT NULL DEFAULT 0, topic TEXT, category_id BIGINT, position BIGINT NOT NULL DEFAULT 0, UNIQUE(server, name));
CREATE TABLE IF NOT EXISTS channel_categories(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, position BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS members(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, is_admin BIGINT NOT NULL DEFAULT 0, perms BIGINT NOT NULL DEFAULT 0, joined_at BIGINT NOT NULL, joined_via BIGINT, PRIMARY KEY(server, username));
CREATE TABLE IF NOT EXISTS roles(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL, perms BIGINT NOT NULL DEFAULT 0, mentionable BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS user_roles(server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, username TEXT NOT NULL, role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(server, username, role_id));
CREATE TABLE IF NOT EXISTS channel_perms(channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, subject TEXT NOT NULL, can_view BIGINT NOT NULL DEFAULT 1, can_send BIGINT NOT NULL DEFAULT 1, can_read_history BIGINT NOT NULL DEFAULT 1, restrict_set BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(channel_id, subject));
CREATE TABLE IF NOT EXISTS dms(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, last_message_id BIGINT NOT NULL DEFAULT 0, closed_a BIGINT NOT NULL DEFAULT 0, closed_b BIGINT NOT NULL DEFAULT 0, UNIQUE(user_a, user_b));
CREATE TABLE IF NOT EXISTS messages(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, channel_id BIGINT REFERENCES channels(id) ON DELETE CASCADE, dm_id BIGINT REFERENCES dms(id) ON DELETE CASCADE, thread_root_id BIGINT REFERENCES messages(id) ON DELETE CASCADE, author TEXT NOT NULL, content TEXT NOT NULL, media_id TEXT, media_filename TEXT, media_removed BIGINT NOT NULL DEFAULT 0, media_spoiler BIGINT NOT NULL DEFAULT 0, media_kind TEXT NOT NULL DEFAULT 'server' CHECK(media_kind IN ('server','p2p')), media_hoster TEXT, media_expires_at BIGINT, media_size BIGINT, media_mime TEXT, media_sha256 TEXT, kind TEXT NOT NULL DEFAULT 'user', call_answered_at BIGINT, call_ended_at BIGINT, call_outcome TEXT, call_kind TEXT, call_video BIGINT, reply_to BIGINT, reply_mention BIGINT NOT NULL DEFAULT 0, edited_at BIGINT, fwd_author TEXT, fwd_created_at BIGINT, fwd_source_id BIGINT, fwd_origin TEXT, fwd_dropped TEXT, pinned_at BIGINT, pinned_by TEXT, pin_message_id BIGINT, group_mentions TEXT, webhook_id BIGINT, webhook_name TEXT, webhook_avatar TEXT, webhook_embeds TEXT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, data BYTEA, uploader TEXT, uploaded_at BIGINT NOT NULL, charged_to TEXT, charged_server TEXT, ttl BIGINT, kept_by TEXT);
CREATE TABLE IF NOT EXISTS media_chunks(media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, seq BIGINT NOT NULL, data BYTEA NOT NULL, PRIMARY KEY(media_id, seq));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embeds(url TEXT PRIMARY KEY, site_name TEXT, title TEXT, description TEXT, image_url TEXT, fetched_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS preview_images(key TEXT PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, size BIGINT NOT NULL, fetched_at BIGINT NOT NULL);
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
CREATE TABLE IF NOT EXISTS group_pings_read(username TEXT NOT NULL, message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, created_at BIGINT NOT NULL, PRIMARY KEY(username, message_id));
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
CREATE TABLE IF NOT EXISTS bulk_delete_jobs(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, username TEXT NOT NULL, scope TEXT NOT NULL, channel_id BIGINT, status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','cancelled','failed')), except_ids TEXT NOT NULL DEFAULT '[]', after_id BIGINT NOT NULL DEFAULT 0, upto_id BIGINT NOT NULL DEFAULT 0, cursor_id BIGINT NOT NULL DEFAULT 0, estimate BIGINT NOT NULL DEFAULT 0, deleted BIGINT NOT NULL DEFAULT 0, skipped BIGINT NOT NULL DEFAULT 0, authors TEXT NOT NULL DEFAULT '{}', staff BIGINT NOT NULL DEFAULT 0, author_filter TEXT, audit_id BIGINT, error TEXT, claimed_at BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, finished_at BIGINT);
CREATE TABLE IF NOT EXISTS webhooks(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, name TEXT NOT NULL, avatar_kind TEXT NOT NULL DEFAULT 'identicon' CHECK(avatar_kind IN ('identicon','color')), avatar_color TEXT, token_hash TEXT NOT NULL, creator TEXT, creator_mentions BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, last_used_at BIGINT);
CREATE TABLE IF NOT EXISTS outgoing_webhooks(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, server TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE ON UPDATE CASCADE, name TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL, secret TEXT NOT NULL, creator TEXT, enabled BIGINT NOT NULL DEFAULT 1, failures BIGINT NOT NULL DEFAULT 0, disabled_at BIGINT, disabled_reason TEXT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_deliveries(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, hook_id BIGINT NOT NULL REFERENCES outgoing_webhooks(id) ON DELETE CASCADE, event TEXT NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed')), attempts BIGINT NOT NULL DEFAULT 0, next_at BIGINT NOT NULL, claimed_at BIGINT NOT NULL DEFAULT 0, last_code BIGINT, last_ms BIGINT, last_error TEXT, created_at BIGINT NOT NULL, finished_at BIGINT);
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
CREATE INDEX IF NOT EXISTS idx_preview_images_fetched ON preview_images(fetched_at);
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
CREATE INDEX IF NOT EXISTS idx_recovery_challenges_expires ON recovery_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_instance_audit_actor ON instance_audit(actor);
CREATE INDEX IF NOT EXISTS idx_instance_audit_target ON instance_audit(target);
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
CREATE INDEX IF NOT EXISTS idx_group_pings_server_time ON group_pings(server, created_at, message_id);
CREATE INDEX IF NOT EXISTS idx_group_pings_read_message ON group_pings_read(message_id);
CREATE INDEX IF NOT EXISTS idx_group_pings_read_created ON group_pings_read(created_at);
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_bulk_delete_jobs_running ON bulk_delete_jobs(username, scope) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_bulk_delete_jobs_user ON bulk_delete_jobs(username, id);
CREATE INDEX IF NOT EXISTS idx_bulk_delete_jobs_claim ON bulk_delete_jobs(status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_bulk_delete_jobs_finished ON bulk_delete_jobs(finished_at);
CREATE INDEX IF NOT EXISTS idx_webhooks_server ON webhooks(server, id);
CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks(channel_id);
CREATE INDEX IF NOT EXISTS idx_outgoing_webhooks_server ON outgoing_webhooks(server, id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries(hook_id, id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at);
";

const SQLITE_SEARCH: &[&str] = &[
    "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id', tokenize='trigram')",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content) VALUES(new.id, new.content); END",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content); END",
    "CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content); INSERT INTO messages_fts(rowid, content) VALUES(new.id, new.content); END",
];

pub(super) const SQLITE_TRIGGERS: &[&str] = &[
    "CREATE TRIGGER IF NOT EXISTS messages_dm_latest_insert AFTER INSERT ON messages WHEN new.dm_id IS NOT NULL BEGIN UPDATE dms SET last_message_id = new.id WHERE id = new.dm_id AND last_message_id < new.id; END",
    "CREATE TRIGGER IF NOT EXISTS messages_dm_latest_delete AFTER DELETE ON messages WHEN old.dm_id IS NOT NULL BEGIN UPDATE dms SET last_message_id = COALESCE((SELECT MAX(id) FROM messages WHERE dm_id = old.dm_id), 0) WHERE id = old.dm_id AND last_message_id = old.id; END",
    "DROP TRIGGER IF EXISTS members_count_insert",
    "DROP TRIGGER IF EXISTS members_count_delete",
    "DROP TRIGGER IF EXISTS messages_media_release",
    "CREATE TRIGGER messages_media_release AFTER DELETE ON messages WHEN old.media_id IS NOT NULL AND old.media_kind = 'server' AND old.fwd_created_at IS NULL BEGIN UPDATE messages SET media_expires_at = (SELECT uploaded_at + 86400 FROM media WHERE id = old.media_id) WHERE media_id = old.media_id AND media_kind = 'server' AND media_removed = 0 AND EXISTS(SELECT 1 FROM media WHERE id = old.media_id AND ttl IS NOT NULL); UPDATE media SET ttl = NULL, kept_by = NULL WHERE id = old.media_id AND ttl IS NOT NULL; END",
];

pub(super) const POSTGRES_TRIGGERS: &[&str] = &[
    "CREATE OR REPLACE FUNCTION rchat_dm_latest_insert() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE dms SET last_message_id = NEW.id WHERE id = NEW.dm_id AND last_message_id < NEW.id; RETURN NULL; END $f$",
    "CREATE OR REPLACE FUNCTION rchat_dm_latest_delete() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE dms SET last_message_id = COALESCE((SELECT MAX(id) FROM messages WHERE dm_id = OLD.dm_id), 0) WHERE id = OLD.dm_id AND last_message_id = OLD.id; RETURN NULL; END $f$",
    "DROP TRIGGER IF EXISTS messages_dm_latest_insert ON messages",
    "CREATE TRIGGER messages_dm_latest_insert AFTER INSERT ON messages FOR EACH ROW WHEN (NEW.dm_id IS NOT NULL) EXECUTE FUNCTION rchat_dm_latest_insert()",
    "DROP TRIGGER IF EXISTS messages_dm_latest_delete ON messages",
    "CREATE TRIGGER messages_dm_latest_delete AFTER DELETE ON messages FOR EACH ROW WHEN (OLD.dm_id IS NOT NULL) EXECUTE FUNCTION rchat_dm_latest_delete()",
    "DROP TRIGGER IF EXISTS members_count_insert ON members",
    "DROP TRIGGER IF EXISTS members_count_delete ON members",
    "DROP FUNCTION IF EXISTS rchat_members_count_insert()",
    "DROP FUNCTION IF EXISTS rchat_members_count_delete()",
    "CREATE OR REPLACE FUNCTION rchat_media_release() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN UPDATE messages SET media_expires_at = (SELECT uploaded_at + 86400 FROM media WHERE id = OLD.media_id) WHERE media_id = OLD.media_id AND media_kind = 'server' AND media_removed = 0 AND EXISTS(SELECT 1 FROM media WHERE id = OLD.media_id AND ttl IS NOT NULL); UPDATE media SET ttl = NULL, kept_by = NULL WHERE id = OLD.media_id AND ttl IS NOT NULL; RETURN NULL; END $f$",
    "DROP TRIGGER IF EXISTS messages_media_release ON messages",
    "CREATE TRIGGER messages_media_release AFTER DELETE ON messages FOR EACH ROW WHEN (OLD.media_id IS NOT NULL AND OLD.media_kind = 'server' AND OLD.fwd_created_at IS NULL) EXECUTE FUNCTION rchat_media_release()",
];

static FTS_READY: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

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

pub(super) async fn probe_fts(db: &Db) -> bool {
    is_sqlite(db)
        && sqlx::query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
            .fetch_optional(db)
            .await
            .is_ok_and(|r| r.is_some())
}

pub(super) async fn sqlite_search_index(pool: &Db) -> anyhow::Result<()> {
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
