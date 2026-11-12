//! The preset gallery: ready automations the builder fills in. Nothing runs until saved.

use crate::model::Automation;
use serde::Deserialize;
use std::sync::LazyLock;

/// A ready setup of one or more automations. Channel and role ids are 0 until the builder fills
/// them in, and every automation is off until it is saved.
#[derive(Clone, PartialEq, Debug, Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub summary: String,
    /// The builder offers "Only the server creator can change this".
    #[serde(default)]
    pub offer_locked: bool,
    /// The gallery lists it only where its feature is on.
    #[serde(default)]
    pub gated: bool,
    /// The permissions it needs, by the names the role editor shows.
    pub needs: Vec<String>,
    pub automations: Vec<Automation>,
}

/// The preset files, in gallery order.
pub static FILES: [(&str, &str); 29] = [
    ("honeypot", include_str!("../presets/honeypot.json")),
    ("welcome", include_str!("../presets/welcome.json")),
    ("leave", include_str!("../presets/leave.json")),
    ("auto_role", include_str!("../presets/auto_role.json")),
    ("spam_filter", include_str!("../presets/spam_filter.json")),
    ("mention_spam", include_str!("../presets/mention_spam.json")),
    ("link_filter", include_str!("../presets/link_filter.json")),
    (
        "invite_filter",
        include_str!("../presets/invite_filter.json"),
    ),
    ("word_filter", include_str!("../presets/word_filter.json")),
    (
        "new_account_gate",
        include_str!("../presets/new_account_gate.json"),
    ),
    ("name_filter", include_str!("../presets/name_filter.json")),
    (
        "raid_protection",
        include_str!("../presets/raid_protection.json"),
    ),
    ("staff_safety", include_str!("../presets/staff_safety.json")),
    ("logs", include_str!("../presets/logs.json")),
    (
        "scheduled_message",
        include_str!("../presets/scheduled_message.json"),
    ),
    ("suggestions", include_str!("../presets/suggestions.json")),
    ("auto_thread", include_str!("../presets/auto_thread.json")),
    (
        "channel_cleanup",
        include_str!("../presets/channel_cleanup.json"),
    ),
    ("levels", include_str!("../presets/levels.json")),
    ("member_count", include_str!("../presets/member_count.json")),
    ("strikes", include_str!("../presets/strikes.json")),
    ("self_roles", include_str!("../presets/self_roles.json")),
    ("thanks", include_str!("../presets/thanks.json")),
    ("role_panel", include_str!("../presets/role_panel.json")),
    ("tickets", include_str!("../presets/tickets.json")),
    ("rooms", include_str!("../presets/rooms.json")),
    ("starboard", include_str!("../presets/starboard.json")),
    ("sticky", include_str!("../presets/sticky.json")),
    ("giveaway", include_str!("../presets/giveaway.json")),
];

static GALLERY: LazyLock<Vec<Preset>> = LazyLock::new(|| {
    FILES
        .iter()
        .map(|(id, json)| {
            serde_json::from_str(json).unwrap_or_else(|e| panic!("presets/{id}.json: {e}"))
        })
        .collect()
});

