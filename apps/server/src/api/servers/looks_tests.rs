use super::*;
use crate::api::test_util::{add_member, done, each_db, mem_user, temp_state};

type Answer<T> = Result<T, (StatusCode, String)>;

fn plain<T>(r: Result<T, ApiError>) -> Answer<T> {
    r.map_err(|ApiError(code, msg, _)| (code, msg))
}

async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn one(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
        .try_get(0)
        .expect("number")
}

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

/// A role of `club` at `position` with `perms`, held by `holders`.
async fn role(db: &Db, name: &str, position: i64, perms: i64, holders: &[&str]) -> i64 {
    let id = sqlx::query("INSERT INTO roles(server, name, color, perms, position) VALUES('club', $1, '#336699', $2, $3) RETURNING id")
        .bind(name)
        .bind(perms)
        .bind(position)
        .fetch_one(db)
        .await
        .expect("role")
        .try_get(0)
        .expect("id");
    for holder in holders {
        sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('club', $1, $2)")
            .bind(holder)
            .bind(id)
            .execute(db)
            .await
            .expect("hold");
    }
    id
}

async fn patch(state: &AppState, actor: &str, id: i64, body: serde_json::Value) -> Answer<Role> {
    plain(
        update_role(
            State(state.clone()),
            Authed(mem_user(actor, actor == "root")),
            Path(("club".to_string(), id)),
            Json(serde_json::from_value(body).expect("patch")),
        )
        .await
        .map(|Json(role)| role),
    )
}

async fn show(
    state: &AppState,
    actor: &str,
    order: &[i64],
    version: i64,
) -> Answer<(Vec<i64>, i64)> {
    plain(
        set_role_display(
            State(state.clone()),
            Authed(mem_user(actor, actor == "root")),
            Path("club".to_string()),
            Json(RoleDisplayReq {
                order: order.to_vec(),
                version,
            }),
        )
        .await
        .map(|Json(RoleOrder { order, version })| (order, version)),
    )
}

async fn follow(state: &AppState, actor: &str, version: i64) -> Answer<(Vec<i64>, i64)> {
    plain(
        follow_role_order(
            State(state.clone()),
            Authed(mem_user(actor, actor == "root")),
            Path("club".to_string()),
            Json(RoleDisplayFollowReq { version }),
        )
        .await
        .map(|Json(RoleOrder { order, version })| (order, version)),
    )
}

async fn shown(db: &Db) -> Vec<(i64, Option<i64>)> {
    sqlx::query(
        "SELECT id, display_position FROM roles WHERE server = 'club' ORDER BY position DESC, id",
    )
    .fetch_all(db)
    .await
    .expect("roles")
    .iter()
    .map(|r| (r.try_get(0).expect("id"), r.try_get(1).expect("place")))
    .collect()
}

fn events(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push(match ev {
            WsEvent::RolesChanged { server } => format!("changed {server}"),
            WsEvent::RoleUpdated { server, role } => format!("updated {server} {}", role.name),
            WsEvent::RolesReordered {
                server,
                order,
                display,
                version,
            } => format!("reordered {server} {order:?} {display:?} {version}"),
            _ => continue,
        });
    }
    out
}

async fn updates(db: &Db) -> Vec<serde_json::Value> {
    sqlx::query("SELECT details FROM audit_log WHERE action = 'role.update' ORDER BY id")
        .fetch_all(db)
        .await
        .expect("audit")
        .iter()
        .map(|r| serde_json::from_str(&r.try_get::<String, _>(0).expect("details")).expect("json"))
        .collect()
}

const MANAGER: i64 = Perm::ManageRoles as i64;

/// The text of the code points `points`.
fn text(points: &[u32]) -> String {
    points
        .iter()
        .map(|p| char::from_u32(*p).expect("code point"))
        .collect()
}

