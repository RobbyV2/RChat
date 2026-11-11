use std::collections::HashMap;

use crate::health::{Event, Host, step};
use crate::negotiate::Caps;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub rev: u64,
    pub host: Host,
}

pub trait HostStore {
    fn read(&self, host: &str) -> Option<Row>;
    fn cas(&mut self, host: &str, expect: u64, next: &Host) -> bool;
    fn flush_last_seen(&mut self, host: &str, kid: &str, at: i64);
}

#[derive(Clone, Debug, Default)]
pub struct MemoryStore {
    rows: HashMap<String, Row>,
    last_seen: HashMap<(String, String), i64>,
}

impl MemoryStore {
    pub fn put(&mut self, host: &str, row: Row) {
        self.rows.insert(host.to_string(), row);
    }

    pub fn last_seen(&self, host: &str, kid: &str) -> Option<i64> {
        self.last_seen
            .get(&(host.to_string(), kid.to_string()))
            .copied()
    }
}

impl HostStore for MemoryStore {
    fn read(&self, host: &str) -> Option<Row> {
        self.rows.get(host).cloned()
    }

    fn cas(&mut self, host: &str, expect: u64, next: &Host) -> bool {
        match self.rows.get_mut(host) {
            Some(row) if row.rev == expect => {
                *row = Row {
                    rev: expect + 1,
                    host: next.clone(),
                };
                true
            }
            Some(_) | None => false,
        }
    }

    fn flush_last_seen(&mut self, host: &str, kid: &str, at: i64) {
        let seen = self
            .last_seen
            .entry((host.to_string(), kid.to_string()))
            .or_insert(at);
        *seen = (*seen).max(at);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Applied {
    pub writes: u32,
    pub retries: u32,
}

pub const RETRY_MAX: u32 = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyError {
    NoRow,
    Contended,
}

pub fn apply_cas<S: HostStore>(
    store: &mut S,
    host: &str,
    e: &Event,
    now: i64,
    ours: &Caps,
    cached: Option<Row>,
) -> Result<Applied, ApplyError> {
    let mut row = cached.or_else(|| store.read(host));
    let mut retries = 0;
    loop {
        let Row { rev, host: known } = row.ok_or(ApplyError::NoRow)?;
        let next = step(&known, e, now, ours);
        if next == known {
            return Ok(Applied { writes: 0, retries });
        }
        if store.cas(host, rev, &next) {
            return Ok(Applied { writes: 1, retries });
        }
        if retries == RETRY_MAX {
            return Err(ApplyError::Contended);
        }
        retries += 1;
        row = store.read(host);
    }
}
