pub mod admin;
pub mod auth;
pub mod channels;
pub mod direct_messages;
pub mod files;
pub mod public;
pub mod servers;
pub mod unified_messages;
pub mod users;

use axum::Router;
use std::sync::Arc;

pub use auth::AppState;

pub fn routes(state: Arc<AppState>) -> Router {
    let ws_route = Router::new()
        .route(
            "/ws",
            axum::routing::get(crate::websocket::handlers::ws_handler),
        )
        .with_state(state.clone());

    let protected_routes = Router::new()
        .nest("/messages", unified_messages::routes(state.clone()))
        .nest("/servers", servers::routes(state.clone()))
        .nest("/channels", channels::routes(state.clone()))
        .nest("/dms", direct_messages::routes(state.clone()))
        .nest("/files", files::routes(state.clone()))
        .nest("/users", users::router().with_state(state.clone()))
        .nest("/admin", admin::routes(state.clone()))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::middleware::auth::auth_middleware,
        ));

    Router::new()
        .merge(ws_route)
        .nest("/auth", auth::routes(state.clone()))
        .nest("/public", public::routes(state.clone()))
        .nest("/downloads", files::public_routes(state.clone()))
        .merge(protected_routes)
}
