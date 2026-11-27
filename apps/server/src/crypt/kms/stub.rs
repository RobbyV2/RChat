//! A key service held in memory for tests: the Transit engine's `encrypt` and `decrypt` with a
//! derived-key binding to the context, a token check, and a count of the calls.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use super::super::{Key, NONCE_LEN, decrypt, encrypt, random_key};

const PREFIX: &str = "vault:v1:";

#[derive(Default)]
struct Inner {
    token: String,
    keys: Mutex<HashMap<String, Key>>,
    calls: AtomicUsize,
    down: AtomicBool,
    ignores_context: AtomicBool,
}

#[derive(Clone, Default)]
pub(crate) struct Stub {
    inner: Arc<Inner>,
}

impl Stub {
    /// A stub listening on a free local port that takes `token`, and its Transit address.
    pub(crate) async fn start(token: &str) -> (Stub, String) {
        let stub = Stub {
            inner: Arc::new(Inner {
                token: token.to_owned(),
                ..Inner::default()
            }),
        };
        let app = Router::new()
            .route("/v1/transit/{op}/{key}", post(handle))
            .with_state(stub.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (stub, format!("http://127.0.0.1:{port}/v1/transit"))
    }

    /// How many requests it answered.
    pub(crate) fn calls(&self) -> usize {
        self.inner.calls.load(Ordering::SeqCst)
    }

    /// Makes it answer 503 to everything, as a sealed Vault does.
    pub(crate) fn set_down(&self, down: bool) {
        self.inner.down.store(down, Ordering::SeqCst);
    }

    /// Makes it ignore the context, as a key made without derivation does.
    pub(crate) fn ignore_context(&self, ignores: bool) {
        self.inner.ignores_context.store(ignores, Ordering::SeqCst);
    }

    /// Replaces the key named `key`: what the old one wrapped no longer opens.
    pub(crate) fn replace(&self, key: &str) {
        self.inner
            .keys
            .lock()
            .expect("keys")
            .insert(key.to_owned(), random_key());
    }
}

fn answer(status: StatusCode, body: serde_json::Value) -> Response {
    (status, body.to_string()).into_response()
}

fn refused(status: StatusCode, why: &str) -> Response {
    answer(status, serde_json::json!({ "errors": [why] }))
}

async fn handle(
    State(stub): State<Stub>,
    Path((op, key)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let inner = &stub.inner;
    inner.calls.fetch_add(1, Ordering::SeqCst);
    if inner.down.load(Ordering::SeqCst) {
        return refused(StatusCode::SERVICE_UNAVAILABLE, "Vault is sealed");
    }
    let token = headers.get("x-vault-token").and_then(|v| v.to_str().ok());
    if token != Some(inner.token.as_str()) {
        return refused(StatusCode::FORBIDDEN, "permission denied");
    }
    let Ok(body) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return refused(StatusCode::BAD_REQUEST, "failed to parse JSON input");
    };
    let decoded = |field: &str| body[field].as_str().and_then(|v| STANDARD.decode(v).ok());
    let context = match inner.ignores_context.load(Ordering::SeqCst) {
        true => Vec::new(),
        false => decoded("context").unwrap_or_default(),
    };
    let material = inner
        .keys
        .lock()
        .expect("keys")
        .entry(key)
        .or_insert_with(random_key)
        .clone();
    match op.as_str() {
        "encrypt" => {
            let Some(plain) = decoded("plaintext") else {
                return refused(StatusCode::BAD_REQUEST, "missing plaintext to encrypt");
            };
            let nonce = rand::random::<[u8; NONCE_LEN]>();
            let mut sealed = nonce.to_vec();
            sealed.extend(encrypt(&material, &nonce, &context, &plain));
            let ciphertext = format!("{PREFIX}{}", STANDARD.encode(sealed));
            answer(
                StatusCode::OK,
                serde_json::json!({ "data": { "ciphertext": ciphertext, "key_version": 1 } }),
            )
        }
        "decrypt" => {
            let sealed = body["ciphertext"]
                .as_str()
                .and_then(|c| c.strip_prefix(PREFIX))
                .and_then(|c| STANDARD.decode(c).ok())
                .filter(|s| s.len() > NONCE_LEN);
            let Some(sealed) = sealed else {
                return refused(StatusCode::BAD_REQUEST, "invalid ciphertext");
            };
            let (nonce, rest) = sealed.split_at(NONCE_LEN);
            match decrypt(&material, nonce, &context, rest) {
                Ok(plain) => answer(
                    StatusCode::OK,
                    serde_json::json!({ "data": { "plaintext": STANDARD.encode(plain) } }),
                ),
                Err(_) => refused(
                    StatusCode::BAD_REQUEST,
                    "cipher: message authentication failed",
                ),
            }
        }
        _ => refused(StatusCode::NOT_FOUND, "unsupported path"),
    }
}
