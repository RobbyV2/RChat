use crate::negotiate::{Caps, Level, Release};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Service {
    Core,
    Letters,
    LetterFiles,
    LetterKeys,
    Invites,
    Profiles,
    Reports,
    Directory,
}

pub const MAJORS: [u32; 1] = [1];
pub const SEALED: &str = "letters.sealed";
pub const RESERVED: [&str; 2] = ["apps", "moves"];

const PACKAGE: &str = "/rchat.fed.v1.";
const SINCE_0_8_0: [Service; 4] = [
    Service::Core,
    Service::Letters,
    Service::LetterFiles,
    Service::LetterKeys,
];
const FEATURES_0_8_0: [&str; 5] = ["core", "letters", "letters.files", "letters.keys", SEALED];
const FEATURES_0_9_0: [&str; 4] = ["invites", "profiles", "reports", "directory"];

impl Service {
    pub const ALL: [Service; 8] = [
        Service::Core,
        Service::Letters,
        Service::LetterFiles,
        Service::LetterKeys,
        Service::Invites,
        Service::Profiles,
        Service::Reports,
        Service::Directory,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Service::Core => "core",
            Service::Letters => "letters",
            Service::LetterFiles => "letter_files",
            Service::LetterKeys => "letter_keys",
            Service::Invites => "invites",
            Service::Profiles => "profiles",
            Service::Reports => "reports",
            Service::Directory => "directory",
        }
    }

    pub fn from_name(name: &str) -> Option<Service> {
        Service::ALL.into_iter().find(|s| s.name() == name)
    }

    pub fn needs(self) -> &'static [&'static str] {
        match self {
            Service::Core => &["core"],
            Service::Letters => &["core", "letters"],
            Service::LetterFiles => &["core", "letters", "letters.files"],
            Service::LetterKeys => &["core", "letters", "letters.keys"],
            Service::Invites => &["core", "invites"],
            Service::Profiles => &["core", "profiles"],
            Service::Reports => &["core", "reports"],
            Service::Directory => &["core", "directory"],
        }
    }

    pub fn of_method(path: &str) -> Option<Service> {
        let (service, method) = path.strip_prefix(PACKAGE)?.split_once('/')?;
        match (service, method) {
            ("InstanceService", "Hello") => Some(Service::Core),
            ("LettersService", "Deliver" | "PutObjects" | "Pull") => Some(Service::Letters),
            ("LettersService", "PullFile") => Some(Service::LetterFiles),
            ("LettersService", "GetKey") => Some(Service::LetterKeys),
            ("InvitesService", "Preview" | "Icon") => Some(Service::Invites),
            ("ProfilesService", "Get" | "Avatar") => Some(Service::Profiles),
            ("ReportsService", "Forward") => Some(Service::Reports),
            ("DirectoryService", "Search") => Some(Service::Directory),
            (_, _) => None,
        }
    }
}

fn release(name: &str, features: &[&str], services: &[Service]) -> Release {
    Release {
        name: name.to_string(),
        caps: Caps {
            majors: MAJORS.to_vec(),
            features: features
                .iter()
                .map(|name| Level {
                    name: name.to_string(),
                    level: 1,
                    min: 1,
                })
                .collect(),
        },
        services: services
            .iter()
            .map(|service| {
                let needs = service.needs().iter().map(|n| n.to_string()).collect();
                (service.name().to_string(), needs)
            })
            .collect(),
    }
}

pub fn releases() -> Vec<Release> {
    vec![
        release("0.8.0", &FEATURES_0_8_0, &SINCE_0_8_0),
        release(
            "0.9.0",
            &[FEATURES_0_8_0.as_slice(), &FEATURES_0_9_0].concat(),
            &Service::ALL,
        ),
    ]
}

fn named(release: &str) -> Option<Release> {
    releases().into_iter().find(|known| known.name == release)
}

pub fn ours(release: &str, sealed: bool) -> Option<Caps> {
    let mut caps = named(release)?.caps;
    caps.features.retain(|f| sealed || f.name != SEALED);
    Some(caps)
}

pub fn services(release: &str) -> Option<Vec<Service>> {
    let Release {
        name: _,
        caps: _,
        services,
    } = named(release)?;
    let known = services
        .iter()
        .filter_map(|(name, _)| Service::from_name(name));
    Some(known.collect())
}

pub fn lists_sealed(caps: &Caps) -> bool {
    caps.feature(SEALED).is_some()
}
