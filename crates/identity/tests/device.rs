use rchat_identity::device::{
    Approver, Card, DeviceControl, DeviceRequest, FIRST_PARTY, NOT_BY_DEVICE, Refusal, card,
    device_scopes_ok, may_approve, verification_uris,
};

fn request(client: &str) -> DeviceRequest {
    DeviceRequest {
        client: client.to_string(),
        label: "rchat-cli on build-01".to_string(),
        address_hint: "198.51.x.x".to_string(),
        group: "g2".to_string(),
        started_at: 100,
    }
}

fn approver() -> Approver {
    Approver {
        signed_in: true,
        group: "g1".to_string(),
        typed_code: true,
        step_up: true,
        is_site_admin: false,
    }
}

const NONE: &[&str] = &[];

#[test]
fn no_link_or_qr_for_any_client() {
    let uris = verification_uris("https://chat.example.com");
    assert_eq!(uris.verification_uri, "https://chat.example.com/device/");
    assert_eq!(
        format!("{uris:?}"),
        r#"VerificationUris { verification_uri: "https://chat.example.com/device/" }"#
    );
}

#[test]
fn a_registered_applications_device_grant_needs_the_typed_code_and_step_up_for_the_strongest() {
    let app = request("application_x");
    let no_step_up = Approver {
        step_up: false,
        ..approver()
    };
    let untyped = Approver {
        typed_code: false,
        ..approver()
    };
    assert_eq!(
        may_approve(&app, &untyped, DeviceControl::On, &["openid"]),
        Err(Refusal::TypeCode)
    );
    assert_eq!(
        may_approve(
            &app,
            &no_step_up,
            DeviceControl::On,
            &["openid", "profile", "messages.read"]
        ),
        Ok(())
    );
    assert_eq!(
        may_approve(
            &app,
            &no_step_up,
            DeviceControl::On,
            &["openid", "dms.read"]
        ),
        Err(Refusal::Confirm)
    );
    assert_eq!(
        may_approve(
            &app,
            &approver(),
            DeviceControl::On,
            &["openid", "dms.read"]
        ),
        Ok(())
    );
    assert_eq!(
        may_approve(&app, &approver(), DeviceControl::On, &["openid", "admin"]),
        Err(Refusal::NotFound)
    );
    assert_eq!(
        may_approve(&app, &approver(), DeviceControl::Off, &["openid"]),
        Ok(())
    );
    assert!(!device_scopes_ok(&["openid", "encrypted.read"]));
    assert!(!device_scopes_ok(&["encrypted.send"]));
    assert!(device_scopes_ok(&["openid", "messages.send"]));
    assert!(device_scopes_ok(NONE));
    assert_eq!(NOT_BY_DEVICE, ["admin", "encrypted.read", "encrypted.send"]);
}

#[test]
fn the_card_shows_device_place_time_and_a_different_network() {
    assert_eq!(
        card(&request(FIRST_PARTY), &approver(), 130),
        Card {
            device: "rchat-cli on build-01".to_string(),
            place: "198.51.x.x".to_string(),
            started: 30,
            other_network: true,
            warning: "Only continue if you started this on a device you have in front of you.",
        }
    );
    let same = Approver {
        group: "g2".to_string(),
        ..approver()
    };
    assert!(!card(&request(FIRST_PARTY), &same, 130).other_network);
    assert_eq!(
        card(&request(FIRST_PARTY), &same, i64::MIN).started,
        i64::MIN
    );
}

#[test]
fn approval_needs_a_signed_in_session_the_typed_code_and_step_up() {
    let r = request(FIRST_PARTY);
    assert_eq!(FIRST_PARTY, "rchat");
    assert_eq!(
        may_approve(&r, &approver(), DeviceControl::On, NONE),
        Ok(())
    );
    let untyped = Approver {
        typed_code: false,
        ..approver()
    };
    assert_eq!(
        may_approve(&r, &untyped, DeviceControl::On, NONE),
        Err(Refusal::TypeCode)
    );
    let no_step_up = Approver {
        step_up: false,
        ..approver()
    };
    assert_eq!(
        may_approve(&r, &no_step_up, DeviceControl::On, NONE),
        Err(Refusal::Confirm)
    );
    let signed_out = Approver {
        signed_in: false,
        ..approver()
    };
    assert_eq!(
        may_approve(&r, &signed_out, DeviceControl::On, NONE),
        Err(Refusal::SignIn)
    );
    let admin = Approver {
        is_site_admin: true,
        ..approver()
    };
    assert_eq!(
        may_approve(&r, &admin, DeviceControl::NotAdmins, NONE),
        Err(Refusal::Off)
    );
    assert_eq!(
        may_approve(&r, &approver(), DeviceControl::NotAdmins, NONE),
        Ok(())
    );
    assert_eq!(
        may_approve(&r, &approver(), DeviceControl::Off, NONE),
        Err(Refusal::Off)
    );
    assert_eq!(
        [
            Refusal::SignIn,
            Refusal::TypeCode,
            Refusal::NotFound,
            Refusal::Confirm,
            Refusal::Off
        ]
        .map(Refusal::text),
        [
            "Sign in first",
            "Type the code shown on the device",
            "Not found",
            "Confirm it is you",
            "Signing in from another device is off"
        ]
    );
}
