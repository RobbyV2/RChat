use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::Value;
use sqlx::Row;

use super::*;
use crate::api::test_util::{each_db, mem_user};
use crate::db::{NewUser, User, now};
use crate::limits::Limits;

const CASES: &str = include_str!("../../../../../assets/member_filter_cases.json");

async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .expect(sql);
}

async fn id_of(db: &Db, sql: &str, text: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .bind(text)
        .fetch_one(db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("id")
}

fn roomy(state: AppState) -> AppState {
    state.with_limits(Arc::new(Limits {
        lookup_member_search_per_minute: 1_000,
        ..Limits::default()
    }))
}

async fn search(
    state: &AppState,
    who: &User,
    query: &str,
) -> Result<(Vec<MemberHit>, Option<String>), ApiError> {
    search_members(
        State(state.clone()),
        Authed(who.clone()),
        HeaderMap::new(),
        Path("club".to_string()),
        RawQuery(Some(query.to_string())),
    )
    .await
    .map(|Paged(hits, next)| (hits, next))
}

fn names(hits: &[MemberHit]) -> Vec<String> {
    hits.iter()
        .map(|h| h.member.user.username.clone())
        .collect()
}

fn refused(res: Result<(Vec<MemberHit>, Option<String>), ApiError>) -> (StatusCode, String) {
    match res {
        Ok((hits, _)) => panic!("answered {:?}", names(&hits)),
        Err(ApiError(code, text, _)) => (code, text),
    }
}

async fn club(db: &Db) {
    exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'owner', 0)").await;
}

/// The members, roles and passwords of the case table in `club`, with the ids the names got.
async fn seed_cases(db: &Db, table: &Value) -> (HashMap<String, i64>, HashMap<String, i64>) {
    club(db).await;
    let mut roles = HashMap::new();
    for name in table["roles"].as_array().expect("roles") {
        let name = name.as_str().expect("role");
        let id = id_of(db, "INSERT INTO roles(server, name, color, perms) VALUES('club', $1, '#ffffff', 0) RETURNING id", name).await;
        roles.insert(name.to_string(), id);
    }
    let mut via = HashMap::new();
    for label in table["via"].as_array().expect("via") {
        let label = label.as_str().expect("via");
        let id = id_of(db, "INSERT INTO server_passwords(server, label, hash, lookup, created_at) VALUES('club', $1, 'h', $1, 0) RETURNING id", label).await;
        via.insert(label.to_string(), id);
    }
    for m in table["members"].as_array().expect("members") {
        let username = m["username"].as_str().expect("username");
        NewUser::plain(username)
            .shown(m["display_name"].as_str().expect("display_name"))
            .at(m["created_at"].as_i64().expect("created_at"))
            .add(db)
            .await;
        sqlx::query("INSERT INTO members(server, username, is_admin, perms, joined_at, joined_via) VALUES('club', $1, 0, 0, $2, $3)")
            .bind(username)
            .bind(m["joined_at"].as_i64().expect("joined_at"))
            .bind(m["via"].as_str().map(|v| via[v]))
            .execute(db)
            .await
            .expect("member");
        for role in m["roles"].as_array().expect("roles") {
            sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('club', $1, $2)")
                .bind(username)
                .bind(roles[role.as_str().expect("role")])
                .execute(db)
                .await
                .expect("role");
        }
    }
    (roles, via)
}

/// The query a case names, with the ids its role and password names got.
fn query_of(query: &Value, roles: &HashMap<String, i64>, via: &HashMap<String, i64>) -> String {
    let mut out = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in query.as_object().expect("query") {
        let text = match key.as_str() {
            "roles" => value
                .as_array()
                .expect("roles")
                .iter()
                .map(|r| roles[r.as_str().expect("role")].to_string())
                .collect::<Vec<_>>()
                .join(","),
            "via" => via[value.as_str().expect("via")].to_string(),
            "q" | "sort" => value.as_str().expect("text").to_string(),
            _ => value.as_i64().expect("time").to_string(),
        };
        out.append_pair(key, &text);
    }
    out.finish()
}

#[tokio::test]
async fn the_shared_filter_cases_hold_on_every_database() {
    let table: Value = serde_json::from_str(CASES).expect("cases");
    let root = mem_user("root", true);
    for (state, temp) in each_db("member_search_cases").await {
        let state = roomy(state);
        let (roles, via) = seed_cases(&state.db, &table).await;
        for case in table["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("name");
            let query = query_of(&case["query"], &roles, &via);
            let (hits, next) = search(&state, &root, &query).await.expect(name);
            let expect: Vec<String> = case["expect"]
                .as_array()
                .expect("expect")
                .iter()
                .map(|e| e.as_str().expect("username").to_string())
                .collect();
            assert_eq!(names(&hits), expect, "{name}: {query}");
            assert_eq!(next, None, "{name}: one page");
        }
        temp.done(state).await;
    }
}

