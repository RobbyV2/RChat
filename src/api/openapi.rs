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
                            "A session token from `POST /api/auth/register` or `POST /api/auth/login`, sent as `Authorization: Bearer <token>`. Tokens do not expire; `POST /api/auth/logout` revokes one, and a password change revokes all others. An unknown token on an endpoint that also allows guests is treated as no token.",
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
        super::auth::me,
        super::auth::patch_me,
        super::auth::change_password,
        super::auth::logout,
        super::users::profile,
        super::servers::list_my_servers,
        super::servers::create_server,
        super::servers::get_server,
        super::servers::server_exists,
        super::servers::get_invite,
        super::servers::search_servers,
        super::servers::guest_access,
        super::servers::list_members,
        super::servers::list_interacted,
        super::servers::join_server,
        super::servers::leave_server,
        super::servers::update_server,
        super::servers::delete_server,
        super::servers::create_channel,
        super::servers::update_channel,
        super::servers::delete_channel,
        super::servers::kick_member,
        super::servers::ban_member,
        super::servers::unban_member,
        super::servers::list_bans,
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
        super::messages::search,
        super::messages::unreads,
        super::messages::mark_read,
        super::embeds::delete_embed,
        super::dms::list_dms,
        super::dms::open_dm,
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
        crate::ws::handler,
    ),
    components(schemas(super::ApiErrorBody)),
    servers((url = "/", description = "The instance serving this document")),
    modifiers(&Bearer),
    info(
        title = "RChat API",
        version = env!("CARGO_PKG_VERSION"),
        description = "RChat is a self-hosted chat server: servers with text and voice channels, roles and per-channel permissions, threads, direct messages with calls, media uploads, link previews and search. This document covers the REST API under `/api` plus the `/.well-known` discovery documents.

**Authentication.** Register or log in to get a session token and send it as `Authorization: Bearer <token>`. Endpoints marked with an optional security requirement also work without a token for guests, when the instance has guest access turned on (`guests_enabled` in `GET /api/settings`); otherwise they answer 401. Guests are read-only. Password-protected servers additionally need a guest grant from `POST /api/servers/{name}/guest_access`, sent in the `X-Guest-Grant` header (comma-separated, up to 100 grants).

**Names.** Server names and usernames are case-insensitive: they are matched by their lowercase form, and responses carry the lowercase `name`/`username` alongside the original-case `display_name`.

**Timestamps** are Unix time in seconds unless a field says otherwise.

**Pagination.** List endpoints return a JSON array. When more items follow, the `X-Next-Cursor` response header holds an opaque cursor; pass it back as the `cursor` query parameter for the next page. The header is absent on the last page. Each endpoint lists its page size and limits.

**Rate limits.** Every `/api` route except `/api/health` and `/api/ready` shares a general per-client-IP bucket (`RATE_LIMIT_PER_SECOND`, default 10 per second, burst `RATE_LIMIT_BURST`, default 60). The `/.well-known` routes have their own general bucket of the same size, separate from the `/api` one. Register, login, word hints, password change, guest access and media upload also share a strict per-IP bucket (2 per second, burst 30). Invite previews and joining a server each have their own bucket of the same size. Exceeding a bucket answers 429 with a plain-text body.

**Errors.** Errors raised by the API come as JSON `{\"error\": \"...\"}` (`ApiErrorBody`). Malformed JSON bodies are rejected by the framework with a plain-text 400, 415 or 422.

**Realtime.** `GET /api/ws` upgrades to a WebSocket. Clients send JSON frames tagged by `type` (`auth` first, with the token or without one for a guest, then `viewing`, `subscribe`, voice, call and `rtc_signal` frames) and receive JSON events tagged by `type` in snake_case (`message`, `message_updated`, `message_deleted`, `member_joined`, `presence_changed`, `read_updated`, `voice_state`, `call_state` and more; see `WsEvent` in `src/ws.rs`). The REST operations below name the events they emit."
    ),
    tags(
        (name = "Auth", description = "Create accounts, sign in and out, and look up word-password hints."),
        (name = "Account", description = "The signed-in user's own account: profile, preferences and password."),
        (name = "Users", description = "Public profiles of other users."),
        (name = "Servers", description = "Create, browse, join, leave and configure servers."),
        (name = "Members", description = "Server member lists."),
        (name = "Moderation", description = "Kicks, bans and server admins. Each operation needs the matching server permission."),
        (name = "Roles", description = "Server roles: colored names with permission bits, assigned to members."),
        (name = "Channels", description = "Text and voice channels and their per-role or per-user permission overrides."),
        (name = "Messages", description = "Channel messages, deletion, link previews and read state."),
        (name = "Threads", description = "Replies attached to a root message."),
        (name = "Direct messages", description = "One-to-one conversations, including the conversation with yourself."),
        (name = "Media", description = "File uploads attached to messages, and downloads."),
        (name = "Search", description = "Message and server search."),
        (name = "Invites", description = "Invite link previews."),
        (name = "Realtime", description = "The WebSocket gateway for live events, presence, voice and calls."),
        (name = "Instance", description = "Instance discovery, public settings and identity assertions for federation."),
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

pub fn routes() -> Router<AppState> {
    let router = Router::new().route("/openapi.json", get(openapi_json));
    match swagger_on(std::env::var("SWAGGER_UI").ok().as_deref()) {
        true => {
            router.merge(SwaggerUi::new("/swagger-ui").url("/api/openapi.json", ApiDoc::openapi()))
        }
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
            "/api/health",
            "liveness only reports that the process answers; it is outside every rate limiter and cannot fail",
        ),
        (
            "get",
            "/api/auth/words/{username}",
            "any username gets a word set, derived from the name without a database lookup",
        ),
        (
            "get",
            "/api/settings",
            "public, no input; answers the cached settings and only the rate limiter can refuse it",
        ),
        (
            "get",
            "/api/instance",
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
        ("patch", "/api/admin/settings"),
        ("get", "/api/admin/overview"),
        ("get", "/api/admin/users"),
        ("get", "/api/admin/servers"),
        ("delete", "/api/admin/servers/{name}"),
        ("delete", "/api/admin/users/{username}"),
        ("get", "/api/admin/users/{username}/servers"),
        ("delete", "/api/admin/messages/{id}"),
        ("post", "/api/admin/ban"),
    ];

    const UNDOCUMENTED: [(&str, &str, &str); 1] = [(
        "get",
        "/api/openapi.json",
        "serves this document itself, next to Swagger UI",
    )];

    const ADMIN_REASON: &str =
        "site-admin only; site admins must stay hidden, so the public document leaves these out";

    const ROUTE_SOURCES: [(&str, &str); 4] = [
        ("/api", include_str!("mod.rs")),
        ("/api", include_str!("health.rs")),
        ("/api", include_str!("openapi.rs")),
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
        assert!(doc["paths"]["/api/settings"]["patch"].is_null());
        for (name, schema) in doc["components"]["schemas"].as_object().expect("schemas") {
            assert!(
                schema["properties"]["is_site_admin"].is_null(),
                "{name} shows is_site_admin"
            );
        }
        let lower = json.to_lowercase();
        for leak in ["site admin", "site-admin", "is_site_admin", "/api/admin"] {
            assert!(!lower.contains(leak), "{leak}");
        }
        if let Ok(out) = std::env::var("RCHAT_OPENAPI_OUT") {
            std::fs::write(out, json).expect("write");
        }
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
        ] {
            assert!(
                schemas["ProfanityTargets"]["properties"][key].is_object(),
                "{key}"
            );
        }
        assert!(schemas["ProfanityTargets"]["properties"]["display_names"].is_null());
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
