use std::collections::HashMap;

use crate::limits::{key_fetch, lookup_new_hosts};

#[derive(Clone, Debug, Default)]
struct Window {
    hits: Vec<i64>,
}

impl Window {
    fn count(&mut self, now: i64, span: i64) -> usize {
        self.hits.retain(|t| *t > now - span);
        self.hits.len()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fetch {
    Ok,
    Busy,
    StampNeeded,
}

#[derive(Clone, Debug, Default)]
pub struct KeyFetchGuard {
    global: Window,
    nets: HashMap<String, Window>,
    capped_at: HashMap<String, i64>,
    last_hello: HashMap<String, i64>,
}

impl KeyFetchGuard {
    pub fn may_fetch(
        &mut self,
        network: &str,
        iss: &str,
        hello: bool,
        stamped: bool,
        known: bool,
        now: i64,
    ) -> Fetch {
        if hello
            && self
                .last_hello
                .get(iss)
                .is_some_and(|last| now - last < key_fetch::HELLO_REFETCH)
        {
            return Fetch::Busy;
        }
        if known {
            if hello {
                self.last_hello.insert(iss.to_string(), now);
            }
            return Fetch::Ok;
        }
        let net = self.nets.entry(network.to_string()).or_default();
        let capped = self
            .capped_at
            .get(network)
            .is_some_and(|at| now - at < key_fetch::CAPPED_FOR);
        let share = match capped {
            true => key_fetch::CAPPED_NETWORK_MINUTE,
            false => key_fetch::PER_NETWORK_MINUTE,
        };
        if !stamped && net.count(now, 60) >= share {
            if !capped {
                self.capped_at.insert(network.to_string(), now);
            }
            return Fetch::Busy;
        }
        let used = self.global.count(now, 60);
        if used >= key_fetch::PER_MINUTE {
            return Fetch::Busy;
        }
        if used >= key_fetch::PRESSURE_AT && !stamped {
            return Fetch::StampNeeded;
        }
        self.global.hits.push(now);
        net.hits.push(now);
        if net.count(now, 60) >= key_fetch::PER_NETWORK_MINUTE {
            self.capped_at.insert(network.to_string(), now);
        }
        if hello {
            self.last_hello.insert(iss.to_string(), now);
        }
        Fetch::Ok
    }
}

impl KeyFetchGuard {
    pub fn sweep(&mut self, now: i64) {
        self.global.count(now, 60);
        self.nets.retain(|_, net| net.count(now, 60) > 0);
        self.capped_at
            .retain(|_, at| now - *at < key_fetch::CAPPED_FOR);
        self.last_hello
            .retain(|_, at| now - *at < key_fetch::HELLO_REFETCH);
    }

    pub fn tracked(&self) -> usize {
        self.nets.len() + self.capped_at.len() + self.last_hello.len()
    }
}

#[derive(Clone, Debug, Default)]
pub struct LookupGuard {
    global: Window,
    per_account: HashMap<String, Window>,
}

impl LookupGuard {
    pub fn may_contact(&mut self, _host: &str, account: &str, contacted: bool, now: i64) -> bool {
        if contacted {
            return true;
        }
        let mine = self.per_account.entry(account.to_string()).or_default();
        if self.global.count(now, 60) >= lookup_new_hosts::PER_MINUTE
            || mine.count(now, 3600) >= lookup_new_hosts::PER_ACCOUNT_HOUR
        {
            return false;
        }
        self.global.hits.push(now);
        mine.hits.push(now);
        true
    }
}

impl LookupGuard {
    pub fn sweep(&mut self, now: i64) {
        self.global.count(now, 60);
        self.per_account.retain(|_, mine| mine.count(now, 3600) > 0);
    }

    pub fn tracked(&self) -> usize {
        self.per_account.len()
    }
}
