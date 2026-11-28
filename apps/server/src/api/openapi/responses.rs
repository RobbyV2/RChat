//! Every JSON answer a walk over the GET routes of the full document gets matches the schema
//! the document gives for its status: the fields serde writes and the fields the document
//! names are the same, with the same types.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::Value;

use crate::api::access::subjects_walk::{Side, serve, wide, world};
use crate::api::openapi::ApiDoc;
use crate::api::test_util::{done, temp_state};
use crate::db::secret_key;

fn resolve<'a>(doc: &'a Value, schema: &'a Value) -> &'a Value {
    match schema["$ref"].as_str() {
        Some(to) => {
            let name = to.strip_prefix("#/components/schemas/").expect("local ref");
            resolve(doc, &doc["components"]["schemas"][name])
        }
        None => schema,
    }
}

/// The fields an object schema names, through its `allOf` parts; `None` when it takes any
/// field (no `properties`, or `additionalProperties`).
fn known(doc: &Value, schema: &Value) -> Option<BTreeSet<String>> {
    let schema = resolve(doc, schema);
    let mut names = BTreeSet::new();
    let mut closed = false;
    if let Some(props) = schema["properties"].as_object() {
        names.extend(props.keys().cloned());
        closed = true;
    }
    if let Some(parts) = schema["allOf"].as_array() {
        for part in parts {
            names.extend(known(doc, part)?);
            closed = true;
        }
    }
    let open = !schema["additionalProperties"].is_null()
        && schema["additionalProperties"] != Value::Bool(false);
    (closed && !open).then_some(names)
}

fn type_fits(value: &Value, ty: &str) -> bool {
    match ty {
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "integer" => value.is_i64() || value.is_u64(),
        "number" => value.is_number(),
        "string" => value.is_string(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => true,
    }
}

/// What in `value` does not fit `schema`, each with where it is.
fn check(doc: &Value, value: &Value, schema: &Value, at: &str, out: &mut Vec<String>) {
    check_part(doc, value, schema, at, true, out);
}

fn check_part(
    doc: &Value,
    value: &Value,
    schema: &Value,
    at: &str,
    whole: bool,
    out: &mut Vec<String>,
) {
    let schema = resolve(doc, schema);
    for key in ["oneOf", "anyOf"] {
        if let Some(parts) = schema[key].as_array() {
            let mut best: Option<Vec<String>> = None;
            for part in parts {
                let mut found = Vec::new();
                check(doc, value, part, at, &mut found);
                if found.is_empty() {
                    best = Some(found);
                    break;
                }
                if best.as_ref().is_none_or(|b| found.len() < b.len()) {
                    best = Some(found);
                }
            }
            out.extend(best.unwrap_or_default());
        }
    }
    if let Some(parts) = schema["allOf"].as_array() {
        for part in parts {
            check_part(doc, value, part, at, false, out);
        }
    }
    let fits = match &schema["type"] {
        Value::String(ty) => type_fits(value, ty),
        Value::Array(types) => types
            .iter()
            .filter_map(Value::as_str)
            .any(|ty| type_fits(value, ty)),
        _ => true,
    };
    if !fits {
        out.push(format!("{at}: {value} is not {}", schema["type"]));
        return;
    }
    if let Some(values) = schema["enum"].as_array()
        && !values.contains(value)
    {
        out.push(format!("{at}: {value} is not one of {}", schema["enum"]));
    }
    if let (Some(items), Some(schema_items)) = (value.as_array(), schema.get("items")) {
        for (n, item) in items.iter().enumerate() {
            check(doc, item, schema_items, &format!("{at}[{n}]"), out);
        }
    }
    let Some(fields) = value.as_object() else {
        return;
    };
    for name in schema["required"].as_array().into_iter().flatten() {
        if let Some(name) = name.as_str()
            && !fields.contains_key(name)
        {
            out.push(format!("{at}.{name}: missing"));
        }
    }
    let props = schema["properties"].as_object();
    for (name, inner) in fields {
        match props.and_then(|p| p.get(name)) {
            Some(prop) => check(doc, inner, prop, &format!("{at}.{name}"), out),
            None => {
                if let Some(extra) = schema.get("additionalProperties")
                    && extra.is_object()
                {
                    check(doc, inner, extra, &format!("{at}.{name}"), out);
                }
            }
        }
    }
    if whole && let Some(names) = known(doc, schema) {
        for name in fields.keys().filter(|name| !names.contains(*name)) {
            out.push(format!("{at}.{name}: not in the schema"));
        }
    }
}

/// The path with its parameters filled from zed's world, or `None` when a parameter has no
/// value the walk knows.
fn filled(path: &str, zed: &Side) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    let mut out = Vec::with_capacity(parts.len());
    for (n, part) in parts.iter().enumerate() {
        let Some(name) = part.strip_prefix('{').and_then(|p| p.strip_suffix('}')) else {
            out.push(part.to_string());
            continue;
        };
        let owner = n.checked_sub(1).map(|i| parts[i]).unwrap_or_default();
        let value = match (owner, name) {
            ("servers", "name") => zed.server.to_string(),
            ("users", "username") => zed.user.to_string(),
            ("channels", "id") => zed.channel.to_string(),
            ("messages" | "polls", "id") => zed.message.to_string(),
            ("dms", "id") => zed.dm.to_string(),
            ("categories", "id") => zed.category.to_string(),
            _ => return None,
        };
        out.push(value);
    }
    Some(out.join("/"))
}

