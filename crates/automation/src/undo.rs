//! Undo markers: an undo runs only while its own marker is there, and a person's action on the
//! same object removes the marker.

use std::collections::HashMap;

pub fn ban_key(server: &str, user: &str) -> String {
    format!("ban:{server}:{user}")
}

pub fn lock_key(channel: i64) -> String {
    format!("lock:{channel}")
}

pub fn slow_key(channel: i64) -> String {
    format!("slow:{channel}")
}

pub fn role_key(server: &str, user: &str, role: i64) -> String {
    format!("role:{server}:{user}:{role}")
}

pub fn room_key(channel: i64) -> String {
    format!("room:{channel}")
}

pub fn ticket_key(channel: i64) -> String {
    format!("ticket:{channel}")
}

/// The markers of `automation_marks`, in memory: key to the undo job that owns the object.
#[derive(Default, Debug)]
pub struct Marks {
    marks: HashMap<String, i64>,
}

impl Marks {
    /// An automation's undoable action records its undo job.
    pub fn set(&mut self, key: &str, job: i64) {
        self.marks.insert(key.to_string(), job);
    }

    /// A person acts on the same object: the automation no longer owns it.
    pub fn human(&mut self, key: &str) {
        self.marks.remove(key);
    }

    /// Whether the undo job may run: only while the marker is still its own, which it then
    /// removes. The automation's status and its owner are not consulted.
    pub fn undo(&mut self, key: &str, job: i64) -> bool {
        match self.marks.get(key) {
            Some(&owner) if owner == job => {
                self.marks.remove(key);
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_softbans_unban_skips_a_moderators_real_ban_made_in_between() {
        let mut m = Marks::default();
        let key = ban_key("pixel", "raider");
        assert_eq!(key, "ban:pixel:raider");
        m.set(&key, 41);
        m.human(&key);
        assert!(!m.undo(&key, 41));
    }

    #[test]
    fn an_unlock_after_a_manual_lock_is_skipped_and_an_untouched_one_runs_once() {
        let mut m = Marks::default();
        assert_eq!(lock_key(12), "lock:12");
        m.set(&lock_key(12), 7);
        m.human(&lock_key(12));
        assert!(!m.undo(&lock_key(12), 7));
        m.set(&lock_key(13), 8);
        assert!(m.undo(&lock_key(13), 8));
        assert!(!m.undo(&lock_key(13), 8));
    }

    #[test]
    fn a_temp_role_a_moderator_then_gave_for_good_stays() {
        let mut m = Marks::default();
        let key = role_key("pixel", "bob", 5);
        assert_eq!(key, "role:pixel:bob:5");
        m.set(&key, 9);
        m.human(&key);
        assert!(!m.undo(&key, 9));
    }

    #[test]
    fn a_newer_automation_action_replaces_the_marker() {
        let mut m = Marks::default();
        assert_eq!(slow_key(12), "slow:12");
        m.set(&slow_key(12), 1);
        m.set(&slow_key(12), 2);
        assert!(!m.undo(&slow_key(12), 1));
        assert!(m.undo(&slow_key(12), 2));
    }

    #[test]
    fn room_and_ticket_keys() {
        assert_eq!(room_key(4), "room:4");
        assert_eq!(ticket_key(9), "ticket:9");
    }
}
