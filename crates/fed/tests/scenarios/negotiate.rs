use std::collections::BTreeSet;

use rchat_fed::levels::{self, Service};
use rchat_fed::negotiate::{
    Caps, FeatureUse, Gap, Level, NoUse, Release, feature_use, service_use, window_violations,
};

use crate::support::{ours, v080};

fn level(name: &str, level: u32, min: u32) -> Level {
    Level {
        name: name.to_string(),
        level,
        min,
    }
}

fn caps(features: &[(&str, u32, u32)], majors: &[u32]) -> Caps {
    Caps {
        majors: majors.to_vec(),
        features: features
            .iter()
            .map(|(name, lv, min)| level(name, *lv, *min))
            .collect(),
    }
}

fn rel(name: &str, features: &[(&str, u32, u32)], services: &[(&str, &[&str])]) -> Release {
    rel_on(name, features, services, &[1])
}

fn rel_on(
    name: &str,
    features: &[(&str, u32, u32)],
    services: &[(&str, &[&str])],
    majors: &[u32],
) -> Release {
    Release {
        name: name.to_string(),
        caps: caps(features, majors),
        services: services
            .iter()
            .map(|(svc, needs)| {
                (
                    svc.to_string(),
                    needs.iter().map(|n| n.to_string()).collect(),
                )
            })
            .collect(),
    }
}

fn no(feature: &str, gap: Gap) -> NoUse {
    NoUse {
        feature: feature.to_string(),
        gap,
    }
}

#[test]
fn both_sides_speak_the_lower_of_their_levels() {
    assert_eq!(
        feature_use(&level("x", 3, 1), Some(&level("x", 2, 1))),
        FeatureUse::Use(2)
    );
}

#[test]
fn a_floor_above_the_other_side_is_a_gap_named_from_our_side() {
    assert_eq!(
        feature_use(&level("x", 3, 3), Some(&level("x", 2, 1))),
        FeatureUse::Gap(Gap::TheirsOld)
    );
    assert_eq!(
        feature_use(&level("x", 2, 1), Some(&level("x", 4, 3))),
        FeatureUse::Gap(Gap::OursOld)
    );
    assert_eq!(
        feature_use(&level("x", 2, 1), None),
        FeatureUse::Gap(Gap::Missing)
    );
}

#[test]
fn the_0_9_0_and_0_8_0_releases_talk_letters_and_0_9_0_only_services_are_missing_on_0_8_0() {
    let levels = service_use(Service::Letters.needs(), &ours(), &v080()).unwrap();
    assert_eq!(levels.get("core"), Some(&1));
    assert_eq!(levels.get("letters"), Some(&1));
    assert_eq!(
        service_use(Service::Invites.needs(), &ours(), &v080()),
        Err(no("invites", Gap::Missing))
    );
}

#[test]
fn a_release_before_0_8_0_has_no_protocol_at_all() {
    assert_eq!(
        service_use(Service::Letters.needs(), &ours(), &Caps::default()),
        Err(no("core", Gap::Major))
    );
}

#[test]
fn a_feature_we_dont_speak_ourselves_is_missing() {
    assert_eq!(
        service_use(&["core", "moves"], &ours(), &ours()),
        Err(no("moves", Gap::Missing))
    );
}

#[test]
fn the_shipped_table_follows_the_release_rules() {
    let table = levels::releases();
    assert_eq!(
        table.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
        ["0.8.0", "0.9.0"]
    );
    assert_eq!(window_violations(&table), Vec::<String>::new());
}

