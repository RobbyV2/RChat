use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Level {
    pub name: String,
    pub level: u32,
    pub min: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Caps {
    pub majors: Vec<u32>,
    pub features: Vec<Level>,
}

impl Caps {
    pub fn feature(&self, name: &str) -> Option<&Level> {
        self.features.iter().find(|f| f.name == name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gap {
    Major,
    Missing,
    TheirsOld,
    OursOld,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeatureUse {
    Use(u32),
    Gap(Gap),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoUse {
    pub feature: String,
    pub gap: Gap,
}

pub fn common_major(a: &[u32], b: &[u32]) -> Option<u32> {
    a.iter().filter(|m| b.contains(m)).max().copied()
}

pub fn feature_use(ours: &Level, theirs: Option<&Level>) -> FeatureUse {
    match theirs {
        None => FeatureUse::Gap(Gap::Missing),
        Some(theirs) if theirs.level < ours.min => FeatureUse::Gap(Gap::TheirsOld),
        Some(theirs) if ours.level < theirs.min => FeatureUse::Gap(Gap::OursOld),
        Some(theirs) => FeatureUse::Use(ours.level.min(theirs.level)),
    }
}

pub fn service_use<S: AsRef<str>>(
    needs: &[S],
    ours: &Caps,
    theirs: &Caps,
) -> Result<BTreeMap<String, u32>, NoUse> {
    let no = |feature: &str, gap| NoUse {
        feature: feature.to_string(),
        gap,
    };
    if common_major(&ours.majors, &theirs.majors).is_none() {
        return Err(no("core", Gap::Major));
    }
    needs
        .iter()
        .map(|name| {
            let name = name.as_ref();
            let mine = ours.feature(name).ok_or_else(|| no(name, Gap::Missing))?;
            match feature_use(mine, theirs.feature(name)) {
                FeatureUse::Use(level) => Ok((name.to_string(), level)),
                FeatureUse::Gap(gap) => Err(no(name, gap)),
            }
        })
        .collect()
}

pub const WINDOW: usize = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub name: String,
    pub caps: Caps,
    pub services: Vec<(String, Vec<String>)>,
}

impl Release {
    fn needs(&self, service: &str) -> Option<&[String]> {
        self.services
            .iter()
            .find(|(name, _)| name == service)
            .map(|(_, needs)| needs.as_slice())
    }
}

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

fn minor_release(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    match parts.as_slice() {
        [major, minor, "0"] => digits(major) && digits(minor),
        [short] => short.strip_prefix('r').is_some_and(digits),
        _ => false,
    }
}

pub fn window_violations(all: &[Release]) -> Vec<String> {
    let mut out = Vec::new();
    let first = all
        .iter()
        .position(|r| !r.caps.majors.is_empty())
        .unwrap_or(0);
    let releases = &all[first..];
    for (i, r) in releases.iter().enumerate() {
        if !minor_release(&r.name) {
            out.push(format!("{}: not a minor release", r.name));
        }
        let window = &releases[i.saturating_sub(WINDOW)..i];
        let prev = i.checked_sub(1).map(|at| &releases[at]);
        for f in &r.caps.features {
            if f.min > f.level {
                out.push(format!("{} {}: min above level", r.name, f.name));
            }
            let Some(p) = prev.and_then(|prev| prev.caps.feature(&f.name)) else {
                continue;
            };
            if f.level < p.level {
                out.push(format!("{} {}: level went down", r.name, f.name));
            }
            if f.min < p.min {
                out.push(format!("{} {}: floor went down", r.name, f.name));
            }
            let spoken = |w: &Release| w.caps.feature(&f.name).map_or(0, |known| known.level);
            if f.min > p.min && window.iter().any(|w| spoken(w) < f.min) {
                out.push(format!(
                    "{} {}: floor {} raised too early",
                    r.name, f.name, f.min
                ));
            }
        }
        let Some(prev) = prev else {
            continue;
        };
        for p in &prev.caps.features {
            let required = |w: &Release| {
                w.services
                    .iter()
                    .any(|(svc, needs)| needs.contains(&p.name) && r.needs(svc).is_some())
            };
            if r.caps.feature(&p.name).is_none() && window.iter().any(required) {
                out.push(format!(
                    "{} {}: removed while required within the window",
                    r.name, p.name
                ));
            }
        }
        for (svc, needs) in &r.services {
            if prev.needs(svc).is_none() {
                continue;
            }
            for n in needs {
                if r.caps.feature(n).is_none() || window.iter().any(|w| w.caps.feature(n).is_none())
                {
                    out.push(format!("{} {}: requires {} too early", r.name, svc, n));
                }
            }
        }
        for (svc, needs) in &prev.services {
            if r.needs(svc).is_none() && !needs.iter().any(|n| r.caps.feature(n).is_none()) {
                out.push(format!(
                    "{} {}: dropped while its features stay",
                    r.name, svc
                ));
            }
        }
        for w in window {
            if common_major(&w.caps.majors, &r.caps.majors).is_none() {
                out.push(format!("{}: no major in common with {}", r.name, w.name));
            }
        }
    }
    out
}
