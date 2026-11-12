use super::*;
use crate::api::access::user_scope;
use crate::api::{Member, UserRef};
use crate::ws::access::Access;

#[test]
fn routing_fields_stay_off_the_client_wire() {
    let availability = WsEvent::P2pAvailability {
        hoster: "alice".to_string(),
        peer_id: Some("peer".to_string()),
        ids: vec!["f1".to_string()],
        online: true,
        scope_servers: vec!["rchat".to_string()],
        scope_users: vec!["bob".to_string()],
    };
    assert_eq!(
        serde_json::to_string(&availability).unwrap(),
        r#"{"type":"p2p_availability","hoster":"alice","peer_id":"peer","ids":["f1"],"online":true}"#
    );
    let wire = to_bus_json(&availability).unwrap();
    assert!(
        wire.contains(r#""scope_servers":["rchat"]"#) && wire.contains(r#""scope_users":["bob"]"#)
    );
    let back: WsEvent = serde_json::from_str(&wire).unwrap();
    assert_eq!(to_bus_json(&back).unwrap(), wire);
    assert_eq!(
        serde_json::to_string(&back).unwrap(),
        serde_json::to_string(&availability).unwrap()
    );
    let updated = WsEvent::MessageUpdated {
        server: None,
        channel_id: None,
        update: Updated::full(message()),
        dm_users: vec!["alice".to_string(), "bob".to_string()],
    };
    let client = serde_json::to_string(&updated).unwrap();
    assert!(!client.contains("dm_users"));
    let back: WsEvent = serde_json::from_str(&to_bus_json(&updated).unwrap()).unwrap();
    assert!(
        matches!(&back, WsEvent::MessageUpdated { server: None, channel_id: None, update: Updated::Full { message: _ }, dm_users } if dm_users.len() == 2)
    );
    assert_eq!(serde_json::to_string(&back).unwrap(), client);
    let member = WsEvent::MemberJoined {
        server: "rchat".to_string(),
        member: Member {
            user: message().author,
            is_admin: false,
            is_creator: false,
            online: true,
            perms: 0,
            role_ids: vec![3],
            joined_via: None,
            timeout: None,
        },
    };
    let back: WsEvent = serde_json::from_str(&to_bus_json(&member).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_string(&back).unwrap(),
        serde_json::to_string(&member).unwrap()
    );
}

#[test]
fn a_user_update_without_scope_reaches_only_its_user() {
    let ev = WsEvent::UserUpdated {
        user: UserRef {
            username: s("dave"),
            ..message().author
        },
        scope: UserScope {
            servers: vec![s("rchat")],
            views: Vec::new(),
            users: vec![s("dave")],
        },
    };
    let bare: WsEvent = serde_json::from_str(&serde_json::to_string(&ev).unwrap()).unwrap();
    assert!(matches!(&bare, WsEvent::UserUpdated { user: _, scope } if scope.is_empty()));
    assert_eq!(
        crate::fanout::route(&bare),
        crate::fanout::Route::To(vec![crate::fanout::Target::User("dave")])
    );
    let dave = Access::new(Some(s("dave")), false, set(&["rchat"]));
    let bob = Access::new(Some(s("bob")), false, set(&["rchat"]));
    assert!(dave.wants(&bare));
    assert!(!bob.wants(&bare));
}

#[tokio::test]
async fn user_updates_reach_only_people_who_share_something() {
    let (state, path) = crate::api::test_util::temp_state("ws_user_scope").await;
    let db = &state.db;
    for name in ["alice", "bob", "carol", "dave"] {
        add_user(db, name).await;
    }
    exec(
        db,
        "INSERT INTO servers(name, display_name, created_at) VALUES('club', 'club', 1)",
    )
    .await;
    exec(db, "INSERT INTO members(server, username, joined_at) VALUES('rchat', 'alice', 1), ('rchat', 'bob', 1), ('rchat', 'carol', 1), ('rchat', 'dave', 1), ('club', 'alice', 2), ('club', 'bob', 2)").await;
    exec(
        db,
        "UPDATE servers SET member_count = 5000 WHERE name = 'rchat'",
    )
    .await;
    exec(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('alice', 'alice'), ('carol', 'alice')",
    )
    .await;
    let scope = user_scope(db, "alice").await;
    assert_eq!(
        scope,
        UserScope {
            servers: vec![s("club")],
            views: vec![s("rchat")],
            users: vec![s("alice"), s("carol")],
        }
    );
    let loner = user_scope(db, "dave").await;
    exec(db, "DELETE FROM members WHERE username = 'dave'").await;
    let alone = user_scope(db, "dave").await;
    assert!(!loner.is_empty() && !alone.is_empty());
    assert_eq!(alone.users, vec![s("dave")]);
    assert!(matches!(
        crate::fanout::route(&WsEvent::UserUpdated {
            user: UserRef {
                username: s("dave"),
                ..message().author
            },
            scope: alone,
        }),
        crate::fanout::Route::To(_)
    ));
    let ev = WsEvent::UserUpdated {
        user: UserRef {
            username: s("alice"),
            ..message().author
        },
        scope,
    };
    let frame = crate::fanout::Fanned::new(ev.clone(), 1).frame().unwrap();
    assert!(!frame.as_str().contains("scope"), "{}", frame.as_str());
    assert!(to_bus_json(&ev).unwrap().contains(r#""views":["rchat"]"#));
    let reached = |access: &Access| match crate::fanout::route(&ev) {
        crate::fanout::Route::To(targets) => {
            let topics = access.topics();
            targets.iter().any(|t| reaches(t, &topics))
        }
        crate::fanout::Route::Everyone => panic!("user updates are scoped"),
    };
    let me = Access::new(Some(s("alice")), false, set(&["rchat", "club"]));
    let bob = Access::new(Some(s("bob")), false, set(&["rchat", "club"]));
    let carol = Access::new(Some(s("carol")), false, set(&["rchat"]));
    let dave = Access::new(Some(s("dave")), false, set(&["rchat"]));
    let mut viewer = Access::new(Some(s("dave")), false, set(&["rchat"]));
    viewer.viewing = Some(s("rchat"));
    assert!(reached(&me) && reached(&bob) && reached(&carol) && reached(&viewer));
    assert!(!reached(&dave));
    crate::api::test_util::done(state, path).await;
}

#[test]
fn error_frames_carry_the_reason_of_rest_errors() {
    use axum::http::StatusCode;

    use crate::api::ApiError;
    use crate::ws::protocol::Refused;
    let wire = |refused: Refused| serde_json::to_string(&refused.frame()).expect("json");
    assert_eq!(
        wire("Not a voice channel".into()),
        r#"{"type":"error","message":"Not a voice channel"}"#,
        "an error without a reason reads as before"
    );
    let off = ApiError::off_site(StatusCode::NOT_FOUND, "Calls are off", "calls");
    assert_eq!(
        wire(off.into()),
        r#"{"type":"error","message":"Calls are off","reason":{"kind":"off_site","control":"calls"}}"#
    );
    let failed = wire(sqlx::Error::Protocol("relation secret_table".to_string()).into());
    assert_eq!(
        failed, r#"{"type":"error","message":"Something went wrong"}"#,
        "no database text in a frame"
    );
    assert_eq!(
        wire(sqlx::Error::PoolTimedOut.into()),
        r#"{"type":"error","message":"Server busy, try again in a moment","reason":{"kind":"unavailable","retry_after":1}}"#
    );
    let back: WsEvent =
        serde_json::from_str(r#"{"type":"error","message":"old"}"#).expect("an older copy");
    assert!(matches!(back, WsEvent::Error { message, reason: None } if message == "old"));
}
