pub mod accounts;
pub mod audit;
pub mod config;
#[cfg(test)]
pub(crate) mod fake_idp;
pub mod flow;
pub mod jwt;
pub mod provider;

use provider::Provider;
use std::sync::{Arc, OnceLock};

use crate::api::features::Registration;
use config::SsoConfig;
use serde::Serialize;
use utoipa::ToSchema;

pub struct Sso {
    pub config: SsoConfig,
    providers: Vec<Arc<Provider>>,
    http: OnceLock<reqwest::Client>,
}

/// Available registration and sign-in methods for this instance.
#[derive(Clone, Serialize, ToSchema)]
pub struct AuthInfo {
    /// Current account registration policy.
    pub registration: Registration,
    /// Whether the sign-in page offers the password form by default.
    pub password_login: bool,
    /// Configured identity providers in display order.
    pub providers: Vec<ProviderInfo>,
}

/// An identity provider offered on the sign-in screen.
#[derive(Clone, Serialize, ToSchema)]
pub struct ProviderInfo {
    /// Identifier used in the OIDC start route.
    pub id: String,
    /// Display name shown on the provider sign-in button.
    pub name: String,
}

impl Sso {
    pub fn off() -> Self {
        Self {
            config: SsoConfig::default(),
            providers: Vec::new(),
            http: OnceLock::new(),
        }
    }
    fn client() -> reqwest::Result<reqwest::Client> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(provider::FETCH_TIMEOUT)
            .no_proxy()
            .build()
    }
    pub fn new(config: SsoConfig) -> anyhow::Result<Self> {
        let providers = config
            .providers
            .iter()
            .cloned()
            .map(Provider::new)
            .map(Arc::new)
            .collect();
        let http = if config.providers.is_empty() {
            OnceLock::new()
        } else {
            OnceLock::from(Self::client()?)
        };
        Ok(Self {
            config,
            providers,
            http,
        })
    }
    pub fn providers(&self) -> impl Iterator<Item = &Arc<Provider>> {
        self.providers.iter()
    }
    pub fn provider(&self, id: &str) -> Option<Arc<Provider>> {
        self.providers().find(|p| p.config.id == id).cloned()
    }
    pub fn http(&self) -> &reqwest::Client {
        self.http
            .get_or_init(|| Self::client().expect("SSO client"))
    }
    pub fn auth_info(&self, password_login: bool, registration: Registration) -> AuthInfo {
        AuthInfo {
            registration,
            password_login,
            providers: self
                .config
                .providers
                .iter()
                .map(|p| ProviderInfo {
                    id: p.id.clone(),
                    name: p.name.clone(),
                })
                .collect(),
        }
    }
    pub fn policy_warnings(
        &self,
        password_login: bool,
        registration: Registration,
    ) -> Vec<&'static str> {
        let mut warnings = Vec::new();
        if self.config.providers.is_empty() {
            if !password_login {
                warnings.push("password sign-in is off and OIDC_PROVIDERS is empty");
            }
            if registration == Registration::Sso {
                warnings.push("registration is sso and OIDC_PROVIDERS is empty");
            }
        }
        warnings
    }
}

#[cfg(test)]
mod tests {
    use super::Sso;
    use crate::api::features::Registration;
    use crate::config::AppConfig;

    fn two() -> Sso {
        let config = AppConfig::from_map(&[
            ("OIDC_PROVIDERS", "authentik,okta"),
            ("OIDC_AUTHENTIK_ISSUER", "https://auth.example.com/"),
            ("OIDC_AUTHENTIK_CLIENT_ID", "a"),
            ("OIDC_AUTHENTIK_NAME", "Authentik"),
            ("OIDC_OKTA_ISSUER", "https://corp.okta.com"),
            ("OIDC_OKTA_CLIENT_ID", "o"),
            ("OIDC_OKTA_CLIENT_SECRET", "s3cret"),
            ("PUBLIC_URL", "https://chat.example.com"),
        ])
        .expect("loads");
        Sso::new(config.sso).expect("sso")
    }

    #[test]
    fn auth_info_lists_providers_in_order_with_the_live_switches() {
        let info = serde_json::to_value(two().auth_info(false, Registration::Sso)).expect("json");
        assert_eq!(
            info,
            serde_json::json!({
                "password_login": false,
                "registration": "sso",
                "providers": [{"id": "authentik", "name": "Authentik"}, {"id": "okta", "name": "okta"}]
            })
        );
        let off =
            serde_json::to_value(Sso::off().auth_info(true, Registration::Open)).expect("json");
        assert_eq!(
            off,
            serde_json::json!({"password_login": true, "registration": "open", "providers": []})
        );
    }

    #[test]
    fn a_policy_without_providers_warns() {
        let off = Sso::off();
        assert!(off.policy_warnings(true, Registration::Open).is_empty());
        assert!(off.policy_warnings(true, Registration::Closed).is_empty());
        let password = off.policy_warnings(false, Registration::Open);
        assert_eq!(password.len(), 1);
        assert!(
            password[0].contains("password sign-in is off"),
            "{password:?}"
        );
        let sso = off.policy_warnings(true, Registration::Sso);
        assert_eq!(sso.len(), 1);
        assert!(sso[0].contains("registration is sso"), "{sso:?}");
        assert_eq!(off.policy_warnings(false, Registration::Sso).len(), 2);
        for w in off.policy_warnings(false, Registration::Sso) {
            assert!(w.contains("OIDC_PROVIDERS") && w.is_ascii(), "{w}");
        }
        assert!(two().policy_warnings(false, Registration::Sso).is_empty());
    }
}
