//! Golden JSON for every event: the client frame and the bus wire of one sample per variant.
//! `UPDATE_FIXTURES=1` writes `wire_vectors.json` from the event schema.

use serde_json::{Map, Value, json};
use utoipa::OpenApi;

use super::*;
use crate::ws::doc::EventDoc;
use crate::ws::event::to_bus_json;

const FILE: &str = "src/ws/tests/wire_vectors.json";

fn schemas() -> Value {
    serde_json::to_value(EventDoc::openapi()).expect("doc")["components"]["schemas"].clone()
}

fn tag_of(part: &Value) -> Option<String> {
    part["properties"]["type"]["enum"][0]
        .as_str()
        .or_else(|| {
            part["allOf"]
                .as_array()?
                .iter()
                .find_map(|inner| inner["properties"]["type"]["enum"][0].as_str())
        })
        .map(str::to_string)
}

/// A value the schema `schema` allows, with every property filled.
fn sample(all: &Value, schema: &Value, depth: usize) -> Value {
    if depth > 40 {
        return Value::Null;
    }
    if let Some(r) = schema["$ref"].as_str() {
        let name = r.rsplit('/').next().expect("ref");
        return sample(all, &all[name], depth + 1);
    }
    if let Some(parts) = schema["allOf"].as_array() {
        let mut out = Map::new();
        for part in parts {
            if let Value::Object(o) = sample(all, part, depth + 1) {
                out.extend(o);
            }
        }
        return Value::Object(out);
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(parts) = schema[key].as_array() {
            let part = parts
                .iter()
                .find(|p| p["type"] != "null")
                .unwrap_or(&parts[0]);
            return sample(all, part, depth + 1);
        }
    }
    if let Some(first) = schema["enum"].as_array().and_then(|e| e.first()) {
        return first.clone();
    }
    let kind = match &schema["type"] {
        Value::Array(kinds) => kinds
            .iter()
            .filter_map(Value::as_str)
            .find(|k| *k != "null")
            .unwrap_or("null")
            .to_string(),
        Value::String(k) => k.clone(),
        _ if schema["properties"].is_object() => "object".to_string(),
        _ => "null".to_string(),
    };
    match kind.as_str() {
        "string" => json!("s"),
        "integer" => json!(1),
        "number" => json!(1.5),
        "boolean" => json!(true),
        "array" => json!([sample(all, &schema["items"], depth + 1)]),
        "object" => {
            let mut out = Map::new();
            if let Some(props) = schema["properties"].as_object() {
                for (name, prop) in props {
                    out.insert(name.clone(), sample(all, prop, depth + 1));
                }
            }
            Value::Object(out)
        }
        _ => Value::Null,
    }
}

const GUESSES: [fn() -> Value; 8] = [
    || json!("s"),
    || json!(1),
    || json!(true),
    || json!(["s"]),
    || json!([1]),
    || json!([1, true]),
    || json!({"restrict": {"view": true, "send": true}, "rules": [], "everyone": 1}),
    || json!({}),
];

/// The fields each variant declares, read from its definition, by `type` tag.
fn declared() -> std::collections::HashMap<String, Vec<String>> {
    let src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/ws/event.rs"),
    )
    .expect("event source");
    let body = &src[src.find("pub enum WsEvent {").expect("enum")..];
    let body = &body[..body.find("\n}\n").expect("end")];
    let mut out = std::collections::HashMap::new();
    let mut current: Option<String> = None;
    for line in body.lines() {
        let t = line.trim();
        if line.starts_with("    ") && !line.starts_with("        ") {
            let name: String = t.chars().take_while(|c| c.is_alphanumeric()).collect();
            if name.chars().next().is_some_and(char::is_uppercase) {
                let mut snake = String::new();
                for (i, c) in name.chars().enumerate() {
                    if c.is_uppercase() && i > 0 {
                        snake.push('_');
                    }
                    snake.push(c.to_ascii_lowercase());
                }
                out.entry(snake.clone()).or_insert_with(Vec::new);
                current = Some(snake);
            }
        } else if let (Some(v), Some((field, _))) = (&current, t.split_once(": ")) {
            let field = field.trim_start_matches("pub ");
            if !field.starts_with("//") && field.chars().all(|c| c.is_alphanumeric() || c == '_') {
                out.get_mut(v).expect("variant").push(field.to_string());
            }
        }
    }
    out
}

/// Fills `key` of `wire` with the first guess the decoder takes and that changes the bus wire.
fn fill(wire: &mut Value, key: &str, bus_before: &str) -> bool {
    let fit = GUESSES.iter().map(|g| g()).find(|guess| {
        let mut tried = wire.clone();
        tried[key] = guess.clone();
        serde_json::from_value::<WsEvent>(tried)
            .ok()
            .is_some_and(|ev| to_bus_json(&ev).expect("bus") != bus_before)
    });
    match fit {
        Some(v) => {
            wire[key] = v;
            true
        }
        None => false,
    }
}

