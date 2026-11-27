use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use serde_json::json;

use super::super::{EditReq, SearchQuery, edit_message, search_paged, send_channel_message};
use crate::api::servers::update_server;
use crate::api::test_util::{TempDb, add_member, each_db_keyed, each_db_scanning, mem_user};
use crate::db::{Db, is_sqlite};
use crate::state::AppState;

/// A small deterministic generator (xorshift64*).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Pieces of text: ASCII in both cases, lowercase letters beyond ASCII, CJK, an emoji and the
/// characters SQL patterns treat specially. Upper case appears only in ASCII, which every fold
/// the plain search uses agrees on.
const PIECES: [&str; 24] = [
    "ab", "AB", "Ab", "cd", "abc", "needle", "Needle", "hay", "stack", "é", "ü", "ß", "日本", "語",
    "🙂", "ж", "x", "-", "%", "_", " ", "0", "42", "\"q\"",
];

fn corpus(rng: &mut Rng) -> Vec<String> {
    (0..48)
        .map(|n| {
            let pieces = 1 + rng.below(7);
            let joint = match rng.below(3) {
                0 => "",
                _ => " ",
            };
            let mut text: Vec<String> = (0..pieces)
                .map(|_| PIECES[rng.below(PIECES.len())].to_owned())
                .collect();
            if n % 6 == 0 {
                let run = PIECES[rng.below(PIECES.len())];
                text.push(run.repeat(30 + rng.below(20)));
            }
            text.join(joint)
        })
        .filter(|t| !t.trim().is_empty())
        .collect()
}

fn queries(rng: &mut Rng, docs: &[String]) -> Vec<String> {
    let mut out: Vec<String> = PIECES.iter().map(|p| p.to_string()).collect();
    out.extend([
        "zzz".to_owned(),
        "needle hay".to_owned(),
        "日本語".to_owned(),
    ]);
    for _ in 0..60 {
        let doc: Vec<char> = docs[rng.below(docs.len())].chars().collect();
        let len = 1 + rng.below(8.min(doc.len()));
        let at = rng.below(doc.len() - len + 1);
        let text: String = doc[at..at + len]
            .iter()
            .map(|c| match rng.below(3) {
                0 => c.to_ascii_uppercase(),
                _ => *c,
            })
            .collect();
        if !text.trim().is_empty() {
            out.push(text);
        }
    }
    out
}

async fn send(state: &AppState, cid: i64, text: &str) -> i64 {
    send_channel_message(
        State(state.clone()),
        Path(cid),
        crate::api::Authed(mem_user("bob", false)),
        Json(serde_json::from_value(json!({"content": text})).expect("request")),
    )
    .await
    .expect("send")
    .0
    .id
}

async fn channel(db: &Db, server: &str) -> i64 {
    sqlx::query_scalar("SELECT id FROM channels WHERE server = $1 ORDER BY id LIMIT 1")
        .bind(server)
        .fetch_one(db)
        .await
        .expect("channel")
}

/// `rchat` with encrypted storage on and `club` without, `alice` managing `rchat` and `bob`
/// writing in both: the channels of `rchat` and `club`.
async fn two_places(state: &AppState) -> (i64, i64) {
    let db = &state.db;
    sqlx::query("INSERT INTO servers(name, display_name, created_at) VALUES('club', 'Club', 0)")
        .execute(db)
        .await
        .expect("club");
    sqlx::query(
        "INSERT INTO channels(server, name, kind, created_at) VALUES('club', 'lounge', 'text', 0)",
    )
    .execute(db)
    .await
    .expect("lounge");
    add_member(db, "rchat", "alice", 1, 0, 1).await;
    for server in ["rchat", "club"] {
        add_member(db, server, "bob", 0, 0, 1).await;
    }
    add_member(db, "club", "alice", 0, 0, 1).await;
    switch(state, true).await;
    (channel(db, "rchat").await, channel(db, "club").await)
}

async fn switch(state: &AppState, on: bool) {
    let _ = update_server(
        State(state.clone()),
        crate::api::Authed(mem_user("alice", false)),
        Path("rchat".to_owned()),
        Json(serde_json::from_value(json!({"seal": on})).expect("patch")),
    )
    .await
    .expect("switch");
}

