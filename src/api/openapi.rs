use axum::Json;
use axum::Router;
use axum::routing::get;
use utoipa::openapi::security::{Http, HttpAuthScheme, SecurityScheme};
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
                SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
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
    modifiers(&Bearer),
    info(title = "RChat API", version = env!("CARGO_PKG_VERSION"))
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
    use utoipa::OpenApi;

    use super::{ApiDoc, swagger_on};

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