pub fn gallery() -> &'static [Preset] {
    &GALLERY
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::{Actor, Fired, Reach, grant_of, may_run};
    use crate::grants::ALL_PERMS;
    use crate::validate::{Caps, Needs, validate};

    #[test]
    fn the_gallery_has_every_preset_once() {
        let ids: Vec<&str> = gallery().iter().map(|p| p.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "honeypot",
                "welcome",
                "leave",
                "auto_role",
                "spam_filter",
                "mention_spam",
                "link_filter",
                "invite_filter",
                "word_filter",
                "new_account_gate",
                "name_filter",
                "raid_protection",
                "staff_safety",
                "logs",
                "scheduled_message",
                "suggestions",
                "auto_thread",
                "channel_cleanup",
                "levels",
                "member_count",
                "strikes",
                "self_roles",
                "thanks",
                "role_panel",
                "tickets",
                "rooms",
                "starboard",
                "sticky",
                "giveaway",
            ]
        );
        assert_eq!(FILES.len(), ids.len());
        let gated: Vec<&str> = gallery()
            .iter()
            .filter(|p| p.gated)
            .map(|p| p.id.as_str())
            .collect();
        assert_eq!(
            gated,
            ["staff_safety", "rooms", "starboard", "sticky", "giveaway"]
        );
    }

    #[test]
    fn every_preset_is_valid_and_lists_what_it_needs() {
        let caps = Caps::default();
        for p in gallery() {
            assert!(!p.name.is_empty() && p.name.len() <= 50, "{}", p.id);
            assert!(!p.summary.is_empty() && p.summary.len() <= 100, "{}", p.id);
            assert!(p.name.is_ascii() && p.summary.is_ascii(), "{}", p.id);
            assert!(
                !p.name.contains('\u{2014}') && !p.summary.contains("RChat"),
                "{}",
                p.id
            );
            assert!(!p.automations.is_empty(), "{}", p.id);
            let mut needs = Needs(0);
            for a in &p.automations {
                let compiled =
                    validate(a, &caps).unwrap_or_else(|problems| panic!("{}: {problems:?}", p.id));
                needs = needs.with(compiled.needs);
                assert!(
                    !a.enabled,
                    "{}: a preset is saved by the builder, never running",
                    p.id
                );
            }
            assert_eq!(p.needs, needs.names(), "{}", p.id);
        }
    }

    #[test]
    fn every_preset_a_member_sets_off_runs_for_a_member_without_rights_on_their_own_act() {
        let mut checked = 0;
        for p in gallery() {
            for a in &p.automations {
                let c = validate(a, &Caps::default()).expect("valid");
                if c.fired == Fired::Owner {
                    continue;
                }
                let member = Actor {
                    id: 1,
                    acting: 0,
                    rank: 0,
                };
                for (i, (reach, needs)) in c.reach.iter().zip(&c.action_needs).enumerate() {
                    let (reach, target) = match reach {
                        Reach::Grant => (grant_of(0, false, ALL_PERMS), Some((1, 0))),
                        Reach::Member
                        | Reach::Message
                        | Reach::Pin
                        | Reach::Revoke
                        | Reach::SelfRevoke
                        | Reach::SelfGrant => (*reach, Some((1, 0))),
                        Reach::Place | Reach::Own => (*reach, None),
                    };
                    let ok = may_run(
                        reach,
                        needs.bits(),
                        ALL_PERMS,
                        Some(member),
                        target,
                        c.picks[i],
                    );
                    assert!(ok, "{} actions.{i}", p.id);
                    checked += 1;
                }
            }
        }
        assert_eq!(checked, 37);
    }

    #[test]
    fn the_protective_presets_are_offered_locked() {
        let locked: Vec<&str> = gallery()
            .iter()
            .filter(|p| p.offer_locked)
            .map(|p| p.id.as_str())
            .collect();
        assert_eq!(locked, ["honeypot", "raid_protection", "staff_safety"]);
    }

    #[test]
    fn the_presets_set_up_what_the_catalog_says() {
        let get = |id: &str| -> &'static Preset {
            gallery().iter().find(|p| p.id == id).expect("preset")
        };
        let names = |id: &str| -> Vec<Vec<&'static str>> {
            get(id)
                .automations
                .iter()
                .map(|a| {
                    std::iter::once(a.trigger.name())
                        .chain(a.actions.iter().map(|x| x.kind.name()))
                        .collect()
                })
                .collect()
        };
        assert_eq!(
            names("honeypot"),
            [["message_sent", "block", "ban", "alert"]]
        );
        assert!(get("honeypot").automations[0].trigger.is_guard());
        assert_eq!(names("welcome"), [["member_admitted", "send_message"]]);
        assert_eq!(names("leave"), [["member_left", "send_message"]]);
        assert_eq!(names("auto_role"), [["member_admitted", "add_role"]]);
        assert_eq!(
            names("spam_filter"),
            [["message_sent", "block", "timeout", "counter_add"]]
        );
        assert_eq!(
            names("mention_spam"),
            [["message_sent", "block", "timeout"]]
        );
        assert_eq!(names("link_filter"), [["message_sent", "block"]]);
        assert_eq!(names("invite_filter"), [["message_sent", "block"]]);
        assert_eq!(names("word_filter"), [["message_sent", "block"]]);
        assert_eq!(names("new_account_gate"), [["member_joined", "hold"]]);
        assert!(!get("new_account_gate").automations[0].trigger.is_guard());
        assert_eq!(
            names("name_filter"),
            [
                vec!["member_joined", "hold", "alert"],
                vec!["profile_updated", "hold", "alert"]
            ]
        );
        assert_eq!(
            names("raid_protection"),
            [["join_rate", "pause_joins", "require_approval", "alert"]]
        );
        assert_eq!(
            names("staff_safety"),
            [["staff_action_rate", "quarantine", "alert"]]
        );
        assert_eq!(
            names("logs").iter().map(|n| n[0]).collect::<Vec<&str>>(),
            [
                "audit_entry",
                "member_joined",
                "member_left",
                "message_deleted",
                "message_edited",
                "report_filed"
            ]
        );
        assert!(names("logs").iter().all(|n| n[1..] == ["log"]));
        assert_eq!(names("scheduled_message"), [["schedule", "send_message"]]);
        assert_eq!(
            names("suggestions"),
            [["message_sent", "react", "start_thread"]]
        );
        assert_eq!(names("auto_thread"), [["message_sent", "start_thread"]]);
        assert_eq!(names("channel_cleanup"), [["schedule", "delete_older"]]);
        assert_eq!(
            names("levels"),
            [
                vec!["message_sent", "counter_add"],
                vec!["counter_reached", "send_message"]
            ]
        );
        assert_eq!(names("member_count"), [["schedule", "rename_channel"]]);
        assert_eq!(names("strikes"), [["counter_reached", "timeout"]]);
        assert_eq!(names("self_roles"), [["command", "toggle_role"]]);
        assert_eq!(names("thanks"), [["command", "counter_add", "notify"]]);
        assert_eq!(names("role_panel"), [["component", "post_panel"]]);
        assert_eq!(names("tickets"), [["component", "open_ticket"]]);
        assert_eq!(names("rooms"), [["voice_joined", "create_room"]]);
        assert_eq!(names("starboard"), [["reaction_added", "repost"]]);
        assert_eq!(names("sticky"), [["message_sent", "sticky"]]);
        assert_eq!(names("giveaway"), [["component", "post_giveaway"]]);
    }
}
