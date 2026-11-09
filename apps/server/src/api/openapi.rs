use axum::Json;
use axum::Router;
use axum::routing::get;
use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};
use utoipa::{Modify, OpenApi};
use utoipa_swagger_ui::SwaggerUi;

use crate::state::AppState;

struct Bearer;

impl Modify for Bearer {
    fn modify(&self, doc: &mut utoipa::openapi::OpenApi) {
        doc.components
            .get_or_insert_with(Default::default)
            .add_security_scheme(
                "bearer",
                SecurityScheme::Http(
                    HttpBuilder::new()
                        .scheme(HttpAuthScheme::Bearer)
                        .description(Some(
                            "A session token from `POST /api/v1/auth/register`, `POST /api/v1/auth/login` or `POST /api/v1/auth/recovery`, sent as `Authorization: Bearer <token>`. Tokens do not expire; `POST /api/v1/auth/logout` revokes one, a password change revokes all others, and a recovery revokes every earlier one. An unknown token on an endpoint that also allows guests is treated as no token.",
                        ))
                        .build(),
                ),
            );
    }
}

#[derive(OpenApi)]
#[openapi(
    paths(
        super::auth::register,
        super::auth::login,
        super::auth::words,
        super::recovery::challenge,
        super::recovery::recover,
        super::auth::me,
        super::auth::patch_me,
        super::auth::change_password,
        super::auth::logout,
        super::config_shares::create_share,
        super::config_shares::list_shares,
        super::config_shares::get_share,
        super::config_shares::delete_share,
        super::users::profile,
        super::servers::list_my_servers,
        super::servers::create_server,
        super::servers::get_server,
        super::servers::server_available,
        super::servers::get_invite,
        super::servers::search_servers,
        super::servers::guest_access,
        super::servers::list_members,
        super::servers::list_interacted,
        super::servers::join_server,
        super::servers::leave_server,
        super::servers::update_server,
        super::servers::delete_server,
        super::passwords::list_passwords,
        super::passwords::create_password,
        super::passwords::revoke_password,
        super::system_messages::get_system_messages,
        super::system_messages::update_system_messages,
        super::servers::create_channel,
        super::servers::update_channel,
        super::servers::delete_channel,
        super::categories::create_category,
        super::categories::rename_category,
        super::categories::delete_category,
        super::categories::reorder_layout,
        super::servers::kick_member,
        super::timeouts::set_timeout,
        super::timeouts::remove_timeout,
        super::servers::ban_member,
        super::servers::unban_member,
        super::servers::list_bans,
        super::audit::list_audit,
        super::servers::grant_admin,
        super::servers::revoke_admin,
        super::servers::transfer_admin,
        super::servers::set_admin_perms,
        super::servers::create_role,
        super::servers::update_role,
        super::servers::delete_role,
        super::servers::assign_role,
        super::servers::unassign_role,
        super::servers::list_channel_perms,
        super::servers::set_channel_perm,
        super::servers::clear_channel_perm,
        super::messages::channel_messages,
        super::messages::send_channel_message,
        super::messages::thread_messages,
        super::messages::send_thread_message,
        super::messages::dm_messages,
        super::messages::send_dm_message,
        super::messages::delete_message,
        super::bulk_delete::bulk_delete,
        super::bulk_delete::list_jobs,
        super::bulk_delete::cancel_job,
        super::messages::edit_message,
        super::messages::message_location,
        super::messages::message_locations,
        super::messages::search,
        super::messages::unreads,
        super::messages::mark_read,
        super::messages::mark_read_batch,
        super::reactions::add_reaction,
        super::reactions::remove_reaction,
        super::reactions::list_reactors,
        super::pins::pin_message,
        super::pins::unpin_message,
        super::pins::channel_pins,
        super::pins::dm_pins,
        super::embeds::delete_embed,
        super::preview_images::preview_image,
        super::polls::get_poll,
        super::polls::vote,
        super::polls::retract_vote,
        super::polls::add_option,
        super::polls::close_poll,
        super::polls::reopen_poll,
        super::polls::list_voters,
        super::webhooks::list_webhooks,
        super::webhooks::create_webhook,
        super::webhooks::update_webhook,
        super::webhooks::reset_token,
        super::webhooks::delete_webhook,
        super::webhooks::execute,
        super::webhooks::webhook_info,
        super::webhooks::edit_hook_message,
        super::webhooks::delete_hook_message,
        super::webhooks::list_outgoing,
        super::webhooks::create_outgoing,
        super::webhooks::update_outgoing,
        super::webhooks::reset_secret,
        super::webhooks::delete_outgoing,
        super::webhooks::list_deliveries,
        super::webhooks::test_outgoing,
        super::dms::list_dms,
        super::dms::open_dm,
        super::dms::close_dm,
        super::blocks::list_blocks,
        super::blocks::blocked_usernames,
        super::blocks::block_user,
        super::blocks::unblock_user,
        super::friends::list_friends,
        super::friends::summary,
        super::friends::mark_seen,
        super::friends::list_requests,
        super::friends::send_request,
        super::friends::cancel_request,
        super::friends::accept_request,
        super::friends::deny_request,
        super::friends::friendship,
        super::friends::remove_friend,
        super::friends::get_privacy,
        super::friends::patch_privacy,
        super::inbox::list_inbox,
        super::inbox::read_item,
        super::inbox::read_all,
        super::media::upload_media,
        super::media::download_media,
        super::media::delete_media,
        super::admin::get_settings,
        super::health::health,
        super::health::ready,
        super::instance::instance,
        super::instance::well_known,
        super::instance::jwks,
        super::instance::assertion,
        super::instance::p2p_binding,
        super::instance::ice,
        crate::ws::handler,
    ),
    components(schemas(
        super::ApiErrorBody,
        super::pings::Ping,
        super::pings::ThreadPings,
        super::pings::GroupMention,
        super::pings::GroupPing
    )),
    servers((url = "/", description = "The instance serving this document")),
    modifiers(&Bearer),
    info(
        title = "RChat API",
        version = env!("CARGO_PKG_VERSION"),
        description = "RChat is a self-hosted chat server: servers with text and voice channels, roles and per-channel permissions, threads, direct messages with calls, media uploads, link previews and search. This document covers version 1 of the REST API plus the `/.well-known` discovery documents.

**Versions.** `/api/v1/...` is version 1. `/api/...` without a version uses the latest version.

**Authentication.** Register or log in to get a session token and send it as `Authorization: Bearer <token>`. Endpoints marked with an optional security requirement also work without a token for guests, when the instance has guest access turned on (`guests_enabled` in `GET /api/v1/settings`); otherwise they answer 401. On endpoints that need a token, `401 Unauthorized` means the token is missing or unknown. When the token cannot be checked (the database is unavailable), any endpoint that reads it answers `503 {\"error\": \"Cannot check your session right now. Try again soon\"}`: keep the token and retry. Guests are read-only. Password-protected servers additionally need a guest grant from `POST /api/v1/servers/{name}/guest_access`, sent in the `X-Guest-Grant` header (comma-separated, up to 100 grants).

**Names.** Server names and usernames are case-insensitive: they are matched by their lowercase form, and responses carry the lowercase `name`/`username` alongside the original-case `display_name`.

**Timestamps** are Unix time in seconds unless a field says otherwise.

**Pagination.** List endpoints return a JSON array. When more items follow, the `X-Next-Cursor` response header holds an opaque cursor; pass it back as the `cursor` query parameter for the next page. The header is absent on the last page. Each endpoint lists its page size and limits.

**Rate limits.** Every `/api` route except `/api/v1/health` and `/api/v1/ready` shares a general per-client-IP bucket (`RATE_LIMIT_PER_SECOND`, default 10 per second, burst `RATE_LIMIT_BURST`, default 60). The `/.well-known` routes have their own general bucket of the same size, separate from the `/api` one. Register, login, word hints, recovery challenges, recovery sign-in, password change, guest access, server name checks, config links, P2P identity bindings and media upload also share a strict per-IP bucket (2 per second, burst 30). Invite previews and joining a server each have their own bucket of the same size. Exceeding a bucket answers 429 with a plain-text body.

**Errors.** Errors raised by the API come as JSON `{\"error\": \"...\"}` (`ApiErrorBody`). Malformed JSON bodies are rejected by the framework with a plain-text 400, 415 or 422.

**Private servers stay hidden.** A password-protected server is indistinguishable from one that does not exist to anyone without access (membership, a valid guest grant, or the password where an endpoint takes one). Every endpoint that takes a server name answers both with the same `404 {\"error\": \"Server not found or wrong password\"}`; endpoints that take a password (`join`, `guest_access`, invites) answer a missing password with the same `401 {\"error\": \"Password required\"}` and a wrong one with that 404, and always hash the password, also for names that do not exist. Endpoints that take a channel or message id answer `404 {\"error\": \"Not found\"}` for ids that do not exist, that you cannot see (hidden channels, messages before your join without read history) or that belong to a server you cannot access. Bans are only reported (403) once access was proven. `GET /api/v1/servers/{name}/available` is the one deliberate existence check, because creating a server reveals the same.

**Realtime.** `GET /api/v1/ws` upgrades to a WebSocket. Clients send JSON frames tagged by `type` (`auth` first, with the token or without one for a guest, then `viewing`, `subscribe`, voice, call and `rtc_signal` frames) and receive JSON events tagged by `type` in snake_case (`message`, `message_updated`, `message_deleted`, `member_joined`, `presence_changed`, `read_updated`, `ping`, `ping_count`, `voice_state`, `call_state` and more; see `WsEvent` in `apps/server/src/ws/event.rs`). `ping` (`{username, ping: Ping}`) reaches only the pinged user's connections when someone mentions them; `ping_count` (`{username, scope, pings, pings_until, thread_pings}`, same fields as a `GET /api/v1/unreads` item) gives a scope's unseen pings after some were removed. `@everyone`, `@here` and role mentions send no per-user event: the `message` event carries `group_mentions`, each client decides whether the message addresses it (member, online, holds the role). `group_pings_seen` (`{username, scope, message_ids}`) tells the user's connections that `POST /api/v1/inbox/read` or `POST /api/v1/inbox/read_all` marked those group mentions seen. A signed-in user is online while any of their connections is open, whatever server or page it shows (unless they appear offline), and goes offline about 10 seconds after the last one closes. Switching to appear offline hides them at once; coming back online is allowed a few times in a row, then about once per 10 seconds, and the last setting wins. An account keeps at most `WS_CONNECTIONS_PER_USER` connections (default 20; opening another closes the oldest with close code 4008), and opening them faster than `WS_CONNECT_BURST` / `WS_CONNECTS_PER_MINUTE` (counted per instance and across the cluster) closes the new one with code 4029. One client address keeps at most `WS_SOCKETS_PER_IP` connections per instance (default 200; past it the upgrade answers 429) and `WS_GUEST_SOCKETS_PER_IP` of them as guests (default 50; past it the guest connection closes with code 4029); an IPv6 /64 counts as one address. All guest connections of one instance together are capped at `WS_GUEST_SOCKETS_MAX` (default 2000, 0 turns guest connections off; past it the guest connection closes with code 4029). A connection that sends no `auth` frame within 10 seconds closes with code 4001. `subscribe` frames are paced per connection by the number of servers they newly check (at most 100 servers per frame, 50 for guests); one past the pace waits and a later one replaces it. `voice_join` and `voice_leave` are paced per account (a few per second; the latest waits and wins), `call_start` and `call_accept` too (each on its own), and `rtc_signal` payloads are at most 20 KiB with a per-account byte budget (enough to negotiate with a full voice room twice at once); past these the server answers an `error` frame. These paces count per server process. `presence_changed` (`{server, username, online, online_count}`) reaches the connections viewing that server when a member's first connection opens or last one closes, and when members join, leave, are kicked or banned, and `GET /api/v1/unreads` lists the unread ones as `group_pings`. `layout_changed` (`{server, layout}`, a `ChannelLayout`) carries the new channel order, with only the channels each connection can see and only the categories holding one of them (all categories for people who manage channels). Every `position` a client gets (channels and categories, in REST answers and events) counts only what that client can see, so it runs 0, 1, 2 and so on without gaps. `read_updated` (`{username, scope, last_read, pings_until}`) tells the reader's other connections that `POST /api/v1/read` (or, once per scope, `POST /api/v1/read/batch`) stored a position or marked pings seen; clients clear only pings with an id up to `pings_until` (0: none), so newer pings keep their badge. The REST operations below name the events they emit."
    ),
    tags(
        (name = "Auth", description = "Create accounts, sign in and out, recover with a backup phrase, and look up word-password hints."),
        (name = "Account", description = "The signed-in user's own account: profile, preferences and password."),
        (name = "Users", description = "Public profiles of other users."),
        (name = "Servers", description = "Create, browse, join, leave and configure servers."),
        (name = "Members", description = "Server member lists."),
        (name = "Moderation", description = "Kicks, bans, timeouts, server admins and the audit log. Each operation needs the matching server permission."),
        (name = "Roles", description = "Server roles: colored names with permission bits, assigned to members."),
        (name = "Channels", description = "Text and voice channels and their per-role or per-user permission overrides."),
        (name = "Messages", description = "Channel messages, deletion, link previews and read state."),
        (name = "Threads", description = "Replies attached to a root message."),
        (name = "Polls", description = "Polls posted as messages: votes, options, closing and voter lists. Counts reach clients through `poll_updated` events, never voter names."),
        (name = "Webhooks", description = "Incoming webhooks post into one text channel through a secret URL (no account, no bot user), with a WEBHOOK badge. Outgoing webhooks POST signed JSON events of a server to a URL, only when the instance allows them. Outgoing payloads look like `{id, webhook_id, type, server, created_at, data}`; verify `X-Webhook-Signature` (`sha256=` plus the hex HMAC-SHA256 of `<X-Webhook-Timestamp>.<raw body>` under the secret) and reject the request when `|now - X-Webhook-Timestamp|` is over 300 seconds. `X-Webhook-Delivery` stays the same across retries: use it as the idempotency key. Each try is built from current data as the webhook's owner may see it then: an edited message is sent with its current content, a message deleted before its delivery went out arrives as `message.deleted`, and nothing is sent once the owner lost access. The owner is whoever created the webhook or last changed what it receives (URL, events, turning it on, a new secret; for incoming webhooks a new URL or another channel). Events: `message.created` and `message.updated` (`data.message`), `message.deleted` (`data.channel_id`, `thread_root_id`, `ids`), `member.joined` (`data.user`), `member.left` (`data.username`, `kicked`, `banned`), `reaction.added` and `reaction.removed` (`data.message_id`, `channel_id`, `emoji`, `user`, `count`), `poll.ended` (`data.message`), and `ping` from the test button."),
        (name = "Direct messages", description = "One-to-one conversations, including the conversation with yourself."),
        (name = "Blocking", description = "Users you blocked: they can not DM, call or ping you, and you can hide their messages."),
        (name = "Friends", description = "Friends, friend requests, and the privacy settings for DMs and requests."),
        (name = "Inbox", description = "Recent notifications in one list: mentions, replies, reactions, group mentions and friend requests, with read state."),
        (name = "Media", description = "File uploads attached to messages, and downloads."),
        (name = "Search", description = "Message and server search."),
        (name = "Invites", description = "Invite link previews."),
        (name = "Realtime", description = "The WebSocket gateway for live events, presence, voice and calls."),
        (name = "Instance", description = "Instance discovery, public settings, identity assertions for federation, P2P identity bindings for account badges and ICE servers for peer-to-peer connections."),
        (name = "Health", description = "Liveness and readiness probes for load balancers and orchestrators."),
    )
)]
pub struct ApiDoc;

