use utoipa::OpenApi;

/// The realtime frames: the events the server sends (`WsEvent`, the `error` frame among them)
/// and the frames clients send (`ClientMsg`). No route serves this document.
#[derive(OpenApi)]
#[openapi(components(schemas(super::event::WsEvent, super::protocol::ClientMsg)))]
pub struct EventDoc;

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use utoipa::OpenApi;

    use super::EventDoc;

    /// The `type` tag of one variant: on the variant itself, or on one part of it when a
    /// flattened field makes it an `allOf`.
    fn tag_of(part: &Value) -> Option<&str> {
        part["properties"]["type"]["enum"][0].as_str().or_else(|| {
            part["allOf"]
                .as_array()?
                .iter()
                .find_map(|inner| inner["properties"]["type"]["enum"][0].as_str())
        })
    }

    fn tags(schema: &Value) -> Vec<String> {
        schema["oneOf"]
            .as_array()
            .expect("oneOf")
            .iter()
            .map(|part| tag_of(part).expect("type tag").to_string())
            .collect()
    }

    fn variant<'a>(schema: &'a Value, tag: &str) -> &'a Value {
        schema["oneOf"]
            .as_array()
            .expect("oneOf")
            .iter()
            .find(|part| tag_of(part) == Some(tag))
            .expect(tag)
    }

    #[test]
    fn every_frame_is_tagged_by_type() {
        let doc = serde_json::to_value(EventDoc::openapi()).expect("doc");
        let schemas = &doc["components"]["schemas"];
        for name in ["WsEvent", "ClientMsg"] {
            let tags = tags(&schemas[name]);
            let mut unique = tags.clone();
            unique.sort();
            unique.dedup();
            assert_eq!(unique.len(), tags.len(), "{name}");
        }
        let events = tags(&schemas["WsEvent"]);
        for tag in ["message", "message_updated", "error", "resync", "typing"] {
            assert!(events.iter().any(|t| t == tag), "{tag}");
        }
        let error = variant(&schemas["WsEvent"], "error");
        assert!(error["properties"]["reason"].is_object());
        assert!(error["properties"]["message"].is_object());
    }

    #[test]
    fn routing_fields_are_left_out() {
        let doc = serde_json::to_value(EventDoc::openapi()).expect("doc");
        let events = &doc["components"]["schemas"]["WsEvent"];
        for (tag, field) in [
            ("user_updated", "scope"),
            ("channel_deleted", "rules"),
            ("members_purged", "usernames"),
            ("presence_mode", "seq"),
            ("reports_changed", "about"),
            ("message_deleted", "notice"),
        ] {
            let part = variant(events, tag);
            assert!(part["properties"][field].is_null(), "{tag}.{field}");
        }
    }

    #[test]
    fn shared_schemas_match_the_served_document() {
        let events = serde_json::to_value(EventDoc::openapi()).expect("doc");
        let served = serde_json::to_value(crate::api::openapi::ApiDoc::openapi()).expect("doc");
        let differ: Vec<&String> = events["components"]["schemas"]
            .as_object()
            .expect("schemas")
            .iter()
            .filter(|(name, schema)| {
                let other = &served["components"]["schemas"][name.as_str()];
                !other.is_null() && other != *schema
            })
            .map(|(name, _)| name)
            .collect();
        assert!(differ.is_empty(), "{differ:?}");
    }
}