#[tokio::test]
async fn role_looks_are_saved_checked_and_sent_as_one_role() {
    let (state, path) = temp_state("role_looks_patch").await;
    let db = &state.db;
    club(&state, &["bob", "carol"]).await;
    let top = role(db, "top", 3, 0, &[]).await;
    let mgr = role(db, "mgr", 2, MANAGER, &["bob"]).await;
    let low = role(db, "low", 1, 0, &[]).await;
    let made = role_in(db, "club", low).await.expect("read").expect("role");
    assert_eq!(
        (
            made.display_position,
            made.hoist,
            made.icon.clone(),
            made.color_names
        ),
        (None, false, None, true),
        "a role follows the role order, shows in no group, has no icon and colors names"
    );
    let mut rx = state.hub.subscribe();
    let saved = patch(
        &state,
        "bob",
        low,
        serde_json::json!({"icon": text(&[0x1f6e1]), "hoist": true, "color_names": false}),
    )
    .await
    .expect("looks");
    let shield = text(&[0x1f6e1, 0xfe0f]);
    assert_eq!(saved.icon, Some(shield.clone()), "stored fully qualified");
    assert!(saved.hoist && !saved.color_names);
    assert_eq!(
        events(&mut rx),
        ["updated club low"],
        "no reload of every role"
    );
    let detail = server_detail(
        db,
        &state.hub,
        &resolve_server(db, "club", Some(&mem_user("carol", false)), &Proof::none())
            .await
            .expect("access"),
    )
    .await
    .expect("detail");
    let listed = detail.roles.iter().find(|r| r.id == low).expect("listed");
    assert_eq!(
        (listed.icon.as_deref(), listed.hoist, listed.color_names),
        (Some(shield.as_str()), true, false)
    );
    let changes = &updates(db).await[0]["changes"];
    assert_eq!(
        changes,
        &serde_json::json!([
            {"field": "icon", "before": null, "after": shield},
            {"field": "hoist", "before": false, "after": true},
            {"field": "color_names", "before": true, "after": false},
        ])
    );
    for wrong in [
        "hi".to_string(),
        text(&[0x1f642, 0x1f642]),
        text(&[0x1f6e1, 0x20, 0x78]),
    ] {
        assert_eq!(
            patch(
                &state,
                "bob",
                low,
                serde_json::json!({"icon": wrong, "name": "renamed"})
            )
            .await
            .err(),
            Some((StatusCode::BAD_REQUEST, "Not an emoji".to_string())),
            "{wrong}"
        );
    }
    assert_eq!(
        role_in(db, "club", low)
            .await
            .expect("read")
            .expect("role")
            .name,
        "low",
        "a refused icon saves nothing"
    );
    for clear in [
        serde_json::json!({"icon": null}),
        serde_json::json!({"icon": "  "}),
    ] {
        exec(db, &format!("UPDATE roles SET icon = 'x' WHERE id = {low}")).await;
        let cleared = patch(&state, "bob", low, clear.clone())
            .await
            .expect("clear");
        assert_eq!(cleared.icon, None, "{clear}");
    }
    let kept = patch(&state, "bob", low, serde_json::json!({"name": "low"}))
        .await
        .expect("kept");
    assert!(kept.hoist && !kept.color_names, "omitted fields stay");
    events(&mut rx);
    patch(
        &state,
        "alice",
        low,
        serde_json::json!({"perms": Perm::Kick as i64}),
    )
    .await
    .expect("perms");
    assert_eq!(
        events(&mut rx),
        ["changed club"],
        "permissions reload the roles"
    );
    patch(
        &state,
        "alice",
        low,
        serde_json::json!({"perms": Perm::Kick as i64, "hoist": false}),
    )
    .await
    .expect("same perms");
    assert_eq!(events(&mut rx), ["updated club low"]);
    assert_eq!(
        patch(&state, "bob", top, serde_json::json!({"hoist": true}))
            .await
            .err(),
        Some((
            StatusCode::FORBIDDEN,
            "You can't change a role that is not below your highest role".to_string()
        )),
        "looks of a role above you stay"
    );
    assert_eq!(
        patch(&state, "carol", low, serde_json::json!({"hoist": true}))
            .await
            .err()
            .map(|(code, _)| code),
        Some(StatusCode::FORBIDDEN),
        "looks need Manage roles"
    );
    assert!(
        patch(&state, "bob", mgr, serde_json::json!({"hoist": true}))
            .await
            .is_err()
    );
    assert_eq!(events(&mut rx), Vec::<String>::new());
    done(state, path).await;
}

