use super::*;
use crate::api::test_util::{TempDb, each_db_keyed};

/// What the row of report `id` holds: its plain snapshot, answers and note, and whether it has
/// a record.
async fn stored(db: &Db, id: i64) -> (String, String, Option<String>, bool) {
    let row = sqlx::query("SELECT snapshot, answers, note, sealed FROM reports WHERE id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("report");
    (
        row.try_get(0).expect("snapshot"),
        row.try_get(1).expect("answers"),
        row.try_get(2).expect("note"),
        row.try_get::<Option<Vec<u8>>, _>(3)
            .expect("record")
            .is_some(),
    )
}

/// The history lines of report `id`: their plain detail and whether each has a record.
async fn lines(db: &Db, id: i64) -> Vec<(String, String, bool)> {
    sqlx::query(
        "SELECT kind, detail, detail_sealed FROM report_events WHERE report_id = $1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(db)
    .await
    .expect("events")
    .iter()
    .map(|r| {
        (
            r.try_get(0).expect("kind"),
            r.try_get(1).expect("detail"),
            r.try_get::<Option<Vec<u8>>, _>(2)
                .expect("record")
                .is_some(),
        )
    })
    .collect()
}

async fn switch(w: &World, on: bool) {
    crate::api::servers::update_server(
        State(w.state.clone()),
        Authed(who(w.db(), "olga").await),
        Path("s".to_string()),
        Json(serde_json::from_value(json!({"seal": on})).expect("patch")),
    )
    .await
    .map(|_| ())
    .expect("switch");
}

async fn note(w: &World, by: &str, id: i64, text: &str) {
    add_note(
        State(w.state.clone()),
        Authed(who(w.db(), by).await),
        Path(id),
        Json(NoteBody {
            text: text.to_string(),
        }),
    )
    .await
    .map(|_| ())
    .expect("note");
}

/// A report by alice of the message `id`, `n` times eight days after `T0`, so no cap on reports
/// is met.
async fn report_message(w: &World, id: i64, details: &str, n: i64) -> i64 {
    w.send(
        "alice",
        json!({"to": "server", "target": {"kind": "message", "id": id}, "reason": "spam", "form": "message", "answers": [{"id": "details", "value": details}]}),
        T0 + n * 8 * DAY,
    )
    .await
    .expect("report")
    .id
}

fn shown(detail: &ReportDetail) -> (String, String, String) {
    let content = detail
        .snapshot
        .message
        .as_ref()
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let answer = detail
        .answers
        .first()
        .and_then(|a| a.value.as_str())
        .unwrap_or_default()
        .to_string();
    (content, answer, detail.report.excerpt.clone())
}

#[tokio::test]
async fn report_copies_follow_the_place_they_come_from() {
    for (state, temp) in each_db_keyed("reports_sealed").await {
        let w = fill(state).await;
        let db = w.db();
        let plain_said = message(db, w.general, "bob", "plain coins", 100).await;
        let before = report_message(&w, plain_said, "seen before", 1).await;
        assert!(!stored(db, before).await.3, "a report from a plain place");
        assert!(stored(db, before).await.0.contains("plain coins"));

        switch(&w, true).await;
        let said = message(db, w.general, "bob", "sealed coins", 200).await;
        let id = report_message(&w, said, "seen while sealed", 2).await;
        assert_eq!(
            stored(db, id).await,
            ("{}".to_string(), "[]".to_string(), None, true),
            "only the record holds the text"
        );
        let detail = w.detail("mo", id).await.expect("detail");
        assert_eq!(
            shown(&detail),
            (
                "sealed coins".to_string(),
                "seen while sealed".to_string(),
                "sealed coins".to_string()
            )
        );
        assert_eq!(detail.snapshot.channel.as_deref(), Some("general"));
        let listed = w.listed("mo", json!({})).await.expect("list");
        let excerpts: Vec<&str> = listed.iter().map(|r| r.excerpt.as_str()).collect();
        assert_eq!(excerpts, ["sealed coins", "plain coins"]);

        note(&w, "mo", id, "looking at it").await;
        note(&w, "mo", before, "the place is sealed now").await;
        for report in [id, before] {
            let kinds: Vec<(String, String, bool)> = lines(db, report).await;
            assert_eq!(
                kinds.last().cloned(),
                Some(("note".to_string(), "{}".to_string(), true)),
                "a note follows the place when it is written"
            );
        }
        let history = w.detail("mo", id).await.expect("detail").events;
        assert_eq!(
            history.last().map(|e| e.detail.clone()),
            Some(json!({"text": "looking at it"}))
        );
        assert!(
            !stored(db, before).await.3,
            "the earlier report stays plain"
        );

        let escalated = escalate(
            State(w.state.clone()),
            Authed(who(db, "mo").await),
            Path(id),
            Json(EscalateBody {
                note: Some("for the site".to_string()),
            }),
        )
        .await
        .expect("escalate")
        .0;
        assert!(escalated.report.escalated);
        let copy = int(
            db,
            &format!("SELECT escalated_to FROM reports WHERE id = {id}"),
        )
        .await;
        assert_eq!(
            stored(db, copy).await,
            ("{}".to_string(), "[]".to_string(), None, true)
        );
        let at_site = w.detail("root", copy).await.expect("the copy");
        assert_eq!(
            shown(&at_site),
            shown(&w.detail("mo", id).await.expect("detail"))
        );
        assert_eq!(
            at_site.events.last().map(|e| e.detail.clone()),
            Some(json!({"from": id, "note": "for the site"}))
        );
        assert!(
            lines(db, copy).await.iter().all(|(kind, detail, sealed)| {
                kind != "escalate" || (detail == "{}" && *sealed)
            })
        );

        switch(&w, false).await;
        let after_said = message(db, w.general, "bob", "plain again", 300).await;
        let after = report_message(&w, after_said, "seen after", 3).await;
        assert!(!stored(db, after).await.3, "off again: plain");
        note(&w, "mo", id, "still sealed").await;
        assert_eq!(
            lines(db, id).await.last().map(|(_, _, sealed)| *sealed),
            Some(true),
            "a note on a sealed report stays sealed"
        );
        note(&w, "mo", after, "plain note").await;
        assert_eq!(
            lines(db, after).await.last().cloned(),
            Some((
                "note".to_string(),
                r#"{"text":"plain note"}"#.to_string(),
                false
            ))
        );

        let mut conn = db.acquire().await.expect("conn");
        forget_user(db, &mut conn, "bob").await.expect("forget");
        drop(conn);
        for report in [id, copy] {
            assert_eq!(
                stored(db, report).await,
                ("{}".to_string(), "[]".to_string(), None, true),
                "forgetting an account keeps a sealed report sealed"
            );
        }
        for (by, report) in [("mo", id), ("root", copy)] {
            let detail = w.detail(by, report).await.expect("detail");
            let author = detail.snapshot.message.and_then(|m| m.author);
            assert_eq!(
                author,
                Some(SnapUser {
                    deleted: true,
                    ..SnapUser::default()
                }),
                "a deleted account leaves sealed reports too"
            );
        }
        TempDb::done(temp, w.state).await;
    }
}

#[tokio::test]
async fn a_report_record_opens_only_for_its_row() {
    for (state, temp) in each_db_keyed("reports_sealed_rows").await {
        let w = fill(state).await;
        let db = w.db();
        switch(&w, true).await;
        let one = message(db, w.general, "bob", "first words", 100).await;
        let two = message(db, w.general, "carol", "second words", 200).await;
        let first = report_message(&w, one, "one", 4).await;
        let second = report_message(&w, two, "two", 5).await;
        sqlx::query(
            "UPDATE reports SET sealed = (SELECT sealed FROM reports WHERE id = $1) WHERE id = $2",
        )
        .bind(first)
        .bind(second)
        .execute(db)
        .await
        .expect("move");
        let moved = w.detail("mo", second).await.expect("detail");
        assert_eq!(
            shown(&moved),
            (String::new(), String::new(), String::new()),
            "a record moved to another report reads as blank"
        );
        assert_eq!(
            shown(&w.detail("mo", first).await.expect("detail")).0,
            "first words"
        );
        let refused = escalate(
            State(w.state.clone()),
            Authed(who(db, "mo").await),
            Path(second),
            Json(EscalateBody { note: None }),
        )
        .await
        .map(|_| ());
        assert_eq!(
            refused.map_err(|e| (e.0, e.1)),
            Err((
                StatusCode::BAD_REQUEST,
                super::super::text::UNREADABLE.to_string()
            )),
            "a report that does not open is never escalated as a blank copy"
        );
        assert_eq!(
            int(
                db,
                &format!("SELECT COALESCE(escalated_to, 0) FROM reports WHERE id = {second}")
            )
            .await,
            0
        );
        assert_eq!(
            int(db, "SELECT COUNT(*) FROM reports WHERE kind = 'instance'").await,
            0
        );
        TempDb::done(temp, w.state).await;
    }
}

#[tokio::test]
async fn a_report_from_a_dm_follows_the_dm() {
    for (state, temp) in each_db_keyed("reports_sealed_dm").await {
        let w = fill(state).await;
        let db = w.db();
        let dm = int(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        let said = |n: i64, text: &'static str| async move {
            int(
                db,
                &format!("INSERT INTO messages(dm_id, author, content, created_at) VALUES({dm}, 'bob', '{text}', {n}) RETURNING id"),
            )
            .await
        };
        let switch = |on: bool| {
            let state = w.state.clone();
            async move {
                crate::api::seal::put_dm_seal(
                    State(state),
                    Authed(crate::api::test_util::mem_user("alice", false)),
                    Path(dm),
                    Json(crate::api::seal::SealReq { on }),
                )
                .await
                .map(|_| ())
                .expect("dm switch");
            }
        };
        let report = |id: i64, n: i64| {
            let w = &w;
            async move {
                w.send(
                    "alice",
                    json!({"to": "instance", "target": {"kind": "message", "id": id}, "reason": "harassment"}),
                    T0 + n * 8 * DAY,
                )
                .await
                .expect("report")
                .id
            }
        };
        switch(true).await;
        let sealed_said = said(100, "sealed dm words").await;
        let sealed = report(sealed_said, 1).await;
        assert_eq!(
            stored(db, sealed).await,
            ("{}".to_string(), "[]".to_string(), None, true),
            "a report of a DM that seals is stored sealed"
        );
        let at_site = w.detail("root", sealed).await.expect("detail");
        assert_eq!(shown(&at_site).0, "sealed dm words");
        switch(false).await;
        let plain_said = said(200, "plain dm words").await;
        let plain = report(plain_said, 2).await;
        assert!(!stored(db, plain).await.3, "off again: plain");
        assert!(stored(db, plain).await.0.contains("plain dm words"));
        TempDb::done(temp, w.state).await;
    }
}
