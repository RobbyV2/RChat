use axum::Router;

use crate::config::AppConfig;
use crate::state::AppState;

pub mod route_builder;

pub fn build_router(proxy_url: Option<&str>, config: &AppConfig, state: AppState) -> Router {
    route_builder::register_routes(proxy_url, config, state)
}
