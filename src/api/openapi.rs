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
        super::servers::create_server,
        super::servers::get_server,
        super::servers::server_exists,
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
        crate::ws::handler,
    ),
    modifiers(&Bearer),
    info(title = "RChat API", version = env!("CARGO_PKG_VERSION"))
)]
pub struct ApiDoc;

async fn openapi_json() -> Json<utoipa::openapi::OpenApi> {
    Json(ApiDoc::openapi())
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/openapi.json", get(openapi_json))
        .merge(SwaggerUi::new("/swagger-ui").url("/api/openapi.json", ApiDoc::openapi()))
}
