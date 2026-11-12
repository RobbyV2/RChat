use rchat_automation::access::{self, Actor, Fired, Member, Poster, Reach};
use rchat_automation::budget::Gatherer;
use rchat_automation::grants::{self, Refusal};
use rchat_automation::keywords;
use rchat_automation::onboarding::{self, Facts, Gate, Missing, Onboarding};
use rchat_automation::panel::{self, Change, Mode, Press};
use rchat_automation::template::{self, Span, Vars};
use rchat_automation::timing;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

fn cases(file: &str) -> Vec<Value> {
    let path = format!("{}/vectors/{file}.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let doc: Value = serde_json::from_str(&text).expect("json");
    assert_eq!(doc["v"], 1, "{file}");
    doc["cases"].as_array().expect("cases").clone()
}

fn read<T: for<'de> Deserialize<'de>>(v: &Value) -> T {
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v}: {e}"))
}

#[test]
fn keywords_vectors() {
    let all = cases("keywords");
    assert_eq!(all.len(), 23);
    for c in all {
        let text: String = read(&c["text"]);
        let list: Vec<String> = read(&c["list"]);
        let allow: Vec<String> = read(&c["allow"]);
        let want: Option<String> = read(&c["hit"]);
        let linear = keywords::find(&text, &list, &allow).map(|h| list[h.entry].clone());
        assert_eq!(linear, want, "{c}");
        let set = keywords::KeywordSet::new(&list, &allow);
        let fast = set.find(&text).map(|h| list[h.entry].clone());
        assert_eq!(fast, want, "{c}");
    }
}

#[test]
fn templates_vectors() {
    let all = cases("templates");
    assert_eq!(all.len(), 37);
    let mut spans = 0;
    for c in all {
        if c.get("spans").is_some() {
            let code = format!("@X7Q-993-ALPHA https://a.b {}", "z".repeat(120));
            let vars = Vars {
                name: "bob".into(),
                display: "Bob".into(),
                values: BTreeMap::from([("args.code".to_string(), code)]),
                ping: false,
            };
            let got = template::render_spans("Linked with {args.code}. Done.", &vars);
            assert_eq!(Value::from(got.text), c["text"]);
            let want: Span = read(&c["span"]);
            assert_eq!(got.spans, [want]);
            spans += 1;
            continue;
        }
        let text: String = read(&c["text"]);
        let vars = Vars {
            name: c.get("name").map_or_else(|| "bob".to_string(), read),
            display: read(&c["display"]),
            values: read(&c["values"]),
            ping: read(&c["ping"]),
        };
        let out = template::render(&text, &vars);
        assert_eq!(Value::from(out.clone()), c["out"], "{c}");
        assert_eq!(
            template::pings(&out),
            read::<Vec<String>>(&c["pings"]),
            "{c}"
        );
        assert_eq!(template::links(&out), read::<bool>(&c["links"]), "{c}");
        assert_eq!(template::render_spans(&text, &vars).text, out, "{c}");
    }
    assert_eq!(spans, 1);
}

#[test]
fn grants_vectors() {
    let all = cases("grants");
    assert_eq!(all.len(), 13);
    for c in all {
        let got =
            grants::self_service(read(&c["bits"]), read(&c["mayGive"]), read(&c["ownerBits"]));
        assert_eq!(got, read::<Option<Refusal>>(&c["out"]), "{c}");
    }
}

#[test]
fn panels_vectors() {
    let all = cases("panels");
    assert_eq!(all.len(), 27);
    for c in all {
        match c["op"].as_str() {
            Some("press") => {
                let got = panel::press(
                    &read::<Mode>(&c["mode"]),
                    &read::<Vec<i64>>(&c["held"]),
                    &read::<Vec<i64>>(&c["panel"]),
                    read(&c["role"]),
                    read(&c["picked"]),
                );
                assert_eq!(got, read::<Change>(&c["out"]), "{c}");
                assert_eq!(serde_json::to_value(&got).expect("json"), c["out"], "{c}");
            }
            Some("select") => {
                let got = panel::select(
                    &read::<Mode>(&c["mode"]),
                    &read::<Vec<i64>>(&c["held"]),
                    &read::<Vec<i64>>(&c["panel"]),
                    &read::<Vec<i64>>(&c["values"]),
                    read(&c["picked"]),
                );
                assert_eq!(got, read::<Change>(&c["out"]), "{c}");
                assert_eq!(serde_json::to_value(&got).expect("json"), c["out"], "{c}");
            }
            Some("latest") => {
                let presses: Vec<Press> = read(&c["presses"]);
                let latest = panel::latest_press(&presses).map(|p| p.id.clone());
                assert_eq!(latest, read::<Option<String>>(&c["latest"]), "{c}");
            }
            op => panic!("unknown op {op:?}"),
        }
    }
}

