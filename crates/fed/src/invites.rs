use std::collections::HashMap;

use prost::Message;

use crate::pb::PreviewRequest;
use crate::registry::budget_domain;

pub const HOST_FREE: u32 = 5;
pub const DOMAIN_FREE: u32 = 20;
pub const NETWORK_FREE: u32 = 20;
pub const HOT_HOST_FREE: u32 = 1;
pub const HOT_DOMAIN_FREE: u32 = 4;
pub const HOT_NETWORK_FREE: u32 = 4;
pub const CAP: i64 = 3600;
pub const HOT_CALLERS: usize = 10;

pub fn preview_body(server: &str, link_password: Option<&str>, clicked: bool) -> Vec<u8> {
    let password = match clicked {
        true => link_password.unwrap_or_default(),
        false => "",
    };
    PreviewRequest {
        server: server.to_string(),
        password: password.to_string(),
    }
    .encode_to_vec()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Caller {
    pub host: String,
    pub cold: bool,
    pub network: String,
}

type Key = (String, String);

#[derive(Clone, Copy, Debug)]
struct Tries {
    last: i64,
    fails: u32,
}

#[derive(Clone, Debug)]
struct Backoff {
    table: HashMap<Key, Tries>,
    free: u32,
    hot_free: u32,
}

impl Backoff {
    fn new(free: u32, hot_free: u32) -> Backoff {
        Backoff {
            table: HashMap::new(),
            free,
            hot_free,
        }
    }

    fn wait(&self, fails: u32, hot: bool) -> i64 {
        match (hot, fails < self.hot_free, fails < self.free) {
            (true, true, _) | (false, _, true) => 0,
            (true, false, _) => CAP,
            (false, _, false) => (1i64 << (fails - self.free + 1).min(30)).min(CAP),
        }
    }

    fn reserve(&mut self, key: &Key, hot: bool, now: i64) -> bool {
        let known = self.table.get(key).copied();
        let last = known.map_or(now, |e| e.last);
        let fails = match now - last >= CAP {
            true => 0,
            false => known.map_or(0, |e| e.fails),
        };
        if fails > 0 && now - last < self.wait(fails, hot) {
            return false;
        }
        let tries = Tries {
            last: now,
            fails: fails + 1,
        };
        self.table.insert(key.clone(), tries);
        true
    }

    fn failed(&mut self, key: &Key, now: i64) {
        if let Some(e) = self.table.get_mut(key) {
            e.last = now;
        }
    }

    fn refund(&mut self, key: &Key) {
        if let Some(e) = self.table.get_mut(key) {
            e.fails = e.fails.saturating_sub(1);
        }
    }
}

#[derive(Clone, Debug)]
pub struct WrongPasswords {
    tiers: [Backoff; 3],
    failing: HashMap<String, HashMap<String, i64>>,
}

impl Default for WrongPasswords {
    fn default() -> WrongPasswords {
        WrongPasswords {
            tiers: [
                Backoff::new(HOST_FREE, HOT_HOST_FREE),
                Backoff::new(DOMAIN_FREE, HOT_DOMAIN_FREE),
                Backoff::new(NETWORK_FREE, HOT_NETWORK_FREE),
            ],
            failing: HashMap::new(),
        }
    }
}

fn keys(c: &Caller, server: &str) -> [Key; 3] {
    let Caller {
        host,
        cold,
        network,
    } = c;
    [host.as_str(), budget_domain(host, *cold), network.as_str()]
        .map(|who| (who.to_string(), server.to_string()))
}

impl WrongPasswords {
    fn hot(&mut self, server: &str, now: i64) -> bool {
        self.failing.get_mut(server).is_some_and(|callers| {
            callers.retain(|_, at| *at > now - CAP);
            callers.len() >= HOT_CALLERS
        })
    }

    pub fn attempt(&mut self, c: &Caller, server: &str, now: i64) -> bool {
        let hot = self.hot(server, now);
        let keys = keys(c, server);
        let refused = self
            .tiers
            .iter_mut()
            .zip(&keys)
            .position(|(tier, key)| !tier.reserve(key, hot, now));
        if let Some(refused) = refused {
            for (tier, key) in self.tiers.iter_mut().zip(&keys).take(refused) {
                tier.refund(key);
            }
        }
        refused.is_none()
    }

    pub fn result(&mut self, c: &Caller, server: &str, right: bool, now: i64) {
        for (tier, key) in self.tiers.iter_mut().zip(keys(c, server)) {
            match right {
                true => tier.refund(&key),
                false => tier.failed(&key, now),
            }
        }
        if !right {
            let callers = self.failing.entry(server.to_string()).or_default();
            callers.insert(c.host.clone(), now);
            let oldest = callers.iter().min_by_key(|(_, at)| **at);
            if let (true, Some((host, _))) = (callers.len() > HOT_CALLERS, oldest) {
                let host = host.clone();
                callers.remove(&host);
            }
        }
    }

    pub fn sweep(&mut self, now: i64) {
        for tier in &mut self.tiers {
            tier.table.retain(|_, tries| now - tries.last < CAP);
        }
        self.failing.retain(|_, callers| {
            callers.retain(|_, at| *at > now - CAP);
            !callers.is_empty()
        });
    }

    pub fn tracked(&self) -> usize {
        let tables: usize = self.tiers.iter().map(|tier| tier.table.len()).sum();
        let failing: usize = self.failing.values().map(HashMap::len).sum();
        tables + failing
    }
}
