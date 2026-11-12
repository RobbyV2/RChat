use std::collections::HashMap;

pub const CLIENT_FAILS_PER_GROUP_HOUR: u32 = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientAttempt {
    Ok,
    InvalidClient,
    SlowDown,
}

#[derive(Clone, Debug, Default)]
pub struct ClientAuth {
    fails: HashMap<(String, String), u32>,
}

impl ClientAuth {
    pub fn new() -> ClientAuth {
        ClientAuth::default()
    }

    pub fn attempt(&mut self, application: &str, grp: &str, secret_ok: bool) -> ClientAttempt {
        if secret_ok {
            return ClientAttempt::Ok;
        }
        let fails = self
            .fails
            .entry((application.to_string(), grp.to_string()))
            .or_insert(0);
        *fails = fails.saturating_add(1);
        match *fails > CLIENT_FAILS_PER_GROUP_HOUR {
            true => ClientAttempt::SlowDown,
            false => ClientAttempt::InvalidClient,
        }
    }
}

pub const APPLICATION_GROUP_PER_MINUTE: u32 = 120;
pub const APPLICATION_PER_MINUTE: u32 = 6000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Take {
    Ok,
    Rate,
    Capacity,
}

#[derive(Clone, Debug, Default)]
pub struct Budget {
    groups: HashMap<(String, String), u32>,
    applications: HashMap<String, u32>,
}

impl Budget {
    pub fn new() -> Budget {
        Budget::default()
    }

    pub fn take(&mut self, application: &str, grp: &str, carries_live: bool) -> Take {
        let group_key = (application.to_string(), grp.to_string());
        let group = self.groups.get(&group_key).copied().unwrap_or(0);
        let all = self.applications.get(application).copied().unwrap_or(0);
        if group >= APPLICATION_GROUP_PER_MINUTE {
            return Take::Rate;
        }
        if carries_live && all >= APPLICATION_PER_MINUTE {
            return Take::Capacity;
        }
        self.groups.insert(group_key, group + 1);
        if carries_live {
            self.applications.insert(application.to_string(), all + 1);
        }
        Take::Ok
    }
}

pub const APPLICATION_LOOKUP_SHARE: f64 = 0.5;

#[derive(Clone, Debug)]
pub struct Lookups {
    account_per_minute: u32,
    used: HashMap<(String, Option<String>), u32>,
}

impl Lookups {
    pub fn new(account_per_minute: u32) -> Lookups {
        Lookups {
            account_per_minute,
            used: HashMap::new(),
        }
    }

    pub fn take(&mut self, person: &str, application: Option<&str>) -> Take {
        let cap = match application {
            Some(_) => (f64::from(self.account_per_minute) * APPLICATION_LOOKUP_SHARE) as u32,
            None => self.account_per_minute,
        };
        let used = self
            .used
            .entry((person.to_string(), application.map(str::to_string)))
            .or_insert(0);
        if *used >= cap {
            return Take::Rate;
        }
        *used += 1;
        Take::Ok
    }
}

pub const DEVICE_PER_CLIENT_GROUP: u32 = 10;
pub const DEVICE_PER_CLIENT: u32 = 1000;
pub const DEVICE_TOTAL: u32 = 50_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiveDeviceCodes {
    pub client_group: u32,
    pub client: u32,
    pub total: u32,
}

pub fn device_code_allowed(live: LiveDeviceCodes) -> Take {
    let LiveDeviceCodes {
        client_group,
        client,
        total,
    } = live;
    if client_group >= DEVICE_PER_CLIENT_GROUP {
        return Take::Rate;
    }
    match client >= DEVICE_PER_CLIENT || total >= DEVICE_TOTAL {
        true => Take::Capacity,
        false => Take::Ok,
    }
}

pub const PER_USER_GROUP_DAY: u32 = 200;
pub const PER_USER_DAY: u32 = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PasswordCounts {
    pub user_group: u32,
    pub user: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PasswordAttempt {
    Ok,
    Locked,
}

pub fn password_attempt(counts: PasswordCounts, device_ok: bool) -> PasswordAttempt {
    let locked =
        counts.user_group >= PER_USER_GROUP_DAY || (counts.user >= PER_USER_DAY && !device_ok);
    match locked {
        true => PasswordAttempt::Locked,
        false => PasswordAttempt::Ok,
    }
}