#[test]
fn wants_vectors() {
    let all = cases("wants");
    assert_eq!(all.len(), 40);
    for c in all {
        let got = panel::apply_want(
            &read::<Mode>(&c["mode"]),
            &read::<panel::Want>(&c["want"]),
            &read::<Vec<i64>>(&c["held"]),
            &read::<Vec<i64>>(&c["panel"]),
            read(&c["role"]),
        );
        assert_eq!(got, read::<Change>(&c["out"]), "{c}");
        assert_eq!(serde_json::to_value(&got).expect("json"), c["out"], "{c}");
        let press = Press {
            id: "p".into(),
            deps: vec![],
            want: read(&c["want"]),
            at: 0,
        };
        let again = panel::reconcile(
            &read::<Mode>(&c["mode"]),
            &[press],
            &read::<Vec<i64>>(&c["held"]),
            &read::<Vec<i64>>(&c["panel"]),
            read(&c["role"]),
        );
        assert_eq!(again, got, "{c}");
    }
}

#[test]
fn onboarding_vectors() {
    let all = cases("onboarding");
    assert_eq!(all.len(), 25);
    for c in all {
        let config: Onboarding = read(&c["config"]);
        let facts: Facts = read(&c["facts"]);
        let missing = onboarding::missing(&config, &facts);
        assert_eq!(missing, read::<Vec<Missing>>(&c["missing"]), "{c}");
        assert_eq!(
            serde_json::to_value(&missing).expect("json"),
            c["missing"],
            "{c}"
        );
        assert_eq!(
            onboarding::recompute(&config, &facts),
            read::<Gate>(&c["recompute"]),
            "{c}"
        );
    }
}

#[test]
fn access_vectors() {
    let all = cases("access");
    assert_eq!(all.len(), 2);
    for c in all {
        let m: Member = read(&c["member"]);
        assert_eq!(
            access::acting_bits(&m, true),
            read::<u32>(&c["acting"]),
            "{c}"
        );
        assert_eq!(
            access::seeing_bits(&m, true),
            read::<u32>(&c["seeing"]),
            "{c}"
        );
        assert_eq!(access::rank_bits(&m), read::<u32>(&c["rank"]), "{c}");
    }
}

const TIMED_ROLE_UNDO: &str =
    "the undo that ends a timed role answers to the member whose run gave it";
const DELAYED_ACTION: &str = "an action delayed with after answers to the member whose run it is";
const ONBOARDING_ANSWER: &str = "a joiner picking Ping through onboarding gets no Helper with Kick";
const ROLE_MEMORY: &str = "a member whose Ping comes back on rejoin gets no Helper with Kick";