#[tokio::test]
async fn the_display_order_moves_roles_below_you_and_follows_the_role_order_again() {
    let (state, path) = temp_state("role_display_order").await;
    let db = &state.db;
    club(&state, &["bob", "carol"]).await;
    let top = role(db, "top", 4, 0, &[]).await;
    let mgr = role(db, "mgr", 3, MANAGER, &["bob"]).await;
    let mid = role(db, "mid", 2, 0, &[]).await;
    let low = role(db, "low", 1, 0, &[]).await;
    let above = Err((
        StatusCode::FORBIDDEN,
        "You can't move a role that is not below your highest role".to_string(),
    ));
    let stale = Err((
        StatusCode::CONFLICT,
        "The role order changed. Refresh and try again.".to_string(),
    ));
    let partial = Err((StatusCode::BAD_REQUEST, "List every role once".to_string()));
    assert_eq!(show(&state, "bob", &[mgr, top, mid, low], 0).await, above);
    assert_eq!(show(&state, "bob", &[top, mgr, low, mid], 3).await, stale);
    assert_eq!(show(&state, "bob", &[top, mgr, low], 0).await, partial);
    assert_eq!(
        show(&state, "carol", &[top, mgr, low, mid], 0)
            .await
            .map_err(|(code, _)| code),
        Err(StatusCode::FORBIDDEN)
    );
    assert_eq!(
        follow(&state, "bob", 0).await,
        Ok((vec![top, mgr, mid, low], 0)),
        "following the role order already changes nothing"
    );
    let mut rx = state.hub.subscribe();
    assert_eq!(
        show(&state, "bob", &[top, mgr, mid, low], 0).await,
        Ok((vec![top, mgr, mid, low], 0)),
        "the order the roles already show in changes nothing"
    );
    assert_eq!(
        shown(db).await,
        [(top, None), (mgr, None), (mid, None), (low, None)]
    );
    assert_eq!(events(&mut rx), Vec::<String>::new());
    assert_eq!(
        show(&state, "bob", &[top, mgr, low, mid], 0).await,
        Ok((vec![top, mgr, low, mid], 1))
    );
    assert_eq!(
        shown(db).await,
        [
            (top, Some(4)),
            (mgr, Some(3)),
            (mid, Some(1)),
            (low, Some(2))
        ],
        "every role gets a display position; the role order stays"
    );
    assert_eq!(
        events(&mut rx),
        [format!(
            "reordered club [{top}, {mgr}, {mid}, {low}] [Some(4), Some(3), Some(1), Some(2)] 1"
        )]
    );
    assert_eq!(
        show(&state, "bob", &[top, mgr, low, mid], 1).await,
        Ok((vec![top, mgr, low, mid], 1)),
        "the same order changes nothing"
    );
    assert_eq!(events(&mut rx), Vec::<String>::new());
    assert_eq!(
        follow(&state, "bob", 1).await,
        Ok((vec![top, mgr, mid, low], 2)),
        "a manager follows the role order again when only roles below them change places"
    );
    assert_eq!(
        shown(db).await,
        [(top, None), (mgr, None), (mid, None), (low, None)]
    );
    assert_eq!(
        show(&state, "alice", &[low, top, mgr, mid], 2).await,
        Ok((vec![low, top, mgr, mid], 3))
    );
    assert_eq!(
        follow(&state, "bob", 3).await,
        above,
        "following the role order would move roles above you"
    );
    assert_eq!(follow(&state, "bob", 2).await, stale);
    let entries = one(
        db,
        "SELECT COUNT(*) FROM audit_log WHERE action = 'role.display_order'",
    )
    .await;
    assert_eq!(entries, 3);
    assert_eq!(
        follow(&state, "alice", 3).await,
        Ok((vec![top, mgr, mid, low], 4))
    );
    assert_eq!(
        shown(db).await,
        [(top, None), (mgr, None), (mid, None), (low, None)]
    );
    let last: serde_json::Value = serde_json::from_str(
        &sqlx::query(
            "SELECT details FROM audit_log WHERE action = 'role.display_order' ORDER BY id DESC",
        )
        .fetch_one(db)
        .await
        .expect("audit")
        .try_get::<String, _>(0)
        .expect("details"),
    )
    .expect("json");
    assert_eq!(last["follow"], true);
    assert_eq!(
        last["roles"],
        serde_json::json!([{"id": low, "name": "low"}]),
        "only the role that changed place is named"
    );
    events(&mut rx);
    let _ = reorder_roles(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path("club".to_string()),
        Json(RoleOrderReq {
            order: vec![top, mgr, low, mid],
            version: 4,
        }),
    )
    .await
    .expect("rank");
    assert_eq!(
        events(&mut rx),
        [format!(
            "reordered club [{top}, {mgr}, {low}, {mid}] [None, None, None, None] 5"
        )],
        "a new rank order is sent as one order too"
    );
    assert_eq!(
        role_places(db, "club").await.expect("places"),
        Some((vec![top, mgr, low, mid], vec![None; 4], 5))
    );
    assert_eq!(role_places(db, "gone").await.expect("places"), None);
    done(state, path).await;
}

