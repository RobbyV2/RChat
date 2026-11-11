pub mod call {
    pub const LIFE_MAX: i64 = 60;
    pub const SKEW: i64 = 30;
    pub const HEAD_MAX: usize = 2048;
    pub const JTI_BYTES: usize = 16;
    pub const JTI_KEEP: i64 = 30 + 300;
}

pub mod key_fetch {
    pub const PER_MINUTE: usize = 600;
    pub const PER_NETWORK_MINUTE: usize = 5;
    pub const CAPPED_NETWORK_MINUTE: usize = 1;
    pub const CAPPED_FOR: i64 = 600;
    pub const PRESSURE_AT: usize = 60;
    pub const HELLO_REFETCH: i64 = 30;
}

pub mod lookup_new_hosts {
    pub const PER_MINUTE: usize = 300;
    pub const PER_ACCOUNT_HOUR: usize = 10;
}

pub mod keys {
    pub const RETIRE_AFTER: i64 = 3600;
    pub const PENDING_MAX: usize = 8;
    pub const JWKS_MAX: usize = 64;
    pub const REMEMBERED_MAX: usize = 64;
}

pub mod circuit {
    pub const FAILS: u32 = 5;
    pub const PROBES: [i64; 4] = [60, 300, 900, 3600];
    pub const UNREACHABLE_AFTER: i64 = 24 * 3600;
}

pub mod hello {
    pub const TTL: i64 = 3600;
    pub const RECHECK: i64 = 6 * 3600;
    pub const RECHECK_UNSUPPORTED: i64 = 24 * 3600;
    pub const SKEW_NOTICE: i64 = 30;
    pub const BACKGROUND_EVERY: i64 = 300;
    pub const MAJORS_MAX: usize = 8;
    pub const FEATURES_MAX: usize = 64;
    pub const CALL_KIDS_MAX: usize = 16;
    pub const ENDORSEMENTS_MAX: usize = 16;
    pub const BUDGETS_MAX: usize = 32;
    pub const POLICY_MAX: usize = 64;
    pub const TEXT_MAX: usize = 64;
    pub const ORIGIN_MAX: usize = 8 + 253;
    pub const SIG_BYTES: usize = 64;
}

pub mod strikes {
    pub const WINDOW: i64 = 3600;
    pub const PAUSE_AT: u32 = 10;
    pub const WEIGHT_MALFORMED: u32 = 1;
    pub const WEIGHT_BAD_REPLY: u32 = 1;
    pub const WEIGHT_BAD_OWN_SEAL: u32 = 5;
    pub const WEIGHT_BAD_OBJECT: u32 = 5;
    pub const COOLDOWN: i64 = 3600;
    pub const COOLDOWN_MAX: i64 = 24 * 3600;
    pub const PROBATION: i64 = 24 * 3600;
    pub const HALT_AT: usize = 2;
}

pub mod abuse {
    pub const WINDOW: i64 = 3600;
    pub const MINUTES: usize = 30;
    pub const COOLDOWN: i64 = 6 * 3600;
    pub const COOLDOWN_MAX: i64 = 48 * 3600;
    pub const GRACE: i64 = 10;
    pub const CALLS_PER_MINUTE: u32 = 4;
}

pub mod stamp {
    pub const PUZZLES: usize = 16;
    pub const WORK: u64 = 2_000_000;
    pub const SEEN_FOR: i64 = 90;
}

pub mod established {
    pub const WRITERS: usize = 2;
    pub const AFTER_DAYS: i64 = 7;
    pub const DECAY_DAYS: i64 = 30;
    pub const COOLING_DAYS: i64 = 7;
}

pub const HOLD_MAX: i64 = 3600;
pub const NOTICE_MAX: usize = 200;
pub const BLOB_MAX: usize = 256 * 1024;

pub mod ranges {
    pub const NAME_MAX: usize = 64;
    pub const USERNAMES_MAX: usize = 50;
    pub const QUERY_MAX: usize = 100;
    pub const REPORT_IDS_MAX: usize = 20;
    pub const NOTE_MAX: usize = 1000;
    pub const REF_BYTES: usize = 16;
    pub const SHA256_BYTES: usize = 32;
}