async fn openapi_json() -> Json<utoipa::openapi::OpenApi> {
    Json(ApiDoc::openapi())
}

fn swagger_on(value: Option<&str>) -> bool {
    !matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("0" | "false" | "off" | "no")
    )
}

pub fn routes(swagger_ui: Option<&str>) -> Router<AppState> {
    let router = Router::new().route("/openapi.json", get(openapi_json));
    match swagger_on(swagger_ui) {
        true => router
            .merge(SwaggerUi::new("/swagger-ui").url("/api/v1/openapi.json", ApiDoc::openapi())),
        false => router,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use utoipa::OpenApi;

    use super::{ApiDoc, swagger_on};
    use crate::api::auth::Me;
    use crate::db::AvatarKind;

    const NO_ERROR_RESPONSE: [(&str, &str, &str); 6] = [
        (
            "get",
            "/api/v1/health",
            "liveness only reports that the process answers; it is outside every rate limiter and cannot fail",
        ),
        (
            "get",
            "/api/v1/auth/words/{username}",
            "any username gets a word set, derived from the name without a database lookup",
        ),
        (
            "get",
            "/api/v1/settings",
            "public, no input; answers the cached settings and only the rate limiter can refuse it",
        ),
        (
            "get",
            "/api/v1/instance",
            "public, no input; answers the instance document and only the rate limiter can refuse it",
        ),
        (
            "get",
            "/.well-known/rchat",
            "same handler as GET /api/instance, with its own rate-limit bucket",
        ),
        (
            "get",
            "/.well-known/jwks.json",
            "public, no input; serves the in-memory signing keys and only the rate limiter can refuse it",
        ),
    ];

    const ADMIN_ROUTES: [(&str, &str); 9] = [
        ("patch", "/api/v1/admin/settings"),
        ("get", "/api/v1/admin/overview"),
        ("get", "/api/v1/admin/users"),
        ("get", "/api/v1/admin/servers"),
        ("delete", "/api/v1/admin/servers/{name}"),
        ("delete", "/api/v1/admin/users/{username}"),
        ("get", "/api/v1/admin/users/{username}/servers"),
        ("delete", "/api/v1/admin/messages/{id}"),
        ("post", "/api/v1/admin/ban"),
    ];

    const UNDOCUMENTED: [(&str, &str, &str); 1] = [(
        "get",
        "/api/v1/openapi.json",
        "serves this document itself, next to Swagger UI",
    )];

    const ADMIN_REASON: &str =
        "site-admin only; site admins must stay hidden, so the public document leaves these out";

    const ROUTE_SOURCES: [(&str, &str); 4] = [
        ("/api/v1", include_str!("mod.rs")),
        ("/api/v1", include_str!("health.rs")),
        ("/api/v1", include_str!("openapi.rs")),
        ("", include_str!("instance.rs")),
    ];

    const METHODS: [&str; 5] = ["get", "post", "put", "patch", "delete"];

    fn registered_routes() -> Vec<(String, String)> {
        let mut out = Vec::new();
        for (prefix, src) in ROUTE_SOURCES {
            let code = src.split("#[cfg(test)]").next().unwrap_or(src);
            for chunk in code.split(".route(").skip(1) {
                let mut depth = 1;
                let mut end = chunk.len();
                for (i, c) in chunk.char_indices() {
                    match c {
                        '(' => depth += 1,
                        ')' => {
                            depth -= 1;
                            if depth == 0 {
                                end = i;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                let call = &chunk[..end];
                let path = call.split('"').nth(1).expect("route path literal");
                let methods: Vec<&str> = METHODS
                    .into_iter()
                    .filter(|m| {
                        call.match_indices(&format!("{m}(")).any(|(i, _)| {
                            !call[..i]
                                .chars()
                                .next_back()
                                .is_some_and(|c| c.is_alphanumeric() || c == '_')
                        })
                    })
                    .collect();
                assert!(!methods.is_empty(), "no method for {path}");
                for method in methods {
                    out.push((method.to_string(), format!("{prefix}{path}")));
                }
            }
        }
        out.sort();
        out
    }

    fn documented_routes(doc: &Value) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for (path, item) in doc["paths"].as_object().expect("paths") {
            for method in item.as_object().expect("path item").keys() {
                out.push((method.clone(), path.clone()));
            }
        }
        out.sort();
        out
    }

    fn text(value: &Value) -> bool {
        value.as_str().is_some_and(|s| !s.trim().is_empty())
    }

    fn schema_gaps(at: &str, schema: &Value, gaps: &mut Vec<String>) {
        if let Some(props) = schema["properties"].as_object() {
            for (name, prop) in props {
                let nested = ["allOf", "oneOf", "anyOf"].iter().any(|key| {
                    prop[*key]
                        .as_array()
                        .is_some_and(|parts| parts.iter().any(|p| text(&p["description"])))
                });
                if !text(&prop["description"]) && !nested {
                    gaps.push(format!("{at}.{name}: no description"));
                }
            }
        }
        for key in ["allOf", "oneOf", "anyOf"] {
            if let Some(parts) = schema[key].as_array() {
                for (n, part) in parts.iter().enumerate() {
                    schema_gaps(&format!("{at}.{key}[{n}]"), part, gaps);
                }
            }
        }
    }

    fn doc_gaps(doc: &Value) -> Vec<String> {
        let mut gaps = Vec::new();
        if !text(&doc["info"]["description"]) {
            gaps.push("info: no description".to_string());
        }
        let declared: Vec<&str> = doc["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| text(&t["description"]))
            .filter_map(|t| t["name"].as_str())
            .collect();
        let paths = doc["paths"].as_object().expect("paths");
        for (path, item) in paths {
            for (method, op) in item.as_object().expect("path item") {
                let at = format!("{method} {path}");
                for key in ["summary", "description"] {
                    if !text(&op[key]) {
                        gaps.push(format!("{at}: no {key}"));
                    }
                }
                let tags: Vec<&str> = op["tags"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                if tags.is_empty() {
                    gaps.push(format!("{at}: no tag"));
                }
                for tag in tags.iter().filter(|t| !declared.contains(t)) {
                    gaps.push(format!("{at}: tag {tag} not declared with a description"));
                }
                for param in op["parameters"].as_array().into_iter().flatten() {
                    if !text(&param["description"]) {
                        gaps.push(format!("{at}: parameter {} undocumented", param["name"]));
                    }
                }
                let responses = op["responses"].as_object().expect("responses");
                for (status, res) in responses {
                    if !text(&res["description"]) {
                        gaps.push(format!("{at}: response {status} has no description"));
                    }
                }
                let errors = responses
                    .keys()
                    .any(|s| (s.starts_with('4') || s.starts_with('5')) && s != "429");
                let exempt = NO_ERROR_RESPONSE
                    .iter()
                    .any(|(m, p, _)| *m == method && *p == path);
                if !errors && !exempt {
                    gaps.push(format!("{at}: no error response besides 429"));
                }
            }
        }
        let schemas = doc["components"]["schemas"].as_object().expect("schemas");
        for (name, schema) in schemas {
            if !text(&schema["description"]) {
                gaps.push(format!("schema {name}: no description"));
            }
            schema_gaps(&format!("schema {name}"), schema, &mut gaps);
        }
        gaps
    }

    #[test]
    fn every_operation_and_schema_is_documented() {
        let doc = serde_json::to_value(ApiDoc::openapi()).expect("doc");
        let gaps = doc_gaps(&doc);
        assert!(gaps.is_empty(), "{} gaps:\n{}", gaps.len(), gaps.join("\n"));
    }

    #[test]
    fn the_document_is_valid_json_without_admin_routes() {
        let json = ApiDoc::openapi().to_pretty_json().expect("json");
        let doc: Value = serde_json::from_str(&json).expect("parse");
        assert!(doc["openapi"].as_str().is_some_and(|v| v.starts_with("3.")));
        assert!(doc["paths"].as_object().is_some_and(|p| !p.is_empty()));
        for (method, path) in ADMIN_ROUTES {
            assert!(
                doc["paths"][path].is_null(),
                "{method} {path} is documented, but {ADMIN_REASON}"
            );
        }
        assert!(doc["paths"]["/api/v1/settings"]["patch"].is_null());
        for (name, schema) in doc["components"]["schemas"].as_object().expect("schemas") {
            assert!(
                schema["properties"]["is_site_admin"].is_null(),
                "{name} shows is_site_admin"
            );
        }
        let lower = json.to_lowercase();
        for leak in [
            "site admin",
            "site-admin",
            "is_site_admin",
            "/api/admin",
            "/api/v1/admin",
        ] {
            assert!(!lower.contains(leak), "{leak}");
        }
        if let Ok(out) = std::env::var("RCHAT_OPENAPI_OUT") {
            std::fs::write(out, json).expect("write");
        }
    }

    /// Line and text of every non-ASCII character in `text`.
    fn non_ascii(text: &str) -> Vec<String> {
        text.lines()
            .enumerate()
            .filter(|(_, line)| !line.is_ascii())
            .map(|(n, line)| format!("{}: {}", n + 1, line.trim()))
            .collect()
    }

    #[test]
    fn the_document_is_plain_ascii() {
        let json = serde_json::to_string_pretty(&ApiDoc::openapi()).expect("json");
        let found = non_ascii(&json);
        assert!(found.is_empty(), "non-ASCII text:\n{}", found.join("\n"));
    }

    /// Error messages, WS payload text and every other string the server writes come from
    /// the code outside the test modules, so all of that code is plain ASCII.
    #[test]
    fn server_code_is_plain_ascii() {
        // The legacy forward origin parser input, the bidi controls the name check rejects, and
        // the spoiler reader (line ends as the client reads them, internal markers never sent).
        const ESCAPES_ALLOWED: &[&str] = &[
            ".split_once(\" \\u{b7} \")",
            "matches!(c, '\\u{200E}' | '\\u{200F}'",
            "rest.contains(['\\r', '\\u{2028}', '\\u{2029}'])",
            "(c.is_whitespace() && c as u32 != 0x85) || c == '\\u{feff}'",
            "pub const OPEN: char = '\\u{E000}';",
            "pub const CLOSE: char = '\\u{E001}';",
        ];
        fn non_ascii_escapes(text: &str) -> Vec<String> {
            text.lines()
                .enumerate()
                .filter(|(_, line)| !ESCAPES_ALLOWED.iter().any(|ok| line.contains(ok)))
                .filter(|(_, line)| {
                    line.split("\\u{").skip(1).any(|rest| {
                        let hex = rest.split('}').next().unwrap_or("");
                        u32::from_str_radix(&hex.replace('_', ""), 16).is_ok_and(|c| c > 0x7f)
                    })
                })
                .map(|(n, line)| format!("{}: {}", n + 1, line.trim()))
                .collect()
        }
        fn walk(dir: &std::path::Path, found: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).expect("read src") {
                let path = entry.expect("entry").path();
                let name = path.file_name().and_then(|n| n.to_str());
                match path.extension().and_then(|e| e.to_str()) {
                    _ if name == Some("tests") || name == Some("tests.rs") => {}
                    _ if path.is_dir() => walk(&path, found),
                    Some("rs") => {
                        let src = std::fs::read_to_string(&path).expect("read");
                        let code = &crate::api::test_util::non_test_code(&src);
                        found.extend(
                            non_ascii(code)
                                .into_iter()
                                .chain(non_ascii_escapes(code))
                                .map(|line| format!("{}:{line}", path.display())),
                        );
                    }
                    _ => {}
                }
            }
        }
        let mut found = Vec::new();
        walk(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut found,
        );
        assert!(found.is_empty(), "non-ASCII text:\n{}", found.join("\n"));
    }

    #[test]
    fn every_registered_route_is_documented() {
        let registered = registered_routes();
        for (method, path) in ADMIN_ROUTES {
            assert!(
                registered.contains(&(method.to_string(), path.to_string())),
                "{method} {path} is no longer registered; update ADMIN_ROUTES"
            );
        }
        let skipped = |m: &str, p: &str| {
            ADMIN_ROUTES.contains(&(m, p))
                || UNDOCUMENTED.iter().any(|(um, up, _)| (*um, *up) == (m, p))
        };
        let expected: Vec<(String, String)> = registered
            .iter()
            .filter(|(m, p)| !skipped(m, p))
            .cloned()
            .collect();
        let doc = serde_json::to_value(ApiDoc::openapi()).expect("doc");
        let documented = documented_routes(&doc);
        let missing: Vec<_> = expected
            .iter()
            .filter(|r| !documented.contains(r))
            .collect();
        let extra: Vec<_> = documented
            .iter()
            .filter(|r| !expected.contains(r))
            .collect();
        assert!(
            missing.is_empty(),
            "registered but not documented: {missing:?}"
        );
        assert!(extra.is_empty(), "documented but not registered: {extra:?}");
    }

    async fn answer(
        client: &reqwest::Client,
        base: &str,
        method: &str,
        path: &str,
        n: usize,
    ) -> u16 {
        let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).expect("method");
        client
            .request(method, format!("{base}{path}"))
            .header(
                "x-forwarded-for",
                format!("10.{}.{}.{}", n >> 16 & 255, n >> 8 & 255, n & 255),
            )
            .send()
            .await
            .expect("answer")
            .status()
            .as_u16()
    }

    #[tokio::test]
    async fn every_route_answers_on_both_prefixes() {
        use crate::config::{AppConfig, Roles};
        use crate::server::client_ip::ProxyTrust;
        use crate::server::route_builder::{api_router, resolve_versions};
        let (state, path) = crate::api::test_util::temp_state("both_prefixes").await;
        let config = AppConfig {
            roles: Roles {
                web: false,
                ..Roles::ALL
            },
            proxy_trust: ProxyTrust::Any,
            ..AppConfig::defaults()
        };
        const UNROUTED: u16 = 418;
        let app = resolve_versions(
            api_router(&config, state.clone())
                .fallback(|| async { axum::http::StatusCode::IM_A_TEAPOT }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await;
        });
        let client = reqwest::Client::new();
        let routes: Vec<(String, String)> = registered_routes()
            .into_iter()
            .filter_map(|(m, p)| Some((m, p.strip_prefix("/api/v1/")?.to_string())))
            .collect();
        assert!(routes.len() > 100, "{} routes", routes.len());
        let mut wrong = Vec::new();
        for (i, (method, rest)) in routes.iter().enumerate() {
            let rest = rest
                .split('/')
                .map(|seg| match seg.starts_with('{') {
                    true => "1",
                    false => seg,
                })
                .collect::<Vec<_>>()
                .join("/");
            let pinned = answer(&client, &base, method, &format!("/api/v1/{rest}"), 2 * i).await;
            let latest = answer(&client, &base, method, &format!("/api/{rest}"), 2 * i + 1).await;
            if pinned == UNROUTED || pinned == 405 || pinned != latest {
                wrong.push(format!("{method} {rest}: /api/v1 {pinned}, /api {latest}"));
            }
        }
        for unrouted in ["/api/v1/nope", "/api/nope", "/api/v1/v1/me"] {
            assert_eq!(
                answer(&client, &base, "get", unrouted, 0).await,
                UNROUTED,
                "{unrouted}"
            );
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
        server.abort();
        crate::api::test_util::done(state, path).await;
    }

    #[test]
    fn me_still_serializes_is_site_admin() {
        let me = Me {
            username: "alice".to_string(),
            display_name: "Alice".to_string(),
            avatar_kind: AvatarKind::Identicon,
            avatar_color: None,
            banner_color: None,
            bio: None,
            is_site_admin: true,
            appear_offline: false,
            password_kind: "text".to_string(),
            servers: Vec::new(),
            servers_more: false,
            servers_cursor: None,
            dms: Vec::new(),
            dms_more: false,
            dms_cursor: None,
        };
        let value = serde_json::to_value(me).expect("me");
        assert_eq!(value["is_site_admin"], Value::Bool(true));
    }

    #[test]
    fn settings_schema_lists_profanity_targets() {
        let doc = serde_json::to_value(ApiDoc::openapi()).expect("doc");
        let schemas = &doc["components"]["schemas"];
        let settings = &schemas["Settings"]["properties"];
        assert!(settings["profanity_filter"].is_object());
        assert!(settings["profanity_targets"].is_object());
        for key in [
            "messages",
            "links",
            "usernames",
            "server_names",
            "channel_names",
            "role_names",
            "file_names",
            "bios",
            "channel_topics",
            "category_names",
        ] {
            assert!(
                schemas["ProfanityTargets"]["properties"][key].is_object(),
                "{key}"
            );
        }
        assert!(schemas["ProfanityTargets"]["properties"]["display_names"].is_null());
        for f in crate::api::features::Feature::ALL {
            assert_eq!(settings[f.key()]["type"], "boolean", "{f:?}");
        }
        assert!(settings["registration"].is_object());
        let text = serde_json::to_string(&schemas["Settings"]).expect("text");
        assert!(text.is_ascii());
    }

    #[test]
    fn swagger_ui_flag() {
        for off in ["false", "0", " OFF ", "no"] {
            assert!(!swagger_on(Some(off)), "{off}");
        }
        for on in [None, Some("true"), Some("1"), Some("")] {
            assert!(swagger_on(on), "{on:?}");
        }
    }
}