#[tokio::test]
async fn an_unconfirmed_order_keeps_roles_you_could_not_edit_where_they_show() {
    let (state, path) = temp_state("role_display_guard").await;
    let db = &state.db;
    club(&state, &["bob", "carol"]).await;
    exec(
        db,
        "UPDATE servers SET roles_order_confirmed = 0 WHERE name = 'club'",
    )
    .await;
    exec(
        db,
        "UPDATE members SET is_admin = 1, perms = 2 WHERE server = 'club' AND username = 'carol'",
    )
    .await;
    let mgr = role(db, "mgr", 4, MANAGER, &["bob"]).await;
    let peer = role(db, "peer", 3, 0, &["carol"]).await;
    let wide = role(db, "wide", 2, Perm::DeleteServer as i64, &[]).await;
    let low = role(db, "low", 1, 0, &[]).await;
    let forbid = |msg: &str| Err((StatusCode::FORBIDDEN, msg.to_string()));
    let lacking = forbid("You can't move a role that has permissions you don't have");
    assert_eq!(
        show(&state, "bob", &[mgr, low, wide, peer], 0).await,
        forbid("You can't move a role held by a member you can't moderate"),
        "a role held by an admin stays"
    );
    assert_eq!(
        show(&state, "bob", &[mgr, peer, low, wide], 0).await,
        lacking,
        "a role with permissions you lack stays"
    );
    assert_eq!(
        show(&state, "alice", &[mgr, peer, low, wide], 0).await,
        Ok((vec![mgr, peer, low, wide], 1))
    );
    assert_eq!(
        follow(&state, "bob", 1).await,
        lacking,
        "following the role order would move a role with permissions you lack"
    );
    exec(
        db,
        "UPDATE servers SET roles_order_confirmed = 1 WHERE name = 'club'",
    )
    .await;
    assert_eq!(
        follow(&state, "bob", 1).await,
        Ok((vec![mgr, peer, wide, low], 2)),
        "once the order is confirmed rank alone decides"
    );
    done(state, path).await;
}

async fn group(
    state: AppState,
    viewer: &str,
    query: String,
) -> Answer<(Vec<String>, Option<String>)> {
    plain(
        list_members(
            State(state),
            MaybeAuthed(Some(mem_user(viewer, false))),
            HeaderMap::new(),
            Path("club".to_string()),
            RawQuery(Some(query)),
        )
        .await
        .map(|Paged(members, next)| (members.into_iter().map(|m| m.user.username).collect(), next)),
    )
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|n| n.to_string()).collect()
}

