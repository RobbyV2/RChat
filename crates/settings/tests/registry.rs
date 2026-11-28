use std::collections::BTreeSet;

use rchat_settings::{ALL, Kind, Preset, Scope, Setting, by_env, json};

const FIXTURE: &str = "../../assets/settings.json";

// `UPDATE_FIXTURES=1 cargo test -p rchat-settings` rewrites the fixture (then prettier it).
#[test]
fn the_settings_asset_matches_the_registry() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    let want: serde_json::Value = serde_json::from_str(&json()).expect("registry json");
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        let text = serde_json::to_string_pretty(&want).expect("json");
        std::fs::write(&path, text + "\n").expect("write fixture");
    }
    let got: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read fixture"))
            .expect("fixture json");
    assert_eq!(
        got, want,
        "run UPDATE_FIXTURES=1 cargo test -p rchat-settings"
    );
}

#[test]
fn names_and_keys_are_unique() {
    let mut envs = BTreeSet::new();
    let mut keys = BTreeSet::new();
    for s in ALL {
        assert!(!s.env.is_empty() && envs.insert(s.env), "{}", s.env);
        assert!(
            s.env
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
            "{}",
            s.env
        );
        if let Some(key) = s.key {
            assert!(keys.insert(key), "{key}");
        }
        assert_eq!(by_env(s.env), Some(*s));
        if s.scope == Scope::Provider {
            assert!(s.env.starts_with("OIDC_ID_"), "{}", s.env);
        }
    }
    assert_eq!(by_env("NOT_A_SETTING"), None);
}

#[test]
fn only_live_settings_have_a_key_and_can_be_public() {
    for s in ALL {
        let Setting {
            env,
            key,
            kind: _,
            default: _,
            scope,
            public,
        } = **s;
        match scope {
            Scope::Live => assert!(key.is_some(), "{env} has a key"),
            Scope::Start | Scope::P2p | Scope::Provider | Scope::Build => {
                assert!(key.is_none() && !public, "{env} is set only in the env")
            }
        }
    }
}

#[test]
fn every_default_is_a_value_its_kind_takes() {
    for s in ALL {
        let env = s.env;
        match (s.kind, s.default) {
            (Kind::Switch, Preset::On | Preset::Off) => {}
            (Kind::Number { min, max }, Preset::Number(n)) => {
                assert!(min <= max && (min..=max).contains(&n), "{env}")
            }
            (Kind::Number { min, max }, Preset::Picked(rule)) => {
                assert!(min <= max && !rule.is_empty(), "{env}")
            }
            (Kind::Choice(words), Preset::Text(word)) => {
                assert!(words.contains(&word), "{env}");
                for w in words {
                    assert_eq!(*w, w.to_ascii_lowercase(), "{env}");
                }
            }
            (Kind::Text { min, max, lines: _ }, Preset::Text(text)) => {
                assert!((min..=max).contains(&text.chars().count()), "{env}")
            }
            (Kind::Forms, Preset::Picked(rule)) => assert!(!rule.is_empty(), "{env}"),
            (
                Kind::Targets | Kind::Names | Kind::Servers | Kind::Links | Kind::Suggestions,
                Preset::Text(_),
            ) => {}
            (Kind::Numbers, Preset::Text("{}")) | (Kind::Pins, Preset::Text("")) => {}
            (Kind::Value, Preset::Unset | Preset::Text(_) | Preset::Picked(_)) => {}
            (Kind::Secret, Preset::Unset) => {}
            (kind, default) => panic!("{env}: {kind:?} with {default:?}"),
        }
    }
}

#[test]
fn registry_text_is_plain_ascii() {
    assert!(json().bytes().all(|b| (b' '..=b'~').contains(&b)));
}