/// Every result of the search for `q`, page by page, as (server, content).
async fn hits(state: &AppState, q: &str, server: Option<&str>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut before = None;
    for _ in 0..40 {
        let sq = SearchQuery {
            q: Some(q.to_owned()),
            server: server.map(str::to_owned),
            before,
            ..SearchQuery::default()
        };
        let (rows, next) = search_paged(
            state,
            Some(&mem_user("alice", false)),
            &HeaderMap::new(),
            sq,
        )
        .await
        .expect("search");
        out.extend(rows.into_iter().map(|r| (r.server, r.message.content)));
        match next {
            Some(id) => before = Some(id),
            None => return out,
        }
    }
    panic!("the search for {q:?} never ended");
}

fn of(hits: &[(String, String)], server: &str) -> Vec<String> {
    hits.iter()
        .filter(|(s, _)| s == server)
        .map(|(_, text)| text.clone())
        .collect()
}

/// Every query finds in the encrypted server what it finds in the plain one, alone and in a
/// search of both.
async fn same_hits(state: &AppState, queries: &[String]) -> usize {
    let mut found = 0;
    for q in queries {
        let plain = hits(state, q, Some("club")).await;
        let sealed = hits(state, q, Some("rchat")).await;
        assert_eq!(of(&sealed, "rchat"), of(&plain, "club"), "q={q:?}");
        let both = hits(state, q, None).await;
        assert_eq!(of(&both, "rchat"), of(&plain, "club"), "both, q={q:?}");
        assert_eq!(of(&both, "club"), of(&plain, "club"), "both, q={q:?}");
        found += plain.len();
    }
    found
}

async fn count(db: &Db, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_one(db)
        .await
        .expect(sql)
}

/// Terms of encrypted messages that are not keyed terms.
const UNKEYED: &str = "SELECT COUNT(*) FROM search_postings p JOIN messages m ON m.id = p.id WHERE m.body IS NOT NULL AND NOT (p.term GLOB 'k[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' OR p.term GLOB 'k#[0-9a-f][0-9a-f][0-9a-f]')";

async fn corpus_in_both(state: &AppState, seed: u64) -> (Vec<String>, Vec<String>) {
    let (sealed, plain) = two_places(state).await;
    let mut rng = Rng(seed);
    let docs = corpus(&mut rng);
    for text in &docs {
        send(state, plain, text).await;
        send(state, sealed, text).await;
    }
    let qs = queries(&mut rng, &docs);
    (docs, qs)
}