#[test]
fn the_table_is_spec_4_4_3_with_sealed_letters() {
    let table = levels::releases();
    let names = |r: &Release| {
        r.caps
            .features
            .iter()
            .map(|f| f.name.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        names(&table[0]),
        [
            "core",
            "letters",
            "letters.files",
            "letters.keys",
            "letters.sealed"
        ]
    );
    assert_eq!(
        names(&table[1]),
        [
            "core",
            "letters",
            "letters.files",
            "letters.keys",
            "letters.sealed",
            "invites",
            "profiles",
            "reports",
            "directory"
        ]
    );
    for release in &table {
        assert_eq!(release.caps.majors, [1]);
        for f in &release.caps.features {
            assert_eq!((f.level, f.min), (1, 1), "{}", f.name);
        }
    }
    let services = |r: &Release| {
        r.services
            .iter()
            .map(|(s, _)| s.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        services(&table[0]),
        ["core", "letters", "letter_files", "letter_keys"]
    );
    assert_eq!(
        services(&table[1]),
        Service::ALL.map(|s| s.name().to_string())
    );
    for (name, needs) in &table[1].services {
        let service = Service::from_name(name).unwrap();
        assert_eq!(needs, service.needs());
        assert_eq!(needs[0], "core");
    }
}

#[test]
fn sealed_letters_are_listed_only_by_an_instance_that_ships_them_and_no_service_needs_them() {
    let plain = levels::ours("0.9.0", false).unwrap();
    let sealed = levels::ours("0.9.0", true).unwrap();
    assert!(!plain.features.iter().any(|f| f.name == levels::SEALED));
    assert_eq!(
        sealed
            .features
            .iter()
            .filter(|f| f.name == levels::SEALED)
            .map(|f| (f.level, f.min))
            .collect::<Vec<_>>(),
        [(1, 1)]
    );
    assert_eq!(sealed.features.len(), plain.features.len() + 1);
    for service in Service::ALL {
        assert!(!service.needs().contains(&levels::SEALED));
        assert!(service_use(service.needs(), &plain, &sealed).is_ok());
        assert!(service_use(service.needs(), &sealed, &plain).is_ok());
    }
    assert!(levels::lists_sealed(&sealed));
    assert!(!levels::lists_sealed(&plain));
    assert!(!levels::lists_sealed(&v080()));
}

#[test]
fn the_apps_and_moves_slots_are_reserved_and_no_release_uses_them() {
    assert_eq!(levels::RESERVED, ["apps", "moves"]);
    for release in levels::releases() {
        for name in levels::RESERVED {
            assert!(!release.caps.features.iter().any(|f| f.name == name));
            assert!(!release.services.iter().any(|(svc, _)| svc == name));
        }
    }
    for name in levels::RESERVED {
        assert_eq!(Service::from_name(name), None);
    }
}

#[test]
fn every_method_in_the_schema_belongs_to_one_service_of_the_table() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../proto");
    let mut files = std::fs::read_dir(format!("{root}/rchat/fed/v1"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    files.sort();
    let schema = protox::compile(&files, [root]).unwrap();
    let mut methods = BTreeSet::new();
    let mut empty = Vec::new();
    for file in &schema.file {
        for service in &file.service {
            if service.method.is_empty() {
                empty.push(service.name().to_string());
            }
            for method in &service.method {
                methods.insert(format!(
                    "/{}.{}/{}",
                    file.package(),
                    service.name(),
                    method.name()
                ));
            }
        }
    }
    assert_eq!(empty, ["AppsService"]);
    assert_eq!(methods.len(), 12);
    let of = |path: &str| Service::of_method(path);
    for path in &methods {
        assert!(of(path).is_some(), "{path}");
    }
    assert_eq!(
        of("/rchat.fed.v1.InstanceService/Hello"),
        Some(Service::Core)
    );
    for method in ["Deliver", "PutObjects", "Pull"] {
        assert_eq!(
            of(&format!("/rchat.fed.v1.LettersService/{method}")),
            Some(Service::Letters)
        );
    }
    assert_eq!(
        of("/rchat.fed.v1.LettersService/PullFile"),
        Some(Service::LetterFiles)
    );
    assert_eq!(
        of("/rchat.fed.v1.LettersService/GetKey"),
        Some(Service::LetterKeys)
    );
    assert_eq!(
        of("/rchat.fed.v1.InvitesService/Icon"),
        Some(Service::Invites)
    );
    assert_eq!(
        of("/rchat.fed.v1.ProfilesService/Avatar"),
        Some(Service::Profiles)
    );
    assert_eq!(
        of("/rchat.fed.v1.ReportsService/Forward"),
        Some(Service::Reports)
    );
    assert_eq!(
        of("/rchat.fed.v1.DirectoryService/Search"),
        Some(Service::Directory)
    );
    assert_eq!(of("/rchat.fed.v1.AppsService/Open"), None);
    assert_eq!(of("/rchat.fed.v1.LettersService/Nope"), None);
    assert_eq!(
        Service::ALL
            .iter()
            .filter(|s| methods.iter().any(|m| of(m) == Some(**s)))
            .count(),
        Service::ALL.len()
    );
}

#[test]
fn dropping_a_feature_that_a_continuing_service_still_requires_fails() {
    let history = [
        rel(
            "r0",
            &[("core", 1, 1), ("letters", 1, 1)],
            &[("letters", &["core", "letters"])],
        ),
        rel(
            "r1",
            &[("core", 1, 1)],
            &[("letters", &["core", "letters"])],
        ),
    ];
    assert!(
        window_violations(&history)
            .contains(&"r1 letters: removed while required within the window".to_string())
    );
}

#[test]
fn dropping_major_1_in_one_step_fails() {
    let history = [
        rel_on("r0", &[("core", 1, 1)], &[("core", &["core"])], &[1]),
        rel_on("r1", &[("core", 1, 1)], &[("core", &["core"])], &[2]),
    ];
    assert!(window_violations(&history).contains(&"r1: no major in common with r0".to_string()));
}

#[test]
fn a_new_feature_may_start_at_any_floor() {
    let history = [
        rel("r0", &[("core", 1, 1)], &[("core", &["core"])]),
        rel(
            "r1",
            &[("core", 1, 1), ("invites", 2, 2)],
            &[("core", &["core"]), ("invites", &["core", "invites"])],
        ),
    ];
    assert_eq!(window_violations(&history), Vec::<String>::new());
}

#[test]
fn raising_a_floor_needs_every_release_in_the_window_to_speak_that_level() {
    let mut history = vec![
        rel("r0", &[("letters", 1, 1)], &[]),
        rel("r1", &[("letters", 2, 1)], &[]),
        rel("r2", &[("letters", 2, 2)], &[]),
    ];
    assert_eq!(
        window_violations(&history),
        ["r2 letters: floor 2 raised too early"]
    );
    history.push(rel("r3", &[("letters", 3, 2)], &[]));
    history[2] = rel("r2", &[("letters", 2, 1)], &[]);
    assert_eq!(window_violations(&history), Vec::<String>::new());
}

#[test]
fn levels_and_floors_never_go_down_and_a_floor_stays_at_or_below_its_level() {
    let history = [
        rel("r0", &[("letters", 3, 2)], &[]),
        rel("r1", &[("letters", 2, 1)], &[]),
        rel("r2", &[("letters", 2, 3)], &[]),
    ];
    assert_eq!(
        window_violations(&history),
        [
            "r1 letters: level went down",
            "r1 letters: floor went down",
            "r2 letters: min above level",
            "r2 letters: floor 3 raised too early",
        ]
    );
}

#[test]
fn a_continuing_service_may_require_a_new_feature_only_after_it_shipped_for_the_window() {
    let history = [
        rel(
            "r0",
            &[("core", 1, 1), ("letters", 1, 1)],
            &[("letters", &["core", "letters"])],
        ),
        rel(
            "r1",
            &[("core", 1, 1), ("letters", 1, 1), ("letters.v2", 1, 1)],
            &[("letters", &["core", "letters", "letters.v2"])],
        ),
    ];
    assert!(
        window_violations(&history)
            .contains(&"r1 letters: requires letters.v2 too early".to_string())
    );
}

#[test]
fn a_service_can_be_dropped_together_with_its_feature() {
    let base: &[(&str, u32, u32)] = &[("core", 1, 1), ("x", 1, 1)];
    let both: &[(&str, &[&str])] = &[("core", &["core"]), ("s", &["core", "x"])];
    let history = [
        rel("r0", base, both),
        rel("r1", base, both),
        rel("r2", base, both),
        rel("r3", &[("core", 1, 1)], &[("core", &["core"])]),
    ];
    assert_eq!(window_violations(&history), Vec::<String>::new());
}

#[test]
fn a_feature_still_required_cant_go_and_a_service_cant_go_while_its_features_stay() {
    let base: &[(&str, u32, u32)] = &[("core", 1, 1), ("x", 1, 1)];
    let kept = [
        rel(
            "r0",
            base,
            &[
                ("core", &["core"]),
                ("s", &["core", "x"]),
                ("t", &["core", "x"]),
            ],
        ),
        rel(
            "r1",
            &[("core", 1, 1)],
            &[("core", &["core"]), ("t", &["core", "x"])],
        ),
    ];
    assert!(
        window_violations(&kept)
            .contains(&"r1 x: removed while required within the window".to_string())
    );
    let dropped = [
        rel("r0", base, &[("core", &["core"]), ("s", &["core", "x"])]),
        rel("r1", base, &[("core", &["core"])]),
    ];
    assert!(
        window_violations(&dropped).contains(&"r1 s: dropped while its features stay".to_string())
    );
}

#[test]
fn patch_releases_are_not_in_the_table() {
    assert_eq!(
        window_violations(&[rel("0.9.1", &[("core", 1, 1)], &[])]),
        ["0.9.1: not a minor release"]
    );
    for name in ["0.10.0", "12.0.0", "r7"] {
        assert_eq!(
            window_violations(&[rel(name, &[("core", 1, 1)], &[])]),
            Vec::<String>::new()
        );
    }
    for name in ["0.9", "v0.9.0", "0.9.0-rc1", "r", "0..0"] {
        assert_eq!(
            window_violations(&[rel(name, &[("core", 1, 1)], &[])]),
            [format!("{name}: not a minor release")]
        );
    }
}

#[test]
fn releases_before_the_protocol_are_never_part_of_the_window() {
    let mut history = vec![Release {
        name: "0.7.0".to_string(),
        caps: Caps::default(),
        services: Vec::new(),
    }];
    history.extend(levels::releases());
    assert_eq!(window_violations(&history), Vec::<String>::new());
}

type Feat = (String, u32, u32);
type Services = Vec<(String, Vec<String>)>;

struct Lcg(f64);

impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = (self.0 * 1_103_515_245.0 + 12_345.0) % 2_147_483_648.0;
        self.0 / 2_147_483_648.0
    }

    fn pick(&mut self, len: usize) -> Option<usize> {
        let at = (self.next() * len as f64).floor() as usize;
        (at < len).then_some(at)
    }
}

fn release(name: String, feats: &[Feat], services: &Services, majors: &[u32]) -> Release {
    Release {
        name,
        caps: Caps {
            majors: majors.to_vec(),
            features: feats.iter().map(|(n, l, m)| level(n, *l, *m)).collect(),
        },
        services: services.clone(),
    }
}

#[test]
fn property_accepted_histories_always_talk_within_the_window() {
    let mut rnd = Lcg(7.0);
    let (mut accepted, mut with_removal, mut with_major, mut with_drop) = (0, 0, 0, 0);
    let mut pairs = 0;
    for _ in 0..6000 {
        let mut feats: Vec<Feat> = ["core", "a", "b"]
            .iter()
            .map(|n| (n.to_string(), 1, 1))
            .collect();
        let mut services: Services = [("core", vec!["core"]), ("s1", vec!["core", "a"])]
            .into_iter()
            .chain([("s2", vec!["core", "b"])])
            .map(|(s, needs)| (s.to_string(), needs.iter().map(|n| n.to_string()).collect()))
            .collect();
        let mut majors = vec![1u32];
        let mut hist = Vec::new();
        let (mut removed, mut major_moved, mut dropped) = (false, false, false);
        for i in 0..6 {
            let r = rnd.next();
            if r < 0.2 {
                let at = rnd.pick(feats.len()).unwrap();
                feats[at].1 += 1;
            } else if r < 0.35 {
                let at = rnd.pick(feats.len()).unwrap();
                feats[at].2 = feats[at].1.min(feats[at].2 + 1);
            } else if r < 0.45 {
                feats.push((format!("f{i}"), 1, 1));
            } else if r < 0.55 && feats.len() > 1 {
                let others: Vec<usize> =
                    (0..feats.len()).filter(|j| feats[*j].0 != "core").collect();
                if let Some(at) = rnd.pick(others.len()) {
                    let (gone, _, _) = feats.remove(others[at]);
                    let before = services.len();
                    services.retain(|(_, needs)| !needs.contains(&gone));
                    dropped |= services.len() != before;
                    removed = true;
                }
            } else if r < 0.65 {
                let s = rnd.pick(services.len());
                let f = rnd.pick(feats.len()).unwrap();
                if let Some(s) = s
                    && !services[s].1.contains(&feats[f].0)
                {
                    services[s].1.push(feats[f].0.clone());
                }
            } else if r < 0.72 {
                let others: Vec<usize> = (0..services.len())
                    .filter(|j| services[*j].0 != "core")
                    .collect();
                if let Some(at) = rnd.pick(others.len()) {
                    let needs = std::mem::take(&mut services[others[at]].1);
                    services[others[at]].1 = needs
                        .into_iter()
                        .enumerate()
                        .filter(|(j, _)| *j == 0 || rnd.next() < 0.5)
                        .map(|(_, n)| n)
                        .collect();
                }
            } else if r < 0.78 {
                let f = rnd.pick(feats.len()).unwrap();
                services.push((
                    format!("n{i}"),
                    vec!["core".to_string(), feats[f].0.clone()],
                ));
            } else if r < 0.84 {
                majors.push(majors.iter().max().unwrap() + 1);
            } else if r < 0.9 && majors.len() > 1 {
                majors.remove(0);
                major_moved = true;
            }
            hist.push(release(format!("r{i}"), &feats, &services, &majors));
        }
        if !window_violations(&hist).is_empty() {
            continue;
        }
        accepted += 1;
        with_removal += usize::from(removed);
        with_major += usize::from(major_moved);
        with_drop += usize::from(dropped);
        for i in 0..hist.len() {
            for j in i + 1..=(hist.len() - 1).min(i + 2) {
                let (x, y) = (&hist[i], &hist[j]);
                for (svc, needs) in &x.services {
                    let Some((_, theirs)) = y.services.iter().find(|(s, _)| s == svc) else {
                        continue;
                    };
                    pairs += 1;
                    assert!(
                        service_use(needs, &x.caps, &y.caps).is_ok(),
                        "{svc} {x:?} {y:?}"
                    );
                    assert!(
                        service_use(theirs, &y.caps, &x.caps).is_ok(),
                        "{svc} {y:?} {x:?}"
                    );
                }
            }
        }
    }
    assert_eq!(
        (accepted, with_removal, with_major, with_drop, pairs),
        (5613, 2526, 208, 2338, 139_755)
    );
}

#[test]
fn an_instance_lists_and_serves_what_its_own_release_speaks() {
    let names = |caps: Caps| {
        caps.features
            .into_iter()
            .map(|f| f.name)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        names(levels::ours("0.8.0", false).unwrap()),
        ["core", "letters", "letters.files", "letters.keys"]
    );
    assert_eq!(
        names(levels::ours("0.8.0", true).unwrap()),
        [
            "core",
            "letters",
            "letters.files",
            "letters.keys",
            "letters.sealed"
        ]
    );
    assert_eq!(names(levels::ours("0.9.0", false).unwrap()).len(), 8);
    assert_eq!(levels::ours("0.7.0", false), None);
    assert_eq!(levels::ours("0.9.1", true), None);
    assert_eq!(
        levels::services("0.8.0"),
        Some(vec![
            Service::Core,
            Service::Letters,
            Service::LetterFiles,
            Service::LetterKeys
        ])
    );
    assert_eq!(levels::services("0.9.0"), Some(Service::ALL.to_vec()));
    assert_eq!(levels::services("1.0.0"), None);
    let old = levels::ours("0.8.0", false).unwrap();
    let new = levels::ours("0.9.0", false).unwrap();
    for service in levels::services("0.8.0").unwrap() {
        assert!(service_use(service.needs(), &old, &new).is_ok());
        assert!(service_use(service.needs(), &new, &old).is_ok());
    }
    assert!(service_use(Service::Invites.needs(), &new, &old).is_err());
}