#[tokio::test]
async fn hits_carry_the_join_and_account_times_and_what_the_caller_may_see() {
    let table: Value = serde_json::from_str(CASES).expect("cases");
    for (state, temp) in each_db("member_search_hits").await {
        let state = roomy(state);
        let db = &state.db;
        let (roles, via) = seed_cases(db, &table).await;
        NewUser::plain("kicker").at(1).add(db).await;
        exec(db, &format!("INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('club', 'kicker', 1, {}, 1)", Perm::Kick as i64)).await;
        let kicker = mem_user("kicker", false);
        let (hits, _) = search(&state, &kicker, "q=alice").await.expect("kick");
        let [alice] = hits.as_slice() else {
            panic!("one hit: {:?}", names(&hits));
        };
        assert_eq!(
            (alice.joined_at, alice.created_at),
            (1_700_001_000, Some(1_700_000_100))
        );
        assert_eq!(alice.member.user.display_name, "Alice Liddell");
        assert_eq!(alice.member.role_ids, vec![roles["mods"]]);
        assert!(alice.member.joined_via.is_none(), "needs Manage invites");
        let json = serde_json::to_value(alice).expect("json");
        assert_eq!(json["username"], "alice", "the member is flattened");
        assert_eq!(json["joined_at"], 1_700_001_000);
        assert_eq!(
            refused(search(&state, &kicker, &format!("via={}", via["friends"])).await),
            (StatusCode::FORBIDDEN, "Missing permission".to_string()),
            "via needs Manage invites"
        );
        exec(
            db,
            &format!(
                "UPDATE members SET perms = {} WHERE username = 'kicker'",
                Perm::Kick as i64 | Perm::ManageInvites as i64
            ),
        )
        .await;
        let (hits, _) = search(&state, &kicker, &format!("via={}", via["friends"]))
            .await
            .expect("via");
        assert_eq!(names(&hits), ["alice", "dave"]);
        let joined = hits[0].member.joined_via.as_ref().expect("joined_via");
        assert_eq!(
            (joined.id, joined.label.as_deref()),
            (via["friends"], Some("friends"))
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn hits_carry_the_look_members_set_in_the_server() {
    let table: Value = serde_json::from_str(CASES).expect("cases");
    for (state, temp) in each_db("member_search_looks").await {
        let state = roomy(state);
        let db = &state.db;
        seed_cases(db, &table).await;
        NewUser::plain("kicker").at(1).add(db).await;
        exec(db, &format!("INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('club', 'kicker', 1, {}, 1)", Perm::Kick as i64)).await;
        exec(db, "INSERT INTO member_profiles(server, username, name, updated_at) VALUES('club', 'alice', 'Ali', 1)").await;
        let kicker = mem_user("kicker", false);
        let (hits, _) = search(&state, &kicker, "q=alice").await.expect("search");
        let [alice] = hits.as_slice() else {
            panic!("one hit: {:?}", names(&hits));
        };
        assert_eq!(
            alice
                .member
                .profile
                .as_ref()
                .and_then(|l| l.name.as_deref()),
            Some("Ali")
        );
        assert_eq!(
            serde_json::to_value(alice).expect("json")["profile"]["name"],
            "Ali"
        );
        let (hits, _) = search(&state, &kicker, "").await.expect("everyone");
        assert!(
            hits.iter()
                .filter(|h| h.member.user.username != "alice")
                .all(|h| h.member.profile.is_none()),
            "{:?}",
            names(&hits)
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn accounts_that_show_their_profile_only_to_friends_keep_their_age_to_themselves() {
    for (state, temp) in each_db("member_search_ages").await {
        let state = roomy(state);
        let db = &state.db;
        club(db).await;
        for (name, at, perms) in [
            ("kicker", 30, Perm::Kick as i64),
            ("open", 20, 0),
            ("shy", 10, 0),
        ] {
            NewUser::plain(name).at(at).add(db).await;
            exec(db, &format!("INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('club', '{name}', 1, {perms}, 1)")).await;
        }
        exec(db, "INSERT INTO privacy(username, profile) VALUES('shy', 'friends'), ('kicker', 'friends'), ('open', 'everyone')").await;
        let kicker = mem_user("kicker", false);
        let ages = |hits: &[MemberHit]| {
            hits.iter()
                .map(|h| (h.member.user.username.clone(), h.created_at))
                .collect::<Vec<_>>()
        };
        let (hits, _) = search(&state, &kicker, "").await.expect("all");
        assert_eq!(
            ages(&hits),
            [
                ("kicker".to_string(), Some(30)),
                ("open".to_string(), Some(20)),
                ("shy".to_string(), None)
            ]
        );
        for query in [
            "sort=created_desc",
            "sort=created_asc",
            "created_after=0",
            "created_before=99",
        ] {
            let (hits, _) = search(&state, &kicker, query).await.expect(query);
            let mut found = names(&hits);
            found.sort();
            assert_eq!(found, ["kicker", "open"], "{query}");
        }
        let (hits, _) = search(&state, &kicker, "sort=joined_desc")
            .await
            .expect("joined");
        assert_eq!(hits.len(), 3, "join times are not the account's");
        exec(db, "DELETE FROM settings WHERE key = 'profile_choices'").await;
        exec(
            db,
            "INSERT INTO settings(key, value) VALUES('profile_choices', 'site')",
        )
        .await;
        crate::api::Settings::forget(db);
        let (hits, _) = search(&state, &kicker, "sort=created_asc")
            .await
            .expect("site");
        assert_eq!(
            names(&hits),
            ["shy", "open", "kicker"],
            "the site's level holds for everyone"
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn only_members_who_moderate_or_handle_roles_may_search() {
    for (state, temp) in each_db("member_search_who").await {
        let state = roomy(state);
        let db = &state.db;
        club(db).await;
        let assign = id_of(db, &format!("INSERT INTO roles(server, name, color, perms) VALUES('club', $1, '#ffffff', {}) RETURNING id", Perm::AssignRoles as i64), "helpers").await;
        let plain = id_of(db, &format!("INSERT INTO roles(server, name, color, perms) VALUES('club', $1, '#ffffff', {}) RETURNING id", Perm::ManageChannels as i64 | Perm::ManageInvites as i64), "builders").await;
        for (name, is_admin, perms) in [
            ("timer", 1, Perm::TimeoutMembers as i64),
            ("roler", 1, Perm::ManageRoles as i64),
            ("helper", 0, 0),
            ("builder", 0, 0),
            ("nobody", 0, 0),
        ] {
            NewUser::plain(name).at(1).add(db).await;
            exec(db, &format!("INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('club', '{name}', {is_admin}, {perms}, 1)")).await;
        }
        exec(db, &format!("INSERT INTO user_roles(server, username, role_id) VALUES('club', 'helper', {assign}), ('club', 'builder', {plain})")).await;
        let missing = (StatusCode::FORBIDDEN, "Missing permission".to_string());
        for name in ["timer", "roler", "helper"] {
            let (hits, _) = search(&state, &mem_user(name, false), "")
                .await
                .expect(name);
            assert_eq!(hits.len(), 5, "{name}");
        }
        for name in ["builder", "nobody"] {
            assert_eq!(
                refused(search(&state, &mem_user(name, false), "").await),
                missing,
                "{name}"
            );
        }
        assert_eq!(
            refused(search(&state, &mem_user("outsider", false), "").await),
            missing,
            "an outsider of an open server holds no permission"
        );
        exec(db, &format!("INSERT INTO member_timeouts(server, username, until, reason, created_at) VALUES('club', 'timer', {}, NULL, 1)", now() + 600)).await;
        let (hits, _) = search(&state, &mem_user("timer", false), "q=time")
            .await
            .expect("a timeout leaves searching");
        assert!(
            hits[0].member.timeout.is_some(),
            "and shows running timeouts"
        );
        exec(
            db,
            "UPDATE servers SET password_hash = 'hash' WHERE name = 'club'",
        )
        .await;
        assert_eq!(
            refused(search(&state, &mem_user("outsider", false), "").await).0,
            StatusCode::NOT_FOUND,
            "a protected server stays hidden"
        );
        temp.done(state).await;
    }
}

/// `n` members `m10001`... of `club`: joined in groups of three to the same second, accounts
/// made in the reverse order, every seventh shown as a name with `match` in it.
async fn crowd(db: &Db, n: i64) {
    club(db).await;
    let mut tx = db.begin().await.expect("begin");
    for i in 1..=n {
        let shown = match i % 7 {
            0 => format!("Match {i}"),
            _ => format!("Other {i}"),
        };
        NewUser::plain(&format!("m{}", 10_000 + i))
            .shown(&shown)
            .at(n - i)
            .add(&mut *tx)
            .await;
    }
    tx.commit().await.expect("users");
    exec(db, &format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {n}) INSERT INTO members(server, username, is_admin, perms, joined_at) SELECT 'club', 'm' || (10000 + i), 0, 0, i / 3 FROM n")).await;
}

/// Every page of `query`, followed by its cursors, with the pages' sizes.
async fn every_page(state: &AppState, who: &User, query: &str) -> (Vec<String>, Vec<usize>) {
    let (mut all, mut sizes) = (Vec::new(), Vec::new());
    let mut cursor: Option<String> = None;
    loop {
        let q = match &cursor {
            Some(c) => format!("{query}&cursor={c}"),
            None => query.to_string(),
        };
        let (hits, next) = search(state, who, &q).await.expect(&q);
        sizes.push(hits.len());
        all.extend(names(&hits));
        match next {
            Some(next) => cursor = Some(next),
            None => return (all, sizes),
        }
        assert!(sizes.len() < 100, "pages end");
    }
}

#[tokio::test]
async fn pages_list_every_member_once_in_each_order() {
    let root = mem_user("root", true);
    for (state, temp) in each_db("member_search_pages").await {
        let state = roomy(state);
        crowd(&state.db, 130).await;
        let rows: Vec<(String, i64, i64, bool)> = (1..=130)
            .map(|i| (format!("m{}", 10_000 + i), i / 3, 130 - i, i % 7 == 0))
            .collect();
        let order = |sort: &str, only: bool| -> Vec<String> {
            let mut kept: Vec<&(String, i64, i64, bool)> =
                rows.iter().filter(|r| !only || r.3).collect();
            match sort {
                "joined_desc" => kept.sort_by(|a, b| (b.1, &b.0).cmp(&(a.1, &a.0))),
                "joined_asc" => kept.sort_by(|a, b| (a.1, &a.0).cmp(&(b.1, &b.0))),
                "created_desc" => kept.sort_by(|a, b| (b.2, &b.0).cmp(&(a.2, &a.0))),
                "created_asc" => kept.sort_by(|a, b| (a.2, &a.0).cmp(&(b.2, &b.0))),
                _ => kept.sort_by(|a, b| a.0.cmp(&b.0)),
            }
            kept.into_iter().map(|r| r.0.clone()).collect()
        };
        for sort in [
            "name",
            "joined_desc",
            "joined_asc",
            "created_desc",
            "created_asc",
        ] {
            let (all, sizes) = every_page(&state, &root, &format!("sort={sort}")).await;
            assert_eq!(all, order(sort, false), "{sort}");
            assert_eq!(sizes, [50, 50, 30], "{sort}");
            let (all, _) = every_page(&state, &root, &format!("sort={sort}&q=match&limit=4")).await;
            assert_eq!(all, order(sort, true), "{sort} with q");
        }
        let (_, next) = search(&state, &root, "sort=joined_desc&limit=2")
            .await
            .expect("first");
        assert_eq!(
            refused(
                search(
                    &state,
                    &root,
                    &format!("sort=joined_asc&cursor={}", next.expect("cursor"))
                )
                .await
            ),
            (StatusCode::BAD_REQUEST, "Invalid cursor".to_string()),
            "a cursor belongs to its sort"
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_search_reads_a_bounded_number_of_rows_a_request() {
    let root = mem_user("root", true);
    for (state, temp) in each_db("member_search_bounded").await {
        let state = roomy(state);
        crowd(&state.db, 2_100).await;
        exec(
            &state.db,
            "UPDATE users SET display_name = 'Émile' WHERE username = 'm12050'",
        )
        .await;
        let (first, next) = search(&state, &root, "q=%C3%A9").await.expect("first");
        assert_eq!(
            names(&first),
            Vec::<String>::new(),
            "nothing in the first rows"
        );
        let next = next.expect("the rest follows");
        let (rest, after) = search(&state, &root, &format!("q=%C3%A9&cursor={next}"))
            .await
            .expect("rest");
        assert_eq!((names(&rest), after), (vec!["m12050".to_string()], None));
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_cursor_never_names_an_account_whose_age_is_hidden() {
    let root = mem_user("root", true);
    for (state, temp) in each_db("member_search_hidden_cursor").await {
        let state = roomy(state);
        crowd(&state.db, 2_100).await;
        exec(&state.db, "INSERT INTO privacy(username, profile) SELECT username, 'friends' FROM members WHERE server = 'club' AND username <> 'm10007'").await;
        for query in ["sort=created_desc", "created_after=0"] {
            let (hits, next) = search(&state, &root, query).await.expect(query);
            assert_eq!(
                (names(&hits), next),
                (vec!["m10007".to_string()], None),
                "{query}: the hidden accounts are not read at all"
            );
        }
        temp.done(state).await;
    }
}

#[test]
fn bad_values_name_their_field() {
    let field = |raw: &str| match Search::parse(raw) {
        Ok(s) => panic!("{raw}: read as {s:?}"),
        Err(e) => e.2.and_then(|r| r.field).expect("field"),
    };
    let long = "a".repeat(33);
    let roles = (1..=26)
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(",");
    for (raw, f) in [
        (format!("q={long}"), "q"),
        ("q=a%00b".to_string(), "q"),
        (format!("roles={roles}"), "roles"),
        ("roles=1,x".to_string(), "roles"),
        ("joined_after=-1".to_string(), "joined_after"),
        ("joined_before=soon".to_string(), "joined_before"),
        ("created_after=1.5".to_string(), "created_after"),
        ("created_before=".to_string(), "created_before"),
        ("via=friends".to_string(), "via"),
        ("sort=random".to_string(), "sort"),
        ("limit=lots".to_string(), "limit"),
    ] {
        assert_eq!(field(&raw), f, "{raw}");
    }
    let s = Search::parse("q=%20Al%20&roles=3,%207,3&sort=created_asc&limit=500&cursor=&other=1")
        .expect("search");
    assert_eq!(
        s,
        Search {
            q: Some("al".to_string()),
            roles: vec![3, 7],
            sort: MemberSort::CreatedAsc,
            limit: PAGE_MAX,
            ..Search::default()
        }
    );
    assert_eq!(
        Search::parse("q=%20%20").expect("blank").q,
        None,
        "blank is any name"
    );
}

#[test]
fn the_sql_pattern_keeps_every_name_the_rule_keeps() {
    for (q, pattern) in [
        ("li", Some("%l%")),
        ("bob", Some("%bob%")),
        ("50%", Some("%50\\%%")),
        ("r_s", Some("%r\\_s%")),
        ("a\\b", Some("%a\\\\b%")),
        ("kir", Some("%r%")),
        ("éc", Some("%c%")),
        ("ab é cd", Some("%ab % cd%")),
        ("é", None),
        ("ik", None),
    ] {
        assert_eq!(q_pattern(q).as_deref(), pattern, "{q}");
    }
    assert!(name_matches("kir", "henry", "KIRK"));
    assert!(name_matches("éc", "gina", "ÉCLAIR"));
    assert!(
        name_matches("ali", "x", "ALİ"),
        "İ lowercases to i and a dot"
    );
    assert!(!name_matches("bob", "alice", "Alice"));
}

#[tokio::test]
async fn members_added_by_staff_show_no_join_source() {
    let table: Value = serde_json::from_str(CASES).expect("cases");
    for (state, temp) in each_db("member_search_staff").await {
        let state = roomy(state);
        let db = &state.db;
        let (_, via) = seed_cases(db, &table).await;
        NewUser::plain("zed").at(5).add(db).await;
        let body = serde_json::from_value(serde_json::json!({ "server": "club" })).expect("body");
        let _ = crate::api::admin_users::add_to_server(
            State(state.clone()),
            Authed(mem_user("root", true)),
            Path("zed".to_string()),
            axum::Json(body),
        )
        .await
        .expect("added");
        NewUser::plain("keeper").at(1).add(db).await;
        exec(db, &format!("INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('club', 'keeper', 1, {}, 1)", Perm::Kick as i64 | Perm::ManageInvites as i64)).await;
        let keeper = mem_user("keeper", false);
        let (hits, _) = search(&state, &keeper, "q=zed").await.expect("zed");
        let json = serde_json::to_string(&hits).expect("json");
        assert_eq!(names(&hits), ["zed"]);
        assert!(hits[0].member.joined_via.is_none(), "{json}");
        assert!(!json.contains("staff"), "{json}");
        for id in via.values() {
            let (hits, _) = search(&state, &keeper, &format!("via={id}"))
                .await
                .expect("via");
            assert!(!names(&hits).contains(&"zed".to_string()), "via={id}");
        }
        temp.done(state).await;
    }
}
