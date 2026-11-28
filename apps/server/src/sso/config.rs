use crate::config::Secret;
use anyhow::{Context, Result, bail, ensure};
use rchat_settings::{Env, Setting, items as st};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use url::Url;

#[derive(Clone, Default)]
pub struct SsoConfig {
    pub providers: Vec<ProviderConfig>,
    pub scim: Option<ScimConfig>,
    pub group_map: GroupMap,
}
#[derive(Clone)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub issuer: String,
    pub client_id: String,
    pub client_secret: Option<Secret>,
    pub scopes: Vec<String>,
    pub username_claim: String,
    pub display_claim: String,
    pub groups_claim: String,
    pub allowed_groups: Vec<String>,
    pub auto_create: bool,
    pub sync_profile: bool,
    pub end_session: bool,
    pub token_auth: TokenAuth,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenAuth {
    Basic,
    Post,
}
#[derive(Clone)]
pub struct ScimConfig {
    pub token_sha256: [u8; 32],
    pub delete: ScimDelete,
    pub provider: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScimDelete {
    Deactivate,
    Delete,
}
#[derive(Clone, Default)]
pub struct GroupMap(pub BTreeMap<String, Vec<GroupGrant>>);
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GroupGrant {
    pub server: String,
    pub role: Option<String>,
}

type Lookup<'a> = &'a dyn Fn(&str) -> Option<String>;
fn list(s: &str) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
impl ProviderConfig {
    fn load(id: String, get: Lookup<'_>) -> Result<Self> {
        let e = Env::new(get);
        let key = |item: &Setting| rchat_settings::provider_env(item, &id);
        let value = |item: &Setting| e.provider(item, &id);
        let required =
            |item: &Setting| value(item).with_context(|| format!("{} is required", key(item)));
        let flag = |item: &Setting, default: bool| match value(item)
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            None => Ok(default),
            Some("true" | "on") => Ok(true),
            Some("false" | "off") => Ok(false),
            _ => bail!("{}: expected on or off", key(item)),
        };
        let issuer = required(&st::OIDC_ID_ISSUER.setting)?;
        let url = Url::parse(&issuer).with_context(|| {
            format!(
                "{}: expected an https URL",
                key(&st::OIDC_ID_ISSUER.setting)
            )
        })?;
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        ensure!(
            url.has_host()
                && (url.scheme() == "https" || (url.scheme() == "http" && loopback))
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
                && url.query().is_none(),
            "{}: expected an https URL or http on loopback, without credentials, query or fragment",
            key(&st::OIDC_ID_ISSUER.setting)
        );
        let scope = value(&st::OIDC_ID_SCOPES.setting).unwrap_or_else(|| "openid profile".into());
        let mut scopes: Vec<_> = scope
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if !scopes.iter().any(|s| s == "openid") {
            scopes.insert(0, "openid".into());
        }
        let token_auth = match value(&st::OIDC_ID_TOKEN_AUTH.setting)
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            None | Some("basic") => TokenAuth::Basic,
            Some("post") => TokenAuth::Post,
            _ => bail!(
                "{}: expected basic or post",
                key(&st::OIDC_ID_TOKEN_AUTH.setting)
            ),
        };
        Ok(Self {
            issuer,
            client_id: required(&st::OIDC_ID_CLIENT_ID.setting)?,
            client_secret: e
                .provider_secret(&st::OIDC_ID_CLIENT_SECRET, &id)?
                .map(Secret),
            scopes,
            name: value(&st::OIDC_ID_NAME.setting).unwrap_or_else(|| id.clone()),
            username_claim: value(&st::OIDC_ID_USERNAME_CLAIM.setting)
                .unwrap_or_else(|| "preferred_username".into()),
            display_claim: value(&st::OIDC_ID_DISPLAY_CLAIM.setting)
                .unwrap_or_else(|| "name".into()),
            groups_claim: value(&st::OIDC_ID_GROUPS_CLAIM.setting)
                .unwrap_or_else(|| "groups".into()),
            allowed_groups: list(&value(&st::OIDC_ID_ALLOWED_GROUPS.setting).unwrap_or_default()),
            auto_create: flag(&st::OIDC_ID_AUTO_CREATE.setting, true)?,
            sync_profile: flag(&st::OIDC_ID_SYNC_PROFILE.setting, true)?,
            end_session: flag(&st::OIDC_ID_END_SESSION.setting, false)?,
            token_auth,
            id,
        })
    }
}
impl SsoConfig {
    pub fn from_env(env: &HashMap<String, String>, public_url: Option<&str>) -> Result<Self> {
        Self::load(&|key| env.get(key).cloned(), public_url)
    }
    pub(crate) fn load(get: Lookup<'_>, public_url: Option<&str>) -> Result<Self> {
        let e = Env::new(get);
        let mut providers = Vec::new();
        for raw in list(&e.value(&st::OIDC_PROVIDERS).unwrap_or_default()) {
            let id = raw.to_ascii_lowercase();
            ensure!(
                id.len() <= 32
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
                "OIDC_PROVIDERS: expected provider IDs of 1 to 32 letters or digits"
            );
            ensure!(
                !providers.iter().any(|p: &ProviderConfig| p.id == id),
                "OIDC_PROVIDERS: {id} is listed twice"
            );
            providers.push(ProviderConfig::load(id, get)?);
        }
        ensure!(
            providers.is_empty() || public_url.is_some_and(|url| !url.trim().is_empty()),
            "PUBLIC_URL is required with OIDC_PROVIDERS"
        );
        let value = |item: &Setting| e.raw(item);
        let delete = match value(&st::SCIM_DELETE.setting)
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            None | Some("deactivate") => ScimDelete::Deactivate,
            Some("delete") => ScimDelete::Delete,
            _ => bail!("SCIM_DELETE: expected deactivate or delete"),
        };
        let provider = value(&st::SCIM_PROVIDER.setting).map(|s| s.to_ascii_lowercase());
        if let Some(id) = &provider {
            ensure!(
                providers.iter().any(|p| &p.id == id),
                "SCIM_PROVIDER must name a configured provider"
            );
        }
        let scim = if let Some(token) = e.secret(&st::SCIM_TOKEN)? {
            ensure!(
                token.chars().count() >= 32,
                "SCIM_TOKEN must have at least 32 characters"
            );
            Some(ScimConfig {
                token_sha256: Sha256::digest(token.as_bytes()).into(),
                delete,
                provider,
            })
        } else {
            None
        };
        let mut groups: BTreeMap<String, Vec<GroupGrant>> = match value(&st::SSO_GROUP_MAP.setting)
        {
            Some(json) => serde_json::from_str(&json)
                .context("SSO_GROUP_MAP: expected a group to server and role map")?,
            None => BTreeMap::new(),
        };
        for grants in groups.values_mut() {
            for grant in grants {
                grant.server = grant.server.trim().to_lowercase();
                ensure!(
                    !grant.server.is_empty(),
                    "SSO_GROUP_MAP: missing server name"
                );
                grant.role = grant
                    .role
                    .take()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty());
            }
        }
        Ok(Self {
            providers,
            scim,
            group_map: GroupMap(groups),
        })
    }
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::{GroupGrant, ProviderConfig, ScimDelete, SsoConfig, TokenAuth};

    use crate::config::AppConfig;

    const URL: (&str, &str) = ("PUBLIC_URL", "https://chat.example.com");

    const OKTA: [(&str, &str); 4] = [
        ("OIDC_PROVIDERS", "okta"),
        ("OIDC_OKTA_ISSUER", "https://corp.okta.com"),
        ("OIDC_OKTA_CLIENT_ID", "0oa1"),
        URL,
    ];

    fn load(pairs: &[(&str, &str)]) -> anyhow::Result<AppConfig> {
        AppConfig::from_map(pairs)
    }

    fn load_sso(pairs: &[(&str, &str)]) -> SsoConfig {
        load(pairs).expect("loads").sso
    }

    fn okta_with(changes: &[(&str, &str)]) -> anyhow::Result<AppConfig> {
        let mut pairs: Vec<(&str, &str)> = OKTA
            .into_iter()
            .filter(|(k, _)| !changes.iter().any(|(c, _)| c == k))
            .collect();
        pairs.extend_from_slice(changes);
        load(&pairs)
    }

    #[test]
    fn config_reads_two_providers_with_defaults() {
        let config = load(&[
            ("OIDC_PROVIDERS", " Authentik,okta"),
            (
                "OIDC_AUTHENTIK_ISSUER",
                "https://auth.example.com/application/o/rchat/",
            ),
            ("OIDC_AUTHENTIK_CLIENT_ID", "rchat"),
            ("OIDC_OKTA_ISSUER", " https://corp.okta.com "),
            ("OIDC_OKTA_CLIENT_ID", "0oa1"),
            ("OIDC_OKTA_CLIENT_SECRET", "s"),
            ("OIDC_OKTA_TOKEN_AUTH", "post"),
            URL,
        ])
        .expect("loads");
        let ids: Vec<&str> = config.sso.providers.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["authentik", "okta"]);
        let [authentik, okta] = &config.sso.providers[..] else {
            panic!("two providers");
        };
        assert_eq!(
            (
                authentik.name.as_str(),
                authentik.issuer.as_str(),
                authentik.client_id.as_str()
            ),
            (
                "authentik",
                "https://auth.example.com/application/o/rchat/",
                "rchat"
            )
        );
        assert_eq!(
            (okta.name.as_str(), okta.issuer.as_str()),
            ("okta", "https://corp.okta.com")
        );
        for p in [authentik, okta] {
            let ProviderConfig {
                id: _,
                name: _,
                issuer: _,
                client_id: _,
                client_secret: _,
                scopes,
                username_claim,
                display_claim,
                groups_claim,
                allowed_groups,
                auto_create,
                sync_profile,
                end_session,
                token_auth: _,
            } = p;
            assert_eq!(scopes, &["openid", "profile"]);
            assert_eq!(
                (
                    username_claim.as_str(),
                    display_claim.as_str(),
                    groups_claim.as_str()
                ),
                ("preferred_username", "name", "groups")
            );
            assert!(allowed_groups.is_empty());
            assert_eq!(
                (*auto_create, *sync_profile, *end_session),
                (true, true, false)
            );
        }
        assert_eq!(authentik.token_auth, TokenAuth::Basic);
        assert!(authentik.client_secret.is_none());
        assert_eq!(okta.token_auth, TokenAuth::Post);
        assert_eq!(okta.client_secret.as_ref().map(|s| s.0.as_str()), Some("s"));
        assert!(config.controls.set.is_empty());
        assert!(config.sso.scim.is_none());
        assert!(config.sso.group_map.0.is_empty());
    }

    #[test]
    fn config_reads_every_provider_and_scim_setting() {
        let token = "t".repeat(32);
        let sso = load_sso(&[
            ("OIDC_PROVIDERS", "okta,"),
            ("OIDC_OKTA_ISSUER", "https://corp.okta.com/oauth2/default"),
            ("OIDC_OKTA_CLIENT_ID", "0oa1"),
            ("OIDC_OKTA_NAME", " Corp sign-in "),
            ("OIDC_OKTA_SCOPES", "profile, groups email"),
            ("OIDC_OKTA_USERNAME_CLAIM", "nickname"),
            ("OIDC_OKTA_DISPLAY_CLAIM", "given_name"),
            ("OIDC_OKTA_GROUPS_CLAIM", "roles"),
            ("OIDC_OKTA_ALLOWED_GROUPS", " Staff , contractors,"),
            ("OIDC_OKTA_AUTO_CREATE", "false"),
            ("OIDC_OKTA_SYNC_PROFILE", "off"),
            ("OIDC_OKTA_END_SESSION", "on"),
            ("OIDC_OKTA_TOKEN_AUTH", " Basic "),
            ("SCIM_TOKEN", &token),
            ("SCIM_DELETE", "Delete"),
            ("SCIM_PROVIDER", " OKTA "),
            URL,
        ]);
        let [okta] = &sso.providers[..] else {
            panic!("one provider");
        };
        assert_eq!(okta.name, "Corp sign-in");
        assert_eq!(okta.scopes, ["openid", "profile", "groups", "email"]);
        assert_eq!(
            (
                okta.username_claim.as_str(),
                okta.display_claim.as_str(),
                okta.groups_claim.as_str()
            ),
            ("nickname", "given_name", "roles")
        );
        assert_eq!(okta.allowed_groups, ["Staff", "contractors"]);
        assert_eq!(
            (okta.auto_create, okta.sync_profile, okta.end_session),
            (false, false, true)
        );
        assert_eq!(okta.token_auth, TokenAuth::Basic);
        let scim = sso.scim.expect("scim");
        assert_eq!(scim.token_sha256, <[u8; 32]>::from(Sha256::digest(&token)));
        assert_eq!(scim.delete, ScimDelete::Delete);
        assert_eq!(scim.provider.as_deref(), Some("okta"));
        let kept = okta_with(&[("OIDC_OKTA_SCOPES", "email openid")])
            .expect("loads")
            .sso;
        assert_eq!(kept.providers[0].scopes, ["email", "openid"]);
        let plain = okta_with(&[("SCIM_TOKEN", &token)]).expect("loads").sso;
        let scim = plain.scim.expect("scim");
        assert_eq!((scim.delete, scim.provider), (ScimDelete::Deactivate, None));
        let none = load_sso(&[("OIDC_PROVIDERS", " , "), ("SCIM_DELETE", "delete")]);
        assert!(none.providers.is_empty() && none.scim.is_none());
        assert!(load(&[]).expect("defaults").sso.providers.is_empty());
    }

    #[test]
    fn config_rejects_bad_values() {
        let long_id = "a".repeat(33);
        let short_token = "t".repeat(31);
        let cases: Vec<(Vec<(&str, &str)>, &str)> = vec![
            (
                vec![("OIDC_OKTA_ISSUER", "")],
                "OIDC_OKTA_ISSUER is required",
            ),
            (
                vec![("OIDC_OKTA_CLIENT_ID", " ")],
                "OIDC_OKTA_CLIENT_ID is required",
            ),
            (
                vec![("OIDC_OKTA_ISSUER", "http://idp.example.com")],
                "OIDC_OKTA_ISSUER: expected an https URL",
            ),
            (vec![("OIDC_OKTA_ISSUER", "idp.example.com")], "https"),
            (
                vec![("OIDC_OKTA_ISSUER", "https://idp.example.com/?a=b")],
                "OIDC_OKTA_ISSUER",
            ),
            (
                vec![("OIDC_OKTA_ISSUER", "https://u:p@idp.example.com")],
                "OIDC_OKTA_ISSUER",
            ),
            (vec![("OIDC_PROVIDERS", "my_idp")], "OIDC_PROVIDERS"),
            (vec![("OIDC_PROVIDERS", &long_id)], "OIDC_PROVIDERS"),
            (
                vec![("OIDC_PROVIDERS", "okta,OKTA")],
                "OIDC_PROVIDERS: okta is listed twice",
            ),
            (vec![("AUTH_REGISTRATION", "maybe")], "AUTH_REGISTRATION"),
            (
                vec![("AUTH_PASSWORD_LOGIN", "maybe")],
                "AUTH_PASSWORD_LOGIN",
            ),
            (vec![("SCIM_TOKEN", &short_token)], "at least 32"),
            (vec![("SCIM_PROVIDER", "nope")], "SCIM_PROVIDER"),
            (vec![("SCIM_DELETE", "purge")], "SCIM_DELETE"),
            (vec![("SSO_GROUP_MAP", "[1]")], "SSO_GROUP_MAP"),
            (vec![("SSO_GROUP_MAP", "{")], "SSO_GROUP_MAP"),
            (
                vec![("SSO_GROUP_MAP", r#"{"g":[{"server":" "}]}"#)],
                "SSO_GROUP_MAP",
            ),
            (
                vec![("SSO_GROUP_MAP", r#"{"g":[{"server":"a","rol":"b"}]}"#)],
                "SSO_GROUP_MAP",
            ),
            (
                vec![("OIDC_OKTA_TOKEN_AUTH", "jwt")],
                "OIDC_OKTA_TOKEN_AUTH",
            ),
            (
                vec![("OIDC_OKTA_AUTO_CREATE", "maybe")],
                "OIDC_OKTA_AUTO_CREATE",
            ),
            (
                vec![("OIDC_OKTA_SYNC_PROFILE", "2")],
                "OIDC_OKTA_SYNC_PROFILE",
            ),
            (
                vec![("OIDC_OKTA_END_SESSION", "x")],
                "OIDC_OKTA_END_SESSION",
            ),
            (vec![("PUBLIC_URL", "")], "PUBLIC_URL"),
        ];
        for (changes, want) in cases {
            let err = match okta_with(&changes) {
                Ok(_) => panic!("{changes:?} loads"),
                Err(e) => e.to_string(),
            };
            assert!(err.contains(want), "{changes:?}: {err}");
            assert!(err.is_ascii(), "{err}");
        }
        assert!(okta_with(&[("SCIM_TOKEN", &"t".repeat(32)), ("SCIM_PROVIDER", "okta")]).is_ok());
    }

    #[test]
    fn config_allows_loopback_http() {
        let sso = load_sso(&[
            ("OIDC_PROVIDERS", "authentik,keycloak,six"),
            (
                "OIDC_AUTHENTIK_ISSUER",
                "http://localhost:9000/application/o/rchat/",
            ),
            ("OIDC_AUTHENTIK_CLIENT_ID", "a"),
            (
                "OIDC_KEYCLOAK_ISSUER",
                "http://127.0.0.1:18080/realms/rchat",
            ),
            ("OIDC_KEYCLOAK_CLIENT_ID", "k"),
            ("OIDC_SIX_ISSUER", "http://[::1]:8080"),
            ("OIDC_SIX_CLIENT_ID", "s"),
            ("PUBLIC_URL", "http://localhost:3000"),
        ]);
        let issuers: Vec<&str> = sso.providers.iter().map(|p| p.issuer.as_str()).collect();
        assert_eq!(
            issuers,
            [
                "http://localhost:9000/application/o/rchat/",
                "http://127.0.0.1:18080/realms/rchat",
                "http://[::1]:8080"
            ]
        );
        for host in ["http://localhost.example.com", "http://10.0.0.1:8080"] {
            assert!(okta_with(&[("OIDC_OKTA_ISSUER", host)]).is_err(), "{host}");
        }
    }

    #[test]
    fn client_secrets_come_from_files() {
        let file = std::env::temp_dir().join(format!("rchat_oidc_secret_{}", std::process::id()));
        std::fs::write(&file, "  from-file\n").expect("write");
        let path = file.to_str().expect("path");
        let base = [
            ("OIDC_PROVIDERS", "x"),
            ("OIDC_X_ISSUER", "https://idp.example.com"),
            ("OIDC_X_CLIENT_ID", "id"),
            ("OIDC_X_CLIENT_SECRET_FILE", path),
            URL,
        ];
        let read = load_sso(&base);
        assert_eq!(
            read.providers[0]
                .client_secret
                .as_ref()
                .map(|s| s.0.as_str()),
            Some("from-file")
        );
        assert!(read.scim.is_none());
        let mut direct = base.to_vec();
        direct.push(("OIDC_X_CLIENT_SECRET", " direct "));
        let read = load_sso(&direct);
        assert_eq!(
            read.providers[0]
                .client_secret
                .as_ref()
                .map(|s| s.0.as_str()),
            Some("direct")
        );
        let mut scim_file = base.to_vec();
        scim_file.push(("SCIM_TOKEN_FILE", path));
        assert!(
            load(&scim_file)
                .unwrap_err()
                .to_string()
                .contains("SCIM_TOKEN")
        );
        let token = "k".repeat(40);
        std::fs::write(&file, format!("{token}\n")).expect("write");
        let read = load_sso(&scim_file);
        assert_eq!(
            read.scim.expect("scim").token_sha256,
            <[u8; 32]>::from(Sha256::digest(&token))
        );
        std::fs::remove_file(&file).expect("remove fixture");
        let error = load(&base).unwrap_err().to_string();
        assert!(error.contains("OIDC_X_CLIENT_SECRET_FILE"), "{error}");
        assert!(load(&direct).is_ok());
    }

    #[test]
    fn group_map_parses() {
        let map = load_sso(&[(
            "SSO_GROUP_MAP",
            r#"{"Engineering":[{"server":"Eng","role":"Dev"},{"server":" lobby ","role":" "}],"ops":[]}"#,
        )])
        .group_map;
        assert_eq!(map.0.keys().collect::<Vec<_>>(), ["Engineering", "ops"]);
        assert_eq!(
            map.0["Engineering"],
            [
                GroupGrant {
                    server: "eng".to_string(),
                    role: Some("Dev".to_string())
                },
                GroupGrant {
                    server: "lobby".to_string(),
                    role: None
                }
            ]
        );
        assert!(map.0["ops"].is_empty());
        assert!(load_sso(&[("SSO_GROUP_MAP", " ")]).group_map.0.is_empty());
    }
}