#[tokio::test]
async fn member_pages_list_each_group_of_the_member_list() {
    for (state, temp) in each_db("role_groups").await {
        let db = &state.db;
        club(&state, &["bob", "carol", "dave", "erin", "fred"]).await;
        let admins = role(db, "admins", 3, 0, &["bob"]).await;
        let mods = role(db, "mods", 2, 0, &["bob", "carol"]).await;
        let fans = role(db, "fans", 1, 0, &["dave"]).await;
        exec(
            db,
            &format!("UPDATE roles SET hoist = 1 WHERE id IN ({admins}, {mods})"),
        )
        .await;
        let of = |q: String| group(state.clone(), "erin", q);
        assert_eq!(
            of(format!("role={admins}&top_hoisted=1")).await,
            Ok((names(&["bob"]), None))
        );
        assert_eq!(
            of(format!("role={mods}&top_hoisted=1")).await,
            Ok((names(&["carol"]), None)),
            "bob shows in the first group he holds"
        );
        assert_eq!(
            of(format!("role={fans}&top_hoisted=1")).await,
            Ok((Vec::new(), None)),
            "a role shown with everyone has no group"
        );
        assert_eq!(
            of("unhoisted=1".to_string()).await,
            Ok((names(&["alice", "dave", "erin", "fred"]), None))
        );
        let (first, next) = of("unhoisted=1&limit=2".to_string()).await.expect("page");
        assert_eq!(first, names(&["alice", "dave"]));
        let next = next.expect("more");
        assert_eq!(
            of(format!("unhoisted=1&limit=2&cursor={next}")).await,
            Ok((names(&["erin", "fred"]), None))
        );
        assert_eq!(
            of(format!("role={mods}&top_hoisted=1&cursor={next}")).await,
            Err((StatusCode::BAD_REQUEST, "Invalid cursor".to_string())),
            "a cursor of one group pages only that group"
        );
        assert_eq!(
            of("top_hoisted=1".to_string()).await,
            Err((
                StatusCode::BAD_REQUEST,
                "top_hoisted needs a role".to_string()
            ))
        );
        assert_eq!(
            of("role=x&top_hoisted=1".to_string()).await,
            Err((StatusCode::BAD_REQUEST, "Invalid role".to_string()))
        );
        exec(
            db,
            &format!("UPDATE roles SET display_position = 9 WHERE id = {mods}"),
        )
        .await;
        assert_eq!(
            of(format!("role={mods}&top_hoisted=1")).await,
            Ok((names(&["bob", "carol"]), None)),
            "groups follow the display order"
        );
        assert_eq!(
            of(format!("role={admins}&top_hoisted=1")).await,
            Ok((Vec::new(), None))
        );
        assert_eq!(
            hoist_groups(db, "club").await.expect("groups"),
            [mods, admins]
        );
        let mut many = Vec::new();
        for i in 0..10 {
            many.push(role(db, &format!("r{i}"), 20 - i, 0, &[]).await);
        }
        exec(db, "UPDATE roles SET hoist = 1").await;
        let groups = hoist_groups(db, "club").await.expect("groups");
        assert_eq!(groups, many);
        assert_eq!(
            of("unhoisted=1".to_string()).await,
            Ok((
                names(&["alice", "bob", "carol", "dave", "erin", "fred"]),
                None
            )),
            "past the first ten groups members show with everyone"
        );
        assert_eq!(
            of(format!("role={mods}&top_hoisted=1")).await,
            Ok((Vec::new(), None))
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_new_role_shows_at_the_bottom_of_a_set_display_order() {
    let (state, path) = temp_state("role_display_new").await;
    let db = &state.db;
    club(&state, &[]).await;
    let make = |name: &'static str| {
        let state = state.clone();
        async move {
            create_role(
                State(state),
                Authed(mem_user("alice", false)),
                Path("club".to_string()),
                Json(RoleReq {
                    name: name.to_string(),
                    color: "#123456".to_string(),
                    perms: 0,
                    mentionable: false,
                }),
            )
            .await
            .expect("role")
            .0
        }
    };
    let first = make("first").await;
    assert_eq!(first.display_position, None, "roles follow the role order");
    let second = make("second").await;
    assert_eq!(second.display_position, None);
    show(&state, "alice", &[second.id, first.id], 2)
        .await
        .expect("display");
    let third = make("third").await;
    assert_eq!(third.display_position, Some(1));
    assert_eq!(
        shown(db).await,
        [
            (first.id, Some(1 + 1)),
            (second.id, Some(2 + 1)),
            (third.id, Some(1))
        ]
    );
    done(state, path).await;
}