#[tokio::test]
async fn keyed_search_finds_what_plain_search_finds() {
    for (state, temp) in each_db_keyed("keyed_search").await {
        let db = &state.db;
        let (docs, qs) = corpus_in_both(&state, 0x5eed_0001).await;
        assert!(docs.iter().any(|d| d.len() > 128) && docs.iter().any(|d| !d.is_ascii()));
        let sealed = count(db, "SELECT COUNT(*) FROM messages WHERE body IS NOT NULL").await;
        assert_eq!(sealed, docs.len() as i64);
        let found = same_hits(&state, &qs).await;
        assert!(found > 100, "the queries find something: {found}");
        match is_sqlite(db) {
            true => {
                crate::db::build_channel_index(db).await.expect("merge");
                assert_eq!(count(db, UNKEYED).await, 0, "only keyed terms");
                assert!(count(db, "SELECT COUNT(*) FROM search_postings p JOIN messages m ON m.id = p.id WHERE m.body IS NOT NULL").await > sealed);
                assert_eq!(same_hits(&state, &qs).await, found);
            }
            false => {
                let grams =
                    "SELECT COUNT(*) FROM messages WHERE body IS NOT NULL AND grams IS NOT NULL";
                assert_eq!(count(db, grams).await, sealed);
                assert_eq!(
                    count(
                        db,
                        "SELECT COUNT(*) FROM messages WHERE body IS NULL AND grams IS NOT NULL"
                    )
                    .await,
                    0
                );
                assert_eq!(
                    count(db, "SELECT COUNT(*) FROM messages WHERE body IS NOT NULL AND grams && rchat_search_grams(lower(content)) AND cardinality(rchat_search_grams(lower(content))) > 0").await,
                    0
                );
            }
        }
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_search_follows_edits_and_the_switch() {
    for (state, temp) in each_db_keyed("keyed_search_edits").await {
        let db = &state.db;
        let (sealed, plain) = two_places(&state).await;
        let early = send(&state, sealed, "an early needle").await;
        send(&state, plain, "a plain needle").await;
        let edited = edit_message(
            State(state.clone()),
            Path(early),
            crate::api::Authed(mem_user("bob", false)),
            Json(
                serde_json::from_value::<EditReq>(json!({"content": "now a haystack"}))
                    .expect("edit"),
            ),
        )
        .await
        .expect("edit");
        assert_eq!(edited.0.content, "now a haystack");
        for merged in [false, true] {
            if merged && is_sqlite(db) {
                crate::db::build_channel_index(db).await.expect("merge");
            }
            assert_eq!(
                of(&hits(&state, "needle", None).await, "rchat"),
                Vec::<String>::new()
            );
            assert_eq!(
                of(&hits(&state, "haystack", None).await, "rchat"),
                ["now a haystack"]
            );
            assert_eq!(
                of(&hits(&state, "ys", None).await, "rchat"),
                ["now a haystack"]
            );
        }
        switch(&state, false).await;
        send(&state, sealed, "a needle stored plain").await;
        assert_eq!(
            of(&hits(&state, "needle", Some("rchat")).await, "rchat"),
            ["a needle stored plain"]
        );
        assert_eq!(
            of(&hits(&state, "haystack", Some("rchat")).await, "rchat"),
            ["now a haystack"],
            "what was stored encrypted is still found"
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn scan_mode_stores_no_grams_and_finds_by_reading() {
    for (state, temp) in each_db_scanning("scan_search").await {
        let db = &state.db;
        let (_, qs) = corpus_in_both(&state, 0x5eed_0002).await;
        let found = same_hits(&state, &qs[..30]).await;
        assert!(found > 20, "the queries find something: {found}");
        match is_sqlite(db) {
            true => {
                crate::db::build_channel_index(db).await.expect("merge");
                assert_eq!(
                    count(db, "SELECT COUNT(*) FROM search_postings p JOIN messages m ON m.id = p.id WHERE m.body IS NOT NULL AND p.term <> ''").await,
                    0,
                    "only the catch-all postings"
                );
                assert_eq!(same_hits(&state, &qs[..30]).await, found);
            }
            false => assert_eq!(
                count(db, "SELECT COUNT(*) FROM messages WHERE grams IS NOT NULL").await,
                0
            ),
        }
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM data_keys WHERE purpose = 'search'"
            )
            .await,
            0
        );
        temp.done(state).await;
    }
}

/// A database whose encrypted messages have no grams, as `SEARCH_SEALED=scan` leaves them or
/// as a database whose encrypted rows were never indexed holds them, gets them from the sweep
/// on Postgres and the merge on SQLite.
#[tokio::test]
async fn messages_without_grams_get_them() {
    for (state, temp) in each_db_scanning("grams_later").await {
        let db = &state.db;
        let (sealed, _) = two_places(&state).await;
        send(&state, sealed, "stored with no grams").await;
        let url = temp.url();
        crate::db::close(db).await;
        let keyed = crate::db::open_keyed(Some(&url)).await.expect("reopen");
        let instance = crate::instance::Instance::load(&keyed, &Default::default())
            .await
            .expect("instance");
        let state = AppState::new(keyed, crate::ws::Hub::new(), None, None, instance);
        crate::api::seal::start(&state).await.expect("start");
        let db = &state.db;
        match is_sqlite(db) {
            true => {
                crate::db::build_channel_index(db).await.expect("merge");
                assert_eq!(count(db, UNKEYED).await, 0);
                assert!(count(db, "SELECT COUNT(*) FROM search_postings p JOIN messages m ON m.id = p.id WHERE m.body IS NOT NULL").await > 1);
            }
            false => {
                assert_eq!(crate::api::seal::fill_grams(db).await.expect("fill"), 1);
                assert_eq!(
                    count(
                        db,
                        "SELECT COUNT(*) FROM messages WHERE body IS NOT NULL AND grams IS NULL"
                    )
                    .await,
                    0
                );
            }
        }
        assert_eq!(
            of(&hits(&state, "no grams", None).await, "rchat"),
            ["stored with no grams"]
        );
        TempDb::done(temp, state).await;
    }
}

async fn member_scope(db: &Db, who: &str) -> super::Scope {
    super::super::search_scope(
        db,
        Some(&mem_user(who, false)),
        &crate::api::access::Proof::none(),
        None,
    )
    .await
    .expect("scope")
    .expect("member scope")
}

async fn explain(db: &Db, sql: &str, binds: &[super::Bind]) -> String {
    let (head, column) = match is_sqlite(db) {
        true => ("EXPLAIN QUERY PLAN", 3),
        false => ("EXPLAIN", 0),
    };
    let mut tx = db.begin().await.expect("plan");
    if !is_sqlite(db) {
        sqlx::query("SET LOCAL jit = off")
            .execute(&mut *tx)
            .await
            .expect("jit");
    }
    let lines = super::bind_all(
        sqlx::query(sqlx::AssertSqlSafe(format!("{head} {sql}"))),
        binds,
    )
    .fetch_all(&mut *tx)
    .await
    .expect("explain")
    .iter()
    .map(|r| sqlx::Row::try_get::<String, _>(r, column).expect("line"))
    .collect::<Vec<_>>()
    .join("\n");
    tx.commit().await.expect("done");
    lines
}

#[tokio::test]
async fn sealed_search_plans_use_indexes() {
    for (state, temp) in each_db_keyed("sealed_plan").await {
        let db = &state.db;
        let (sealed, _) = two_places(&state).await;
        let fill = match is_sqlite(db) {
            true => {
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) INSERT INTO messages(channel_id, author, content, body, created_at) SELECT $1, 'bob', '', x'5201', i FROM n"
            }
            false => {
                "INSERT INTO messages(channel_id, author, content, body, grams, created_at) SELECT $1, 'bob', '', '\\x5201'::bytea, ARRAY[i % 997, i % 991], i FROM generate_series(1, 5000) i"
            }
        };
        sqlx::query(fill)
            .bind(sealed)
            .execute(db)
            .await
            .expect("fill");
        sqlx::query("ANALYZE").execute(db).await.expect("analyze");
        let scope = member_scope(db, "alice").await;
        let scan = |needles: Option<String>| super::Scan::Sealed {
            lo: 1,
            hi: 4000,
            channels: format!("[{sealed}]"),
            needles,
        };
        let sq = SearchQuery {
            q: Some("needle".to_owned()),
            ..SearchQuery::default()
        };
        let mut binds = Vec::new();
        let plans = match is_sqlite(db) {
            true => {
                let (sql, more) = super::search_sql(db, &scope, sq.clone(), scan(None), 500);
                binds.push((sql, more));
                let walk = super::super::walk_sql(true, true);
                let lists = vec![
                    super::Bind::S("[[1,1,9,1]]".into()),
                    super::Bind::S("[]".into()),
                    super::Bind::S(r#"[[1,"k00000001","k#001"]]"#.into()),
                ];
                let walk = explain(db, &walk, &lists).await;
                assert_eq!(
                    walk.matches(
                        "SEARCH p USING PRIMARY KEY (stream=? AND term=? AND id>? AND id<?)"
                    )
                    .count(),
                    3,
                    "{walk}"
                );
                assert!(!walk.contains("SCAN p"), "{walk}");
                vec![]
            }
            false => {
                let needles = format!(r#"{{"{sealed}":"{{1,2}}"}}"#);
                for needles in [Some(needles), None] {
                    binds.push(super::search_sql(
                        db,
                        &scope,
                        sq.clone(),
                        scan(needles),
                        500,
                    ));
                }
                let fill = explain(
                    db,
                    crate::api::seal::WITHOUT_GRAMS,
                    &[
                        super::Bind::I(sealed),
                        super::Bind::I(0),
                        super::Bind::I(500),
                    ],
                )
                .await;
                assert!(fill.contains("idx_messages_sealed_scan"), "{fill}");
                assert!(!fill.contains("Seq Scan on messages"), "{fill}");
                vec!["idx_messages_channel_grams", "idx_messages_sealed_scan"]
            }
        };
        for (sql, more) in binds {
            let all: Vec<super::Bind> = scope
                .binds
                .iter()
                .chain(&more)
                .map(|b| match b {
                    super::Bind::S(s) => super::Bind::S(s.clone()),
                    super::Bind::I(i) => super::Bind::I(*i),
                })
                .collect();
            let plan = explain(db, &sql, &all).await;
            match is_sqlite(db) {
                true => assert!(
                    (plan.contains("idx_messages_sealed_scan")
                        || plan
                            .contains("SEARCH m USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)"))
                        && !plan.contains("SCAN m"),
                    "a window of ids or the index of encrypted rows: {plan}"
                ),
                false => {
                    for index in &plans {
                        assert!(plan.contains(index), "{plan}");
                    }
                    assert!(!plan.contains("Seq Scan on messages"), "{plan}");
                }
            }
        }
        temp.done(state).await;
    }
}

/// A record that does not open keeps no grams and stays where a search reads it, on SQLite and
/// Postgres alike: it is found again once it opens, and a later start gives it grams.
#[tokio::test]
async fn a_record_that_does_not_open_is_found_once_it_opens() {
    for (state, temp) in each_db_keyed("grams_unopened").await {
        let db = &state.db;
        let (sealed, _) = two_places(&state).await;
        let id = send(&state, sealed, "lost and found").await;
        let record: Vec<u8> = sqlx::query_scalar("SELECT body FROM messages WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("record");
        let mut damaged = record.clone();
        let last = damaged.len() - 1;
        damaged[last] ^= 1;
        sqlx::query("UPDATE messages SET body = $1, grams = NULL WHERE id = $2")
            .bind(&damaged)
            .bind(id)
            .execute(db)
            .await
            .expect("damage");
        let ring = crate::db::ring(db);
        match is_sqlite(db) {
            true => crate::db::build_channel_index(db).await.expect("merge"),
            false => {
                let before = ring.unreadable();
                assert_eq!(crate::api::seal::fill_grams(db).await.expect("fill"), 0);
                assert_eq!(crate::api::seal::fill_grams(db).await.expect("again"), 0);
                assert_eq!(ring.unreadable() - before, 1, "read once in a start");
            }
        }
        let without = format!("SELECT COUNT(*) FROM messages WHERE id = {id} AND grams IS NULL");
        assert_eq!(count(db, &without).await, 1);
        assert!(of(&hits(&state, "lost and found", None).await, "rchat").is_empty());
        sqlx::query("UPDATE messages SET body = $1 WHERE id = $2")
            .bind(&record)
            .bind(id)
            .execute(db)
            .await
            .expect("opens again");
        for q in ["lost and found", "found", "lo"] {
            assert_eq!(
                of(&hits(&state, q, None).await, "rchat"),
                ["lost and found"],
                "q={q:?}"
            );
        }
        if is_sqlite(db) {
            temp.done(state).await;
            continue;
        }
        let url = temp.url();
        crate::db::close(db).await;
        let keyed = crate::db::open_keyed(Some(&url)).await.expect("reopen");
        let instance = crate::instance::Instance::load(&keyed, &Default::default())
            .await
            .expect("instance");
        let state = AppState::new(keyed, crate::ws::Hub::new(), None, None, instance);
        let db = &state.db;
        assert_eq!(crate::api::seal::fill_grams(db).await.expect("fill"), 1);
        assert_eq!(count(db, &without).await, 0);
        assert_eq!(
            of(&hits(&state, "lost and found", None).await, "rchat"),
            ["lost and found"]
        );
        TempDb::done(temp, state).await;
    }
}

/// Every result of the search for `q`, page by page through the cursors the API hands out, as
/// (server, content), with `offset` on the first page.
async fn walk(
    state: &AppState,
    q: &str,
    server: Option<&str>,
    offset: Option<i64>,
) -> Vec<(String, String)> {
    let user = mem_user("alice", false);
    let mut out = Vec::new();
    let mut cursor = None;
    for page in 0..400 {
        let sq = SearchQuery {
            q: Some(q.to_owned()),
            server: server.map(str::to_owned),
            offset: offset.filter(|_| page == 0),
            cursor: cursor.take(),
            ..SearchQuery::default()
        };
        let (sq, resume) = super::super::screen_search(&state.read(), Some(&user), sq)
            .await
            .expect("cursor");
        let (rows, next) =
            super::super::search_screened(state, Some(&user), &HeaderMap::new(), sq, resume)
                .await
                .expect("search");
        out.extend(rows.into_iter().map(|r| (r.server, r.message.content)));
        match next {
            Some(next) => cursor = Some(next.encode()),
            None => return out,
        }
    }
    panic!("the search for {q:?} never ended");
}

/// Encrypted messages no search can open, `n` of them in `channel`.
async fn unopened(db: &Db, channel: i64, n: i64) {
    let fill = match is_sqlite(db) {
        true => {
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < $2) INSERT INTO messages(channel_id, author, content, body, created_at) SELECT $1, 'bob', '', x'5201', i FROM n"
        }
        false => {
            "INSERT INTO messages(channel_id, author, content, body, created_at) SELECT $1, 'bob', '', '\\x5201'::bytea, i FROM generate_series(1, $2) i"
        }
    };
    sqlx::query(fill)
        .bind(channel)
        .bind(n)
        .execute(db)
        .await
        .expect("unopened");
}

/// Ids jump by `by`: a message of a server nobody here is a member of on SQLite, the id
/// sequence on Postgres.
async fn id_gap(db: &Db, by: i64) {
    match is_sqlite(db) {
        true => {
            sqlx::query(
                "INSERT INTO servers(name, display_name, created_at) VALUES('far', 'Far', 0)",
            )
            .execute(db)
            .await
            .expect("far");
            sqlx::query("INSERT INTO channels(server, name, kind, created_at) VALUES('far', 'away', 'text', 0)")
                .execute(db)
                .await
                .expect("away");
            sqlx::query("INSERT INTO messages(id, channel_id, author, content, created_at) SELECT (SELECT MAX(id) FROM messages) + $1, (SELECT id FROM channels WHERE server = 'far'), 'bob', 'far away', 0")
                .bind(by)
                .execute(db)
                .await
                .expect("gap");
        }
        false => {
            sqlx::query("SELECT setval(pg_get_serial_sequence('messages', 'id'), (SELECT MAX(id) FROM messages) + $1)")
                .bind(by)
                .execute(db)
                .await
                .expect("gap");
        }
    }
}

/// Pages that mix plain and encrypted matches, over more encrypted candidates than one round
/// reads and more than one search reads in all, across a gap of ids wider than a short search
/// reads at once: every cursor walk lists what the same messages give in a plain server, once
/// each, with and without a legacy offset.
#[tokio::test]
async fn pages_of_plain_and_encrypted_matches_list_each_match_once() {
    for (state, temp) in each_db_keyed("sealed_pages").await {
        let unlimited = crate::limits::Limits {
            message_rate_burst: 0,
            ..(*state.limits).clone()
        };
        let state = state.with_limits(std::sync::Arc::new(unlimited));
        let db = &state.db;
        let (sealed, plain) = two_places(&state).await;
        let doc = |i: usize| {
            format!(
                "{} {} w{i:04}",
                if i.is_multiple_of(3) { "ab" } else { "cd" },
                if i.is_multiple_of(4) { "needle" } else { "hay" }
            )
        };
        for i in 0..300 {
            match i {
                100 => switch(&state, false).await,
                140 => switch(&state, true).await,
                200 => {
                    unopened(db, sealed, 4500).await;
                    id_gap(db, 300_000).await;
                }
                _ => {}
            }
            send(&state, plain, &doc(i)).await;
            send(&state, sealed, &doc(i)).await;
        }
        let plain_rows = count(db, "SELECT COUNT(*) FROM messages WHERE body IS NULL AND channel_id = (SELECT id FROM channels WHERE server = 'rchat' ORDER BY id LIMIT 1) AND kind = 'user'").await;
        assert_eq!(plain_rows, 40, "a stretch stored plain");
        for q in ["ab", "e", "needle", "hay", "w01"] {
            let expected: Vec<String> = (0..300).rev().map(doc).filter(|d| d.contains(q)).collect();
            assert!(expected.len() > 25, "q={q:?}");
            let club = of(&walk(&state, q, Some("club"), None).await, "club");
            assert_eq!(club, expected, "plain, q={q:?}");
            let rchat = walk(&state, q, Some("rchat"), None).await;
            assert_eq!(of(&rchat, "rchat"), expected, "encrypted, q={q:?}");
            assert_eq!(rchat.len(), expected.len(), "q={q:?}");
            let both = walk(&state, q, None, None).await;
            assert_eq!(both.len(), expected.len() * 2, "once each, q={q:?}");
            assert_eq!(of(&both, "rchat"), expected, "both, q={q:?}");
            assert_eq!(of(&both, "club"), expected, "both, q={q:?}");
            let skipped = walk(&state, q, None, Some(30)).await;
            assert_eq!(skipped, both[30..], "offset, q={q:?}");
        }
        temp.done(state).await;
    }
}

/// Terms of plain messages that are keyed terms.
const KEYED_OF_PLAIN: &str = "SELECT COUNT(*) FROM search_postings p JOIN messages m ON m.id = p.id WHERE m.body IS NULL AND (p.term GLOB 'k[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' OR p.term GLOB 'k#[0-9a-f][0-9a-f][0-9a-f]')";

async fn job(state: &AppState, direction: crate::api::seal::jobs::Direction) {
    use crate::api::seal::jobs::{Target, begin, run_job};
    let job = begin(state, &Target::Server("rchat".into()), direction, None)
        .await
        .expect("begin");
    run_job(state, job.id).await;
    let ended: String = sqlx::query_scalar("SELECT state FROM seal_jobs WHERE id = $1")
        .bind(job.id)
        .fetch_one(&state.db)
        .await
        .expect("job");
    assert_eq!(ended, "done");
}

#[tokio::test]
async fn earlier_messages_encrypted_by_a_job_are_found_the_same_with_no_plain_terms_and_back() {
    use crate::api::seal::jobs::Direction;
    for (state, temp) in each_db_keyed("job_search").await {
        let db = &state.db;
        let (sealed, plain) = two_places(&state).await;
        switch(&state, false).await;
        let mut rng = Rng(0x5eed_0007);
        let docs = corpus(&mut rng);
        for text in &docs {
            send(&state, plain, text).await;
            send(&state, sealed, text).await;
        }
        let qs = queries(&mut rng, &docs);
        if is_sqlite(db) {
            crate::db::build_channel_index(db).await.expect("merge");
        }
        let found = same_hits(&state, &qs).await;
        assert!(found > 100, "the queries find something: {found}");
        switch(&state, true).await;
        job(&state, Direction::Seal).await;
        let stored = count(db, "SELECT COUNT(*) FROM messages WHERE body IS NOT NULL").await;
        assert_eq!(stored, docs.len() as i64);
        assert_eq!(
            count(
                db,
                "SELECT COUNT(*) FROM messages WHERE body IS NOT NULL AND content <> ''"
            )
            .await,
            0
        );
        match is_sqlite(db) {
            true => {
                crate::db::build_channel_index(db).await.expect("merge");
                assert_eq!(count(db, UNKEYED).await, 0, "no plain term is left");
            }
            false => assert_eq!(
                count(
                    db,
                    "SELECT COUNT(*) FROM messages WHERE body IS NOT NULL AND grams IS NULL"
                )
                .await,
                0
            ),
        }
        assert_eq!(same_hits(&state, &qs).await, found);
        job(&state, Direction::Unseal).await;
        assert_eq!(
            count(db, "SELECT COUNT(*) FROM messages WHERE body IS NOT NULL").await,
            0
        );
        match is_sqlite(db) {
            true => {
                crate::db::build_channel_index(db).await.expect("merge");
                assert_eq!(count(db, KEYED_OF_PLAIN).await, 0, "no keyed term is left");
            }
            false => assert_eq!(
                count(
                    db,
                    "SELECT COUNT(*) FROM messages WHERE body IS NULL AND grams IS NOT NULL"
                )
                .await,
                0
            ),
        }
        assert_eq!(same_hits(&state, &qs).await, found);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_search_key_rotation_finds_the_same_before_during_and_after() {
    use crate::crypt::Purpose;
    crate::api::seal::rotate::SETTLE.store(0, std::sync::atomic::Ordering::Relaxed);
    for (state, temp) in each_db_keyed("rotate_search").await {
        let db = &state.db;
        let (docs, qs) = corpus_in_both(&state, 0x5eed_0009).await;
        if is_sqlite(db) {
            crate::db::build_channel_index(db).await.expect("merge");
        }
        let found = same_hits(&state, &qs).await;
        assert!(found > 100, "the queries find something: {found}");
        let ring = crate::db::ring(db);
        ring.rotate(db, Purpose::Search)
            .await
            .expect("rotate")
            .expect("a new key");
        assert!(ring.rotating(Purpose::Search));
        assert_eq!(
            same_hits(&state, &qs).await,
            found,
            "while nothing is keyed again yet"
        );
        crate::api::seal::rotate::begin(&state, &[Purpose::Search])
            .await
            .expect("begin");
        assert!(crate::api::seal::rotate::run(&state).await.expect("run"));
        assert!(!ring.rotating(Purpose::Search));
        if is_sqlite(db) {
            crate::db::build_channel_index(db).await.expect("merge");
            assert_eq!(count(db, UNKEYED).await, 0, "only keyed terms");
        }
        assert_eq!(same_hits(&state, &qs).await, found, "after");
        let sealed = count(db, "SELECT COUNT(*) FROM messages WHERE body IS NOT NULL").await;
        assert_eq!(sealed, docs.len() as i64);
        temp.done(state).await;
    }
}
