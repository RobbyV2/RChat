use crate::scopes::scope_def;

pub const FIRST_PARTY: &str = "rchat";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceRequest {
    pub client: String,
    pub label: String,
    pub address_hint: String,
    pub group: String,
    pub started_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Approver {
    pub signed_in: bool,
    pub group: String,
    pub typed_code: bool,
    pub step_up: bool,
    pub is_site_admin: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceControl {
    On,
    NotAdmins,
    Off,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerificationUris {
    pub verification_uri: String,
}

pub fn verification_uris(public_url: &str) -> VerificationUris {
    VerificationUris {
        verification_uri: format!("{public_url}/device/"),
    }
}

pub const NOT_BY_DEVICE: [&str; 3] = ["admin", "encrypted.read", "encrypted.send"];

pub fn device_scopes_ok<S: AsRef<str>>(scopes: &[S]) -> bool {
    !scopes.iter().any(|s| NOT_BY_DEVICE.contains(&s.as_ref()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Card {
    pub device: String,
    pub place: String,
    pub started: i64,
    pub other_network: bool,
    pub warning: &'static str,
}

pub fn card(r: &DeviceRequest, a: &Approver, now: i64) -> Card {
    Card {
        device: r.label.clone(),
        place: r.address_hint.clone(),
        started: now.saturating_sub(r.started_at),
        other_network: r.group != a.group,
        warning: "Only continue if you started this on a device you have in front of you.",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    SignIn,
    TypeCode,
    NotFound,
    Confirm,
    Off,
}

impl Refusal {
    pub fn text(self) -> &'static str {
        match self {
            Refusal::SignIn => "Sign in first",
            Refusal::TypeCode => "Type the code shown on the device",
            Refusal::NotFound => "Not found",
            Refusal::Confirm => "Confirm it is you",
            Refusal::Off => "Signing in from another device is off",
        }
    }
}

pub fn may_approve<S: AsRef<str>>(
    r: &DeviceRequest,
    a: &Approver,
    control: DeviceControl,
    scopes: &[S],
) -> Result<(), Refusal> {
    if !a.signed_in {
        return Err(Refusal::SignIn);
    }
    if !a.typed_code {
        return Err(Refusal::TypeCode);
    }
    if r.client != FIRST_PARTY {
        let strong = scopes
            .iter()
            .any(|s| scope_def(s.as_ref()).is_some_and(|d| d.strong));
        return match (device_scopes_ok(scopes), strong && !a.step_up) {
            (false, _) => Err(Refusal::NotFound),
            (true, true) => Err(Refusal::Confirm),
            (true, false) => Ok(()),
        };
    }
    let off = match control {
        DeviceControl::On => false,
        DeviceControl::NotAdmins => a.is_site_admin,
        DeviceControl::Off => true,
    };
    match (off, a.step_up) {
        (true, _) => Err(Refusal::Off),
        (false, false) => Err(Refusal::Confirm),
        (false, true) => Ok(()),
    }
}