/// Required query parameters the walk can fill.
fn query(path: &str, zed: &Side) -> Option<String> {
    match path {
        "/api/v1/seal_jobs" => Some(format!("?place=s:{}", zed.server)),
        _ => None,
    }
}

#[tokio::test]
async fn responses_match_their_schema() {
    let (state, path) = temp_state("responses_schema").await;
    let state = state.with_limits(Arc::new(wide()));
    let db = state.db.clone();
    let (zed, _) = world(&db).await;
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, 'root', $2)")
        .bind(secret_key("tok-root"))
        .bind(crate::db::now())
        .execute(&db)
        .await
        .expect("token");
    let doc = serde_json::to_value(ApiDoc::full()).expect("doc");
    let (base, server) = serve(&state).await;
    let client = reqwest::Client::new();
    let mut wrong = Vec::new();
    let mut checked = 0;
    let mut skipped = Vec::new();
    for (path, item) in doc["paths"].as_object().expect("paths") {
        let Some(op) = item.get("get") else {
            continue;
        };
        let required_query = op["parameters"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|p| p["in"] == "query" && p["required"] == true);
        let Some(url) = filled(path, &zed).and_then(|p| match required_query {
            true => query(path, &zed).map(|q| format!("{p}{q}")),
            false => Some(p),
        }) else {
            skipped.push(path.clone());
            continue;
        };
        let token = match path.starts_with("/api/v1/admin/") {
            true => "tok-root",
            false => "tok-zed",
        };
        let res = client
            .get(format!("{base}{url}"))
            .bearer_auth(token)
            .header("x-forwarded-for", format!("10.9.0.{}", checked % 250))
            .send()
            .await
            .expect("answer");
        let status = res.status().as_u16().to_string();
        let json = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("application/json"));
        let text = res.text().await.expect("body");
        let Some(schema) = op["responses"][&status]["content"]["application/json"].get("schema")
        else {
            continue;
        };
        if !json {
            continue;
        }
        let body: Value = serde_json::from_str(&text).expect("json body");
        let mut found = Vec::new();
        check(&doc, &body, schema, "body", &mut found);
        checked += 1;
        wrong.extend(
            found
                .into_iter()
                .map(|f| format!("GET {url} {status}: {f}")),
        );
    }
    println!("checked {checked} answers, skipped {}", skipped.len());
    assert!(checked > 60, "{checked} answers checked");
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    server.abort();
    done(state, path).await;
}

#[test]
fn the_check_finds_what_differs() {
    let doc = serde_json::json!({"components": {"schemas": {
        "Thing": {"type": "object", "required": ["id"], "properties": {
            "id": {"type": "integer"},
            "name": {"type": ["string", "null"]},
            "kind": {"type": "string", "enum": ["a", "b"]}
        }}
    }}});
    let schema = serde_json::json!({"$ref": "#/components/schemas/Thing"});
    let found = |value: Value| {
        let mut out = Vec::new();
        check(&doc, &value, &schema, "body", &mut out);
        out
    };
    assert!(found(serde_json::json!({"id": 1, "name": null, "kind": "a"})).is_empty());
    assert_eq!(
        found(serde_json::json!({"name": "x"})),
        ["body.id: missing"]
    );
    assert_eq!(
        found(serde_json::json!({"id": 1, "extra": 2})),
        ["body.extra: not in the schema"]
    );
    assert_eq!(found(serde_json::json!({"id": "1"})).len(), 1);
    assert_eq!(found(serde_json::json!({"id": 1, "kind": "c"})).len(), 1);
}
