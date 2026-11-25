use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub const LIST_MAX: i64 = 200;
pub const LIST_DEFAULT: i64 = 100;
pub const BODY_MAX: usize = 1024 * 1024;
pub const MEDIA: &str = "application/scim+json";
pub fn response(status: StatusCode, value: Value) -> Response {
    (status, [(header::CONTENT_TYPE, MEDIA)], Json(value)).into_response()
}
#[derive(Debug)]
pub struct ScimError {
    pub status: StatusCode,
    pub scim_type: Option<&'static str>,
    pub detail: &'static str,
}
impl ScimError {
    pub fn new(status: StatusCode, detail: &'static str) -> Self {
        Self {
            status,
            detail,
            scim_type: None,
        }
    }
    pub fn bad(kind: &'static str, detail: &'static str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            scim_type: Some(kind),
            detail,
        }
    }
    pub fn invalid() -> Self {
        Self::bad("invalidValue", "Invalid attribute value")
    }
    pub fn missing() -> Self {
        Self::new(StatusCode::NOT_FOUND, "Resource not found")
    }
    pub fn conflict() -> Self {
        Self {
            status: StatusCode::CONFLICT,
            scim_type: Some("uniqueness"),
            detail: "Name already in use",
        }
    }
}
impl IntoResponse for ScimError {
    fn into_response(self) -> Response {
        let mut value = json!({"schemas":["urn:ietf:params:scim:api:messages:2.0:Error"],"status":self.status.as_u16().to_string(),"detail":self.detail});
        if let Some(kind) = self.scim_type {
            value["scimType"] = json!(kind);
        }
        let mut answer = response(self.status, value);
        if matches!(
            self.status,
            StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
        ) {
            answer.headers_mut().insert(
                header::RETRY_AFTER,
                axum::http::HeaderValue::from_static("1"),
            );
        }
        answer
    }
}
#[derive(Debug, PartialEq)]
pub enum Filter {
    UserName(String),
    DisplayName(String),
}
pub fn parse_filter(s: &str) -> Result<Filter, ScimError> {
    let bad = || ScimError::bad("invalidFilter", "Unsupported filter");
    let (attr, tail) = s.trim().split_once(char::is_whitespace).ok_or_else(bad)?;
    let (op, value) = tail
        .trim_start()
        .split_once(char::is_whitespace)
        .ok_or_else(bad)?;
    if !op.eq_ignore_ascii_case("eq") {
        return Err(bad());
    }
    let value = serde_json::from_str(value.trim()).map_err(|_| bad())?;
    if attr.eq_ignore_ascii_case("userName") {
        Ok(Filter::UserName(value))
    } else if attr.eq_ignore_ascii_case("displayName") {
        Ok(Filter::DisplayName(value))
    } else {
        Err(bad())
    }
}
pub fn scim_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::String(s) if s.eq_ignore_ascii_case("true") => Some(true),
        Value::String(s) if s.eq_ignore_ascii_case("false") => Some(false),
        _ => None,
    }
}
#[derive(Default, Debug)]
pub struct UserPatch {
    pub active: Option<bool>,
    pub display: Option<Option<String>>,
    pub external_id: Option<Option<String>>,
    pub user_name: Option<String>,
}
#[derive(Default)]
struct Attributes {
    patch: UserPatch,
    given: Option<String>,
    family: Option<String>,
}
impl Attributes {
    fn set(&mut self, path: &str, value: &Value, remove: bool) -> Result<(), ScimError> {
        let string = || {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(ScimError::invalid)
        };
        match path.to_ascii_lowercase().as_str() {
            "active" => {
                self.patch.active = Some(
                    scim_bool(value)
                        .filter(|_| !remove)
                        .ok_or_else(ScimError::invalid)?,
                )
            }
            "username" => {
                if remove {
                    return Err(ScimError::invalid());
                }
                self.patch.user_name = Some(string()?)
            }
            "displayname" | "name.formatted" => {
                self.patch.display = Some(if remove || value.is_null() {
                    None
                } else {
                    Some(string()?)
                })
            }
            "externalid" => {
                self.patch.external_id = Some(if remove || value.is_null() {
                    None
                } else {
                    Some(string()?)
                })
            }
            "name.givenname" if !remove => self.given = Some(string()?),
            "name.familyname" if !remove => self.family = Some(string()?),
            "name" => {
                if let Some(obj) = value.as_object() {
                    for (k, v) in obj {
                        self.set(&format!("name.{k}"), v, remove)?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn object(&mut self, value: &Value, remove: bool) -> Result<(), ScimError> {
        for (k, v) in value.as_object().ok_or_else(ScimError::invalid)? {
            self.set(k, v, remove)?;
        }
        Ok(())
    }
    fn finish(mut self) -> UserPatch {
        if self.patch.display.is_none()
            && let (Some(g), Some(f)) = (self.given, self.family)
        {
            self.patch.display = Some(Some(format!("{g} {f}")));
        }
        self.patch
    }
}
fn attribute<'a>(object: &'a Value, key: &str) -> Option<&'a Value> {
    object
        .as_object()?
        .iter()
        .find_map(|(name, value)| name.eq_ignore_ascii_case(key).then_some(value))
}
pub fn replacement(body: &Value) -> Result<UserPatch, ScimError> {
    let mut a = Attributes::default();
    if let Some(v) = attribute(body, "name").and_then(|name| attribute(name, "formatted")) {
        a.set("name.formatted", v, false)?;
    }
    for key in ["userName", "externalId", "active", "displayName"] {
        if let Some(v) = attribute(body, key) {
            a.set(key, v, false)?;
        }
    }
    let mut p = a.finish();
    p.display.get_or_insert(None);
    p.external_id.get_or_insert(None);
    p.active.get_or_insert(true);
    Ok(p)
}
pub fn user_patch(body: &Value) -> Result<UserPatch, ScimError> {
    let syntax = || ScimError::bad("invalidSyntax", "Invalid patch operation");
    let mut a = Attributes::default();
    for op in body["Operations"].as_array().ok_or_else(syntax)? {
        let remove = match op["op"]
            .as_str()
            .ok_or_else(syntax)?
            .to_ascii_lowercase()
            .as_str()
        {
            "remove" => true,
            "replace" | "add" => false,
            _ => return Err(syntax()),
        };
        match op.get("path") {
            Some(path) => a.set(path.as_str().ok_or_else(syntax)?, &op["value"], remove)?,
            None => a.object(&op["value"], remove)?,
        }
    }
    Ok(a.finish())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_and_patch_shapes() {
        assert_eq!(
            parse_filter("USERNAME Eq \"a b\"").unwrap(),
            Filter::UserName("a b".into())
        );
        assert!(parse_filter("username eq \"a\" or active").is_err());
        let p=user_patch(&json!({"Operations":[{"op":"replace","value":{"active":"False","name":{"givenName":"Test","familyName":"User"}}},{"op":"Add","path":"emails[type eq \"work\"].value","value":"ignored"}]})).unwrap();
        assert_eq!(p.active, Some(false));
        assert_eq!(p.display, Some(Some("Test User".into())));
        for op in [
            json!({"op":"move"}),
            json!({"op":"replace","path":"active","value":"maybe"}),
        ] {
            assert!(user_patch(&json!({"Operations":[op]})).is_err())
        }
    }
}
