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

const ENV_FILE: &str = "../../.env.local.example";

// `UPDATE_FIXTURES=1 cargo test -p rchat-settings` rewrites `.env.local.example` too.
#[test]
fn the_env_example_is_the_registry() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(ENV_FILE);
    let want = rchat_settings::env_example();
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::write(&path, &want).expect("write the env file");
    }
    let got = std::fs::read_to_string(&path).expect("read the env file");
    assert!(
        got == want,
        "run UPDATE_FIXTURES=1 cargo test -p rchat-settings"
    );
}

#[test]
fn every_setting_has_one_line_in_the_env_file() {
    use rchat_settings::env::{BLOCKS, Line};
    let mut seen = BTreeSet::new();
    for line in BLOCKS.iter().flat_map(|b| b.iter()) {
        match line {
            Line::Note(text) => assert!(text.starts_with('#') && !text.contains('\n'), "{text}"),
            Line::Set(s, _) | Line::Shown(s, _) => assert!(seen.insert(s.env), "{} twice", s.env),
        }
    }
    let all: BTreeSet<&str> = ALL.iter().map(|s| s.env).collect();
    assert_eq!(seen, all);
}

fn readable(n: i64) -> String {
    n.to_string()
}

/// Numbers whose comment gives a narrower rule than the range, which their reader checks: ports,
/// and the STUN count, which matters only while public STUN is on.
fn ruled_by_reader(env: &str) -> bool {
    env == "PORT" || env.ends_with("_PORT") || env == "PUBLIC_STUN_COUNT"
}

#[test]
fn each_line_shows_the_default_and_its_comment_says_what_the_setting_takes() {
    let mut wrong = Vec::new();
    for s in ALL {
        let env = s.env;
        let shown = rchat_settings::shown(s).expect("a line");
        let doc = rchat_settings::doc(s).join(" ");
        let unquoted = shown
            .strip_prefix('\'')
            .and_then(|v| v.strip_suffix('\''))
            .unwrap_or(shown);
        let says = |words: &str| doc.contains(words);
        match (s.kind, s.default) {
            (Kind::Number { min, max }, Preset::Number(n)) => {
                if unquoted != readable(n) {
                    wrong.push(format!("{env}: shows {shown}, default {n}"));
                }
                if !says(&format!("{min} to {max}")) && !ruled_by_reader(env) {
                    wrong.push(format!("{env}: no {min} to {max}"));
                }
            }
            (Kind::Number { min, max }, Preset::Picked(_)) => {
                if !says(&format!("{min} to {max}")) && !ruled_by_reader(env) {
                    wrong.push(format!("{env}: no {min} to {max}"));
                }
            }
            (Kind::Switch, Preset::On | Preset::Off) => {
                let on = s.default == Preset::On;
                let reads = match unquoted {
                    "on" | "true" => Some(true),
                    "off" | "false" => Some(false),
                    _ => None,
                };
                if reads != Some(on) {
                    wrong.push(format!("{env}: shows {shown}"));
                }
            }
            (Kind::Choice(_), Preset::Text(word)) if unquoted != word => {
                wrong.push(format!("{env}: shows {shown}, default {word}"))
            }
            _ => {}
        }
        if s.kind != Kind::Pins && (s.scope == Scope::Live) != says("Admin page") {
            wrong.push(format!("{env}: Admin page marking"));
        }
    }
    assert_eq!(wrong, Vec::<String>::new());
}

const ROWS_FILE: &str = "../../apps/web/app/lib/admin/rows.gen.ts";

// `UPDATE_FIXTURES=1 cargo test -p rchat-settings` rewrites the web app's rows too.
#[test]
fn the_admin_rows_are_the_registry() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(ROWS_FILE);
    let want = rchat_settings::admin::rows_ts();
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::create_dir_all(path.parent().expect("dir")).expect("dir");
        std::fs::write(&path, &want).expect("write the rows");
    }
    let got = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        got == want,
        "run UPDATE_FIXTURES=1 cargo test -p rchat-settings"
    );
}

#[test]
fn every_live_setting_has_one_row_that_fits_its_kind() {
    use rchat_settings::admin::{GROUPS, Place, ROWS, View};
    let mut seen = BTreeSet::new();
    for r in ROWS {
        let s = r.setting;
        assert_eq!(s.scope, Scope::Live, "{}", s.env);
        assert!(seen.insert(s.env), "{} twice", s.env);
        if let Place::Features { group, under } = r.place {
            assert!(GROUPS.contains(&group), "{}", s.env);
            if let Some(under) = under {
                assert!(
                    ROWS.iter().any(|o| o.setting.key == Some(under)),
                    "{}",
                    s.env
                );
            }
        }
        let fits = match (&r.view, s.kind) {
            (View::Switch { off: _ }, Kind::Switch) => true,
            (
                View::Choice {
                    options,
                    list: _,
                    note: _,
                },
                Kind::Choice(words),
            ) => options.iter().map(|o| o.value).eq(words.iter().copied()),
            (View::Number { unit: _ }, Kind::Number { min: _, max: _ }) => true,
            (View::Targets, Kind::Targets) | (View::Names, Kind::Names) => true,
            (View::Link { to: _, action: _ }, Kind::Servers) | (View::Info, Kind::Forms) => true,
            (
                View::Text { placeholder: _ },
                Kind::Text {
                    min: _,
                    max: _,
                    lines: _,
                },
            ) => true,
            (View::Links, Kind::Links) | (View::Suggestions, Kind::Suggestions) => true,
            (_, _) => false,
        };
        assert!(fits, "{}", s.env);
    }
    let live: BTreeSet<&str> = ALL
        .iter()
        .filter(|s| s.scope == Scope::Live)
        .map(|s| s.env)
        .collect();
    assert_eq!(seen, live);
}