#[test]
fn run_check_vectors() {
    let all = cases("run_check");
    assert_eq!(all.len(), 455);
    let mut ops = BTreeMap::new();
    for c in &all {
        let op = c["op"].as_str().expect("op");
        *ops.entry(op.to_string()).or_insert(0) += 1;
        match op {
            "actor" => {
                let caused: Vec<Option<i64>> = read(&c["caused"]);
                let got = access::actor(
                    read::<Fired>(&c["fired"]),
                    read(&c["acted"]),
                    caused.first().copied(),
                );
                assert_eq!(got, read::<Option<i64>>(&c["out"]), "{c}");
            }
            "actor_of" => {
                let got = Actor::of(
                    read(&c["id"]),
                    &read::<Member>(&c["member"]),
                    read(&c["switch_on"]),
                );
                assert_eq!(got, read::<Actor>(&c["out"]), "{c}");
                assert_eq!(serde_json::to_value(got).expect("json"), c["out"], "{c}");
            }
            "author" => {
                let caused: Vec<Option<i64>> = read(&c["caused"]);
                let got = access::author(
                    read(&c["reach"]),
                    read::<Poster>(&c["poster"]),
                    caused.first().copied(),
                );
                assert_eq!(got, read::<Option<i64>>(&c["out"]), "{c}");
            }
            "revoke_of" => {
                let got =
                    access::revoke_of(read(&c["bits"]), read(&c["owner"]), read(&c["widens"]));
                assert_eq!(got, read::<Reach>(&c["out"]), "{c}");
                assert_eq!(serde_json::to_value(got).expect("json"), c["out"], "{c}");
            }
            "grant_of" => {
                let got =
                    access::grant_of(read(&c["bits"]), read(&c["may_give"]), read(&c["owner"]));
                assert_eq!(got, read::<Reach>(&c["out"]), "{c}");
                assert_eq!(serde_json::to_value(got).expect("json"), c["out"], "{c}");
            }
            "may_run" => {
                let got = access::may_run(
                    read(&c["reach"]),
                    read(&c["needs"]),
                    read(&c["owner"]),
                    read::<Option<Actor>>(&c["actor"]),
                    read::<Option<(i64, u32)>>(&c["target"]),
                    read(&c["picked"]),
                );
                assert_eq!(got, read::<bool>(&c["out"]), "{c}");
            }
            op => panic!("unknown op {op:?}"),
        }
    }
    assert_eq!(
        ops,
        BTreeMap::from([
            ("actor".to_string(), 34),
            ("actor_of".to_string(), 17),
            ("author".to_string(), 95),
            ("grant_of".to_string(), 15),
            ("may_run".to_string(), 273),
            ("revoke_of".to_string(), 21),
        ])
    );
    let named = |name: &str| -> Vec<(String, Value)> {
        all.iter()
            .filter(|c| c["case"] == name)
            .map(|c| (c["op"].as_str().expect("op").to_string(), c["out"].clone()))
            .collect()
    };
    let steps = |list: &[(&str, Value)]| -> Vec<(String, Value)> {
        list.iter()
            .map(|(op, out)| (op.to_string(), out.clone()))
            .collect()
    };
    assert_eq!(
        named(TIMED_ROLE_UNDO),
        steps(&[
            ("actor", 1.into()),
            ("grant_of", "self_grant".into()),
            ("may_run", true.into()),
            ("actor", 1.into()),
            ("grant_of", "grant".into()),
            ("may_run", false.into()),
            ("may_run", true.into()),
        ])
    );
    assert_eq!(
        named(DELAYED_ACTION),
        steps(&[
            ("actor", 1.into()),
            ("grant_of", "grant".into()),
            ("may_run", false.into()),
        ])
    );
    for name in [ONBOARDING_ANSWER, ROLE_MEMORY] {
        assert_eq!(
            named(name),
            steps(&[
                ("actor", 1.into()),
                ("grant_of", "grant".into()),
                ("may_run", false.into()),
                ("may_run", true.into()),
                ("grant_of", "self_grant".into()),
                ("may_run", true.into()),
            ]),
            "{name}"
        );
    }
}

#[test]
fn gather_vectors() {
    let all = cases("gather");
    assert_eq!(all.len(), 2);
    let deletes = &all[0];
    assert_eq!(deletes["case"], "20 deletes");
    let mut g = Gatherer::new(60);
    for i in 0..20i64 {
        g.add(3, "spammer", &format!("msg{i}"), 1000 + i);
    }
    let cards = g.all();
    assert_eq!(Value::from(cards.len()), deletes["cards"]);
    assert_eq!(Value::from(cards[0].count), deletes["count"]);
    assert_eq!(Value::from(cards[0].items.len()), deletes["items"]);

    let joiners = &all[1];
    assert_eq!(joiners["case"], "500 joiners");
    let mut g = Gatherer::new(60);
    for i in 0..500 {
        g.add(4, &format!("joiner{i}"), &format!("join{i}"), 5000);
    }
    assert_eq!(Value::from(g.all().len()), joiners["cards"]);
    assert_eq!(
        Value::from(g.summaries().values().sum::<u64>()),
        joiners["summarized"]
    );
}

#[test]
fn timing_vectors() {
    let all = cases("timing");
    assert_eq!(all.len(), 2);
    let many = |v: f64| (0..100).map(|i| v + f64::from(i % 5)).collect::<Vec<f64>>();
    for c in all {
        let set = many(read(&c["set"]));
        let reference = many(read(&c["reference"]));
        let v = timing::verdict(&set, &reference, timing::BUDGET_US);
        assert_eq!(v.ok, read::<bool>(&c["ok"]), "{c}");
        assert_eq!(v.calibrated, read::<f64>(&c["calibrated"]), "{c}");
    }
}

