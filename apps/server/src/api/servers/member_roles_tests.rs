use super::*;
use crate::api::test_util::{add_member, done, mem_user, temp_state};

/// A server `club` of alice, with `names` as members.
async fn club(state: &AppState, names: &[&str]) {
    let _ = create_server(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Json(CreateServerReq {
            name: "club".to_string(),
            password: None,
            options: ServerOptions::default(),
        }),
    )
    .await
    .expect("club");
    for name in names {
        crate::db::NewUser::plain(name).add(&state.db).await;
        add_member(&state.db, "club", name, 0, 0, 1).await;
    }
}

/// A role of `club` at `position` without permissions.
async fn role(db: &Db, name: &str, position: i64) -> i64 {
    sqlx::query("INSERT INTO roles(server, name, color, perms, position) VALUES('club', $1, '#336699', 0, $2) RETURNING id")
        .bind(name)
        .bind(position)
        .fetch_one(db)
        .await
        .expect("role")
        .try_get(0)
        .expect("id")
}

async fn give(state: &AppState, id: i64, target: &str) -> Result<(), StatusCode> {
    assign_role(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path(("club".to_string(), id)),
        Json(UsernameReq {
            username: target.to_string(),
        }),
    )
    .await
    .map(|_| ())
    .map_err(|ApiError(code, _, _)| code)
}

async fn take(state: &AppState, id: i64, target: &str) -> Result<(), StatusCode> {
    unassign_role(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path(("club".to_string(), id, target.to_string())),
    )
    .await
    .map(|_| ())
    .map_err(|ApiError(code, _, _)| code)
}

fn events(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(match ev {
            WsEvent::RolesChanged { server } => format!("roles {server}"),
            WsEvent::MemberRolesChanged {
                server,
                username,
                role_ids,
            } => format!("member {server} {username} {role_ids:?}"),
            _ => continue,
        });
    }
    out
}

#[tokio::test]
async fn giving_and_taking_a_role_tells_about_that_member_only() {
    let (state, path) = temp_state("member_role_events").await;
    let db = &state.db;
    club(&state, &["bob", "carol"]).await;
    let low = role(db, "low", 1).await;
    let high = role(db, "high", 2).await;
    let mut rx = state.hub.subscribe();
    give(&state, high, "bob").await.expect("give");
    give(&state, low, "bob").await.expect("give");
    assert_eq!(
        events(&mut rx),
        [
            format!("member club bob [{high}]"),
            format!("member club bob [{low}, {high}]")
        ],
        "each change lists the roles the member holds, lowest id first, and nothing reloads"
    );
    give(&state, low, "bob").await.expect("give again");
    assert_eq!(
        events(&mut rx),
        Vec::<String>::new(),
        "a role already held changes nothing"
    );
    take(&state, high, "bob").await.expect("take");
    assert_eq!(events(&mut rx), [format!("member club bob [{low}]")]);
    assert_eq!(take(&state, high, "bob").await, Err(StatusCode::NOT_FOUND));
    assert_eq!(events(&mut rx), Vec::<String>::new());
    give(&state, high, "carol").await.expect("give carol");
    take(&state, low, "bob").await.expect("take");
    assert_eq!(
        events(&mut rx),
        [
            format!("member club carol [{high}]"),
            "member club bob []".to_string()
        ]
    );
    assert_eq!(
        member_role_ids(db, "club", "carol").await.expect("roles"),
        Some(vec![high])
    );
    assert_eq!(
        member_role_ids(db, "club", "zed").await.expect("roles"),
        None,
        "a non-member holds no roles"
    );
    done(state, path).await;
}