/// The schema sample of one variant made into an event the bus decodes, with the routing
/// fields the schema leaves out given a value: each field the decoder asks for, leaves empty or
/// leaves out gets the first guess it accepts.
fn event_of(mut wire: Value, fields: &[String]) -> WsEvent {
    let mut tried = std::collections::HashSet::new();
    for _ in 0..64 {
        let err = match serde_json::from_value::<WsEvent>(wire.clone()) {
            Ok(ev) => {
                let bus: Value = serde_json::from_str(&to_bus_json(&ev).expect("bus")).expect("j");
                let empty = bus.as_object().expect("object").iter().find(|(k, v)| {
                    wire.get(k.as_str()).is_none()
                        && (v.is_null() || v.as_array().is_some_and(Vec::is_empty))
                });
                let bus_text = to_bus_json(&ev).expect("bus");
                let next = empty
                    .map(|(k, _)| k.clone())
                    .into_iter()
                    .chain(
                        fields
                            .iter()
                            .filter(|f| wire.get(f.as_str()).is_none())
                            .cloned(),
                    )
                    .find(|k| !tried.contains(k));
                let Some(key) = next else {
                    return ev;
                };
                tried.insert(key.clone());
                if !fill(&mut wire, &key, &bus_text)
                    && wire.get(key.as_str()).is_none()
                    && let Some(Value::Object(inner)) = bus.get(key.as_str())
                {
                    let mut filled = Value::Object(inner.clone());
                    for (k, v) in inner {
                        if v.as_array().is_some_and(Vec::is_empty) {
                            filled[k.as_str()] = json!(["s"]);
                        }
                    }
                    let mut with = wire.clone();
                    with[key.as_str()] = filled;
                    if serde_json::from_value::<WsEvent>(with.clone()).is_ok() {
                        wire = with;
                    }
                }
                continue;
            }
            Err(e) => e.to_string(),
        };
        let missing = err
            .split("missing field `")
            .nth(1)
            .and_then(|r| r.split('`').next())
            .unwrap_or_else(|| panic!("{err}: {wire}"))
            .to_string();
        let fit = GUESSES.iter().map(|g| g()).find(|guess| {
            let mut tried = wire.clone();
            tried[missing.as_str()] = guess.clone();
            !serde_json::from_value::<WsEvent>(tried)
                .err()
                .is_some_and(|e| e.to_string().contains(&format!("`{missing}`")))
        });
        wire[missing.as_str()] = fit.unwrap_or_else(|| panic!("{missing}: {err}"));
    }
    panic!("no event from {wire}")
}

fn vectors() -> Value {
    let all = schemas();
    let fields = declared();
    let mut out = Map::new();
    for part in all["WsEvent"]["oneOf"].as_array().expect("oneOf") {
        let tag = tag_of(part).expect("tag");
        let ev = event_of(sample(&all, part, 0), &fields[&tag]);
        out.insert(
            tag,
            json!({
                "client": serde_json::to_string(&ev).expect("client"),
                "bus": to_bus_json(&ev).expect("bus"),
            }),
        );
    }
    Value::Object(out)
}

#[test]
fn every_event_keeps_its_client_and_bus_bytes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FILE);
    if crate::config::test_env("UPDATE_FIXTURES").is_some() {
        let text = serde_json::to_string_pretty(&vectors()).expect("json");
        std::fs::write(&path, format!("{text}\n")).expect("write");
    }
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_default())
        .unwrap_or_default();
    let stored = stored.as_object().cloned().unwrap_or_default();
    let mut tags: Vec<String> = schemas()["WsEvent"]["oneOf"]
        .as_array()
        .expect("oneOf")
        .iter()
        .map(|p| tag_of(p).expect("tag"))
        .collect();
    tags.sort();
    let mut have: Vec<String> = stored.keys().cloned().collect();
    have.sort();
    assert_eq!(
        have, tags,
        "{FILE} lists another set of events: run `UPDATE_FIXTURES=1 cargo test -p rust-next wire`"
    );
    for (tag, v) in &stored {
        let bus = v["bus"].as_str().expect("bus");
        let ev: WsEvent = serde_json::from_str(bus).unwrap_or_else(|e| panic!("{tag}: {e}"));
        assert_eq!(to_bus_json(&ev).expect("bus"), bus, "{tag}: bus wire");
        assert_eq!(
            serde_json::to_string(&ev).expect("client"),
            v["client"].as_str().expect("client"),
            "{tag}: client frame"
        );
    }
}