#[test]
fn runner_topological_order_vector() {
    let all = cases("runner");
    assert_eq!(all.len(), 6);
    let topo = all.iter().find(|c| c["case"] == "topo").expect("topo case");
    let events: Vec<panel::Event> = read(&topo["events"]);
    assert_eq!(
        panel::topo_order(&events),
        read::<Vec<String>>(&topo["order"])
    );
}

#[cfg(feature = "tz")]
#[test]
fn schedules_vectors_on_the_system_and_the_bundled_time_zone_database() {
    use rchat_automation::schedule::{self, Schedule};
    let all = cases("schedules");
    assert_eq!(all.len(), 42);
    let bundled = jiff::tz::TimeZoneDatabase::bundled();
    for c in all {
        let s: Schedule = read(&c["schedule"]);
        assert!(schedule::problems(&s, 10).is_empty(), "{c}");
        let name: String = read(&c["tz"]);
        let zones = [
            schedule::zone(&name).expect("zone"),
            bundled.get(&name).expect("bundled zone"),
        ];
        let want: Option<i64> = read(&c["next"]);
        for tz in &zones {
            let got = match c.get("due") {
                Some(due) => schedule::resume(&s, tz, read(due), read(&c["now"])),
                None => schedule::next(&s, tz, read(&c["after"])),
            };
            assert_eq!(got, want, "{c}");
        }
    }
}

#[test]
fn levels_vectors() {
    use rchat_automation::levels;
    let all = cases("levels");
    assert_eq!(all.len(), 101);
    for c in all {
        let level: u32 = read(&c["level"]);
        let total: i64 = read(&c["total"]);
        assert_eq!(levels::total(level), total, "{c}");
        assert_eq!(levels::cost(level), read::<i64>(&c["cost"]), "{c}");
        assert_eq!(levels::level(total), level, "{c}");
    }
}

#[test]
fn giveaway_vectors() {
    use rchat_automation::giveaway;
    let all = cases("giveaway");
    assert_eq!(all.len(), 8);
    for c in all {
        let entries: Vec<String> = read(&c["entries"]);
        let seed = giveaway::seed_from_hex(c["seed"].as_str().expect("seed")).expect("seed");
        let winners = giveaway::draw(&entries, read(&c["n"]), &seed);
        assert_eq!(winners, read::<Vec<String>>(&c["winners"]), "{c}");
    }
}

#[test]
fn components_vectors() {
    use rchat_automation::model::{
        Action, ActionKind, Automation, Components, Options, Place, Trigger,
    };
    use rchat_automation::validate::{Caps, validate};
    let all = cases("components");
    assert_eq!(all.len(), 13);
    for c in all {
        let components: Components = read(&c["components"]);
        assert_eq!(
            serde_json::to_value(&components).expect("json"),
            c["components"],
            "{c}"
        );
        let automation = Automation {
            name: "Panel".into(),
            enabled: true,
            avatar: None,
            tz: "UTC".into(),
            trigger: Trigger::MemberAdmitted,
            conditions: vec![],
            actions: vec![Action {
                aid: "a1".into(),
                after: 0,
                after_post: false,
                kind: ActionKind::SendMessage {
                    channel: Place::Channel(3),
                    text: "Pick the games you play.".into(),
                    embed: None,
                    components,
                    ping: false,
                },
            }],
            options: Options::default(),
            kit: None,
        };
        let problems: Vec<String> = match validate(&automation, &Caps::default()) {
            Ok(_) => vec![],
            Err(problems) => problems
                .into_iter()
                .map(|p| p.path.trim_start_matches("actions.0.").to_string())
                .collect(),
        };
        assert_eq!(problems, read::<Vec<String>>(&c["problems"]), "{c}");
    }
}

#[test]
fn every_vector_file_is_replayed() {
    let dir = format!("{}/vectors", env!("CARGO_MANIFEST_DIR"));
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("vectors")
        .map(|e| e.expect("entry").file_name().into_string().expect("name"))
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "access.json",
            "components.json",
            "gather.json",
            "giveaway.json",
            "grants.json",
            "keywords.json",
            "levels.json",
            "onboarding.json",
            "panels.json",
            "redact.json",
            "run_check.json",
            "runner.json",
            "schedules.json",
            "templates.json",
            "timing.json",
            "wants.json",
        ]
    );
    assert_eq!(cases("redact").len(), 33);
}
