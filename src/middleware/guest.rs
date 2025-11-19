use axum::{extract::Request, http::StatusCode, middleware::Next, response::Response};

pub async fn allow_guest_access(request: Request, next: Next) -> Result<Response, StatusCode> {
    let auth_header = request.headers().get("authorization");

    match auth_header {
        Some(_) => Ok(next.run(request).await),
        None => Ok(next.run(request).await),
    }
}

pub fn is_guest_user(auth_header: Option<&str>) -> bool {
    auth_header.is_none()
}
