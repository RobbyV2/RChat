//! An S3 bucket held in memory for tests: path-style `PUT`, `GET`, `HEAD` and `DELETE` of
//! objects, with no signature check.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use s3::creds::Credentials;
use s3::{Bucket, Region};

/// An object as the stub keeps it: its content type and bytes.
pub(crate) type Object = (String, Vec<u8>);

#[derive(Clone, Default)]
pub(crate) struct Stub {
    objects: Arc<Mutex<BTreeMap<String, Object>>>,
}

impl Stub {
    /// A stub listening on a free local port, and a bucket that talks to it.
    pub(crate) async fn start() -> (Stub, Arc<Bucket>) {
        let stub = Stub::default();
        let app = Router::new()
            .route("/{bucket}/{*key}", any(handle))
            .with_state(stub.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let region = Region::Custom {
            region: "us-east-1".into(),
            endpoint: format!("http://127.0.0.1:{port}"),
        };
        let creds = Credentials::new(Some("stub"), Some("stub"), None, None, None).expect("creds");
        let bucket = Bucket::new("media", region, creds)
            .expect("bucket")
            .with_path_style();
        (stub, Arc::from(bucket))
    }

    pub(crate) fn object(&self, key: &str) -> Option<Object> {
        self.objects.lock().expect("objects").get(key).cloned()
    }

    pub(crate) fn put(&self, key: &str, object: Object) {
        self.objects
            .lock()
            .expect("objects")
            .insert(key.to_string(), object);
    }
}

async fn handle(
    State(stub): State<Stub>,
    method: Method,
    Path((_, key)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut objects = stub.objects.lock().expect("objects");
    match method {
        Method::PUT => {
            let kind = headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            objects.insert(key, (kind, body.to_vec()));
            (StatusCode::OK, [(header::ETAG, "\"stub\"")]).into_response()
        }
        Method::GET | Method::HEAD => match objects.get(&key) {
            Some((kind, data)) => {
                let body = match method {
                    Method::HEAD => Vec::new(),
                    _ => data.clone(),
                };
                (StatusCode::OK, [(header::CONTENT_TYPE, kind.clone())], body).into_response()
            }
            None => StatusCode::NOT_FOUND.into_response(),
        },
        Method::DELETE => {
            objects.remove(&key);
            StatusCode::NO_CONTENT.into_response()
        }
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}
