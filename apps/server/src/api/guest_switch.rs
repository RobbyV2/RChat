use std::marker::PhantomData;

use crate::api::Settings;

/// Guest text in channels.
pub enum Chat {}
/// Guests in voice channels.
pub enum Voice {}

/// The site's decision that guests may take part in `K`: the guest switch and the switch for
/// `K` are on. Only `Settings` makes one.
pub struct GuestSwitch<K>(PhantomData<fn() -> K>);

impl Settings {
    pub fn guest_chat(&self) -> Option<GuestSwitch<Chat>> {
        (self.guests_enabled && self.guest_chat_enabled).then_some(GuestSwitch(PhantomData))
    }

    pub fn guest_voice(&self) -> Option<GuestSwitch<Voice>> {
        (self.guests_enabled && self.guest_voice_enabled).then_some(GuestSwitch(PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_switch_needs_the_guest_switch_and_its_own() {
        let with = |guests, chat, voice| Settings {
            guests_enabled: guests,
            guest_chat_enabled: chat,
            guest_voice_enabled: voice,
            ..Settings::DENY
        };
        assert!(Settings::DENY.guest_chat().is_none());
        assert!(Settings::DENY.guest_voice().is_none());
        assert!(with(false, true, true).guest_chat().is_none());
        assert!(with(false, true, true).guest_voice().is_none());
        assert!(with(true, true, false).guest_chat().is_some());
        assert!(with(true, true, false).guest_voice().is_none());
        assert!(with(true, false, true).guest_chat().is_none());
        assert!(with(true, false, true).guest_voice().is_some());
    }
}
