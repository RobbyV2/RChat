use crate::db::Db;

pub(crate) const STAFF_NAME: &str = "instance staff";

/// Characters a name may not hold: control, format (zero-width, bidi, soft hyphen), line and
/// paragraph separators, and the invisible fillers that render as nothing.
pub(crate) fn hidden_char(c: char) -> bool {
    use unicode_properties::{GeneralCategory, UnicodeGeneralCategory};
    matches!(
        c.general_category(),
        GeneralCategory::Control
            | GeneralCategory::Format
            | GeneralCategory::LineSeparator
            | GeneralCategory::ParagraphSeparator
            | GeneralCategory::PrivateUse
            | GeneralCategory::Surrogate
            | GeneralCategory::Unassigned
    ) || matches!(
        c as u32,
        0x34f | 0x115f | 0x1160 | 0x17b4 | 0x17b5 | 0x180b..=0x180f | 0x2800 | 0x3164 | 0xffa0
    )
}

/// What a name looks like, for comparing names: NFKC, variation selectors dropped, full case
/// folding, whitespace collapsed, then the UTS #39 confusable skeleton (folded again), so
/// `ALICE` in fullwidth letters, a Cyrillic a (U+0430) or a no-break space all match the plain
/// name.
pub fn name_key(name: &str) -> String {
    name_keys(name)[1].clone()
}

/// The version of `name_keys`. Usernames are stored with their keys, so raise this with any
/// change to `name_keys` or to the exactly pinned Unicode crates it uses (`Cargo.toml`): every
/// stored key is then made again at the next start.
pub(crate) const KEY_VERSION: u32 = 1;

/// The keys two names are compared by: lookalike skeletons taken both before and after case
/// folding (capital I passes for l only before folding), with combining marks dropped so a
/// mark stacked on a letter cannot hide the match. Two names clash when any keys are equal.
pub fn name_keys(name: &str) -> [String; 2] {
    use unicode_normalization::UnicodeNormalization;
    use unicode_normalization::char::is_combining_mark;
    let fold = |s: &str| {
        caseless::default_case_fold_str(s)
            .nfkc()
            .filter(|c| !matches!(*c as u32, 0xfe00..=0xfe0f | 0xe0100..=0xe01ef))
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let bare: String = name.nfkd().filter(|c| !is_combining_mark(*c)).collect();
    let skeleton = |s: &str| unicode_security::skeleton(s).collect::<String>();
    [
        fold(&skeleton(&bare.nfkc().collect::<String>())),
        fold(&skeleton(&fold(&bare))),
    ]
}

pub(crate) fn names_clash(a: &[String; 2], b: &[String; 2]) -> bool {
    a.iter().any(|x| b.contains(x))
}

/// Whether `name` passes for the instance staff, compared by `name_keys`.
pub(crate) fn passes_for_staff(name: &str) -> bool {
    names_clash(&name_keys(name), &name_keys(STAFF_NAME))
}

/// The `name_keys` of a username as `users` stores them: `username_key`, and `username_key_alt`
/// when the other key differs.
pub(crate) fn username_keys(username: &str) -> (String, Option<String>) {
    let [alt, key] = name_keys(username);
    let alt = Some(alt).filter(|alt| *alt != key);
    (key, alt)
}

pub(crate) const OTHER_USERNAME_SQL: &str = "SELECT 1 FROM users WHERE username_key IN ($1, $2) AND username <> $3 UNION ALL SELECT 1 FROM users WHERE username_key_alt IN ($1, $2) AND username <> $3 LIMIT 1";

/// Whether `name` passes for the username of an account other than `me`, compared by
/// `name_keys` through the stored keys.
pub(crate) async fn passes_for_another(db: &Db, name: &str, me: &str) -> sqlx::Result<bool> {
    let [a, b] = name_keys(name);
    Ok(sqlx::query(OTHER_USERNAME_SQL)
        .bind(a)
        .bind(b)
        .bind(me)
        .fetch_optional(db)
        .await?
        .is_some())
}

#[cfg(test)]
mod tests {
    use sqlx::Row;

    use super::*;
    use crate::api::test_util::{done, pg_done, pg_state, temp_state};
    use crate::db::is_sqlite;

    #[test]
    fn usernames_are_stored_under_one_or_two_keys() {
        let stored = |name: &str| {
            let (key, alt) = username_keys(name);
            (key, alt.unwrap_or_default())
        };
        for (name, key, alt) in [
            ("alice", "alice", ""),
            ("b\u{43e}b", "bob", ""),
            ("b0b", "bob", ""),
            ("mom", "rnorn", ""),
            ("\u{2110}an", "ian", "lan"),
        ] {
            assert_eq!(stored(name), (key.to_string(), alt.to_string()), "{name}");
        }
    }

    fn repo() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    /// The text files under `dir` that can hold SQL, as (path from `root`, text).
    fn sources(dir: &std::path::Path, root: &std::path::Path, found: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries {
            let path = entry.expect("entry").path();
            let ext = path.extension().and_then(|e| e.to_str());
            if path.is_dir() {
                sources(&path, root, found);
            } else if matches!(ext, Some("rs" | "sql" | "ts" | "mjs" | "py" | "sh")) {
                let file = path.strip_prefix(root).expect("under the repo");
                let text = std::fs::read_to_string(&path).expect("read");
                found.push((file.to_string_lossy().replace('\\', "/"), text));
            }
        }
    }

    /// An insert into `users` however it is spelled: `OR IGNORE`, a quoted or schema-qualified
    /// table, any case and line breaks.
    fn users_insert() -> regex::Regex {
        regex::Regex::new(r#"(?i)\binsert\b[^;]*?\binto\s+(?:"?\w+"?\.)?"?users"?\b"#)
            .expect("pattern")
    }

    #[test]
    fn the_insert_scan_sees_every_spelling() {
        let insert = users_insert();
        // `{t}` stands for the table, so the scan below does not find these lines.
        for sql in [
            "INSERT INTO {t}(username) VALUES ($1)",
            "insert into {t} (username) values ($1)",
            "INSERT INTO {t} (username) VALUES ($1) ON CONFLICT DO NOTHING",
            "INSERT OR IGNORE INTO {t}(username) VALUES ($1)",
            "INSERT INTO \"{t}\"(username) VALUES ($1)",
            "INSERT INTO public.{t}(username) VALUES ($1)",
            "INSERT INTO \"public\".\"{t}\" (username) VALUES ($1)",
            "INSERT\n  INTO {t} (username)\n  VALUES ($1)",
        ] {
            let sql = sql.replace("{t}", "users");
            assert!(insert.is_match(&sql), "{sql}");
        }
        for sql in [
            "INSERT INTO users_settings(username) VALUES ($1)",
            "INSERT INTO \"users_x\"(username) VALUES ($1)",
            "INSERT INTO servers(name) VALUES ($1); SELECT * FROM users",
            "set.insert(name); let into = 1; users",
        ] {
            assert!(!insert.is_match(sql), "{sql}");
        }
    }

    /// Every account row is written by `db::insert_user`, which stores the keys: tests too
    /// (`NewUser::plain(..).add(..)`). SQL files write `username_key` themselves.
    #[test]
    fn accounts_are_only_inserted_with_their_keys() {
        let insert = users_insert();
        let root = repo();
        let mut found = Vec::new();
        for dir in ["apps/server", "crates", "scripts", "deploy"] {
            sources(&root.join(dir), &root, &mut found);
        }
        assert!(found.len() > 100, "the scan reads the source");
        let mut helper = 0;
        let mut other = Vec::new();
        for (file, text) in &found {
            for at in insert.find_iter(text) {
                let line = text[..at.start()].matches('\n').count() + 1;
                let statement = text[at.start()..].split(';').next().unwrap_or_default();
                match file.as_str() {
                    "apps/server/src/db/mod.rs" => helper += 1,
                    // Rows of databases from before the columns, and rows without keys on purpose.
                    "apps/server/src/db/tests.rs" => {}
                    _ if file.ends_with(".sql") && statement.contains("username_key") => {}
                    _ => other.push(format!("{file}:{line}")),
                }
            }
        }
        assert_eq!(helper, 1, "db::insert_user is the one insert");
        assert_eq!(other, Vec::<String>::new(), "use db::insert_user");
    }

    #[test]
    fn the_load_seed_stores_the_keys_of_its_usernames() {
        let seed = std::fs::read_to_string(repo().join("scripts/load/seed.sql")).expect("seed");
        assert!(seed.contains("translate('u' || lpad(i::text, 5, '0'), '01', 'ol')"));
        for i in 0..5000 {
            let name = format!("u{i:05}");
            let key = name.replace('0', "o").replace('1', "l");
            assert_eq!(username_keys(&name), (key, None), "{name}");
        }
    }

    async fn lookup_plan(db: &Db) -> String {
        let sql = OTHER_USERNAME_SQL
            .replace("$1", "'a'")
            .replace("$2", "'b'")
            .replace("$3", "'c'");
        let mut tx = db.begin().await.expect("begin");
        let (explain, column) = match is_sqlite(db) {
            true => ("EXPLAIN QUERY PLAN", 3),
            false => {
                sqlx::query("SET LOCAL enable_seqscan = off")
                    .execute(&mut *tx)
                    .await
                    .expect("no scans where an index works");
                ("EXPLAIN", 0)
            }
        };
        sqlx::query(sqlx::AssertSqlSafe(format!("{explain} {sql}")))
            .fetch_all(&mut *tx)
            .await
            .expect("explain")
            .iter()
            .map(|r| r.try_get::<String, _>(column).expect("plan line"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    async fn another_username_is_looked_up_by_key(db: &Db) {
        for name in ["alice", "b\u{43e}b", "\u{2110}an"] {
            crate::db::NewUser::plain(name).at(1).add(db).await;
        }
        for (name, me, taken) in [
            ("Alice", "carol", true),
            ("AIice", "carol", true),
            ("alice", "alice", false),
            ("Bob", "carol", true),
            ("Ian", "carol", true),
            ("lan", "carol", true),
            ("lan", "\u{2110}an", false),
            ("Alicia", "carol", false),
        ] {
            assert_eq!(
                passes_for_another(db, name, me).await.expect("lookup"),
                taken,
                "{name} for {me}"
            );
        }
        let plan = lookup_plan(db).await;
        let (all, alt) = (
            plan.matches("idx_users_username_key").count(),
            plan.matches("idx_users_username_key_alt").count(),
        );
        assert!(alt > 0 && all > alt, "both indexes:\n{plan}");
        assert!(
            !plan.contains("SCAN users") && !plan.contains("Seq Scan"),
            "no scan over the accounts:\n{plan}"
        );
    }

    #[tokio::test]
    async fn another_username_is_found_through_the_key_indexes() {
        let (state, path) = temp_state("names_lookup").await;
        another_username_is_looked_up_by_key(&state.db).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("names_lookup").await {
            another_username_is_looked_up_by_key(&state.db).await;
            pg_done(state, pg).await;
        }
    }

    #[test]
    fn name_keys_see_through_lookalikes() {
        for (a, b) in [
            ("ＡＬＩＣＥ", "alice"),
            ("\u{430}lice", "alice"),
            ("Instance\u{a0}staff", "instance staff"),
            ("Instance   Staff", "instance staff"),
            ("ÉLODIE", "élodie"),
            ("E\u{301}lodie", "élodie"),
            ("0wner", "owner"),
            ("STRASSE", "straße"),
        ] {
            assert_eq!(name_key(a), name_key(b), "{a} vs {b}");
        }
        assert_ne!(name_key("alice"), name_key("alicia"));
        for (a, b) in [
            ("AIice", "alice"),
            ("lan", "Ian"),
            ("BiII", "Bill"),
            ("OIivia", "Olivia"),
            ("ali\u{307}ce", "alice"),
            ("A\u{301}lice", "alice"),
        ] {
            assert!(names_clash(&name_keys(a), &name_keys(b)), "{a} vs {b}");
        }
        assert!(!names_clash(&name_keys("alice"), &name_keys("alicia")));
        for c in [
            '\u{200b}', '\u{200d}', '\u{2060}', '\u{feff}', '\u{ad}', '\u{202e}', '\u{2028}',
            '\u{3164}', '\t',
        ] {
            assert!(hidden_char(c), "{:?}", c);
        }
        for c in ['a', ' ', 'é', '☕', '\u{fe0f}'] {
            assert!(!hidden_char(c), "{:?}", c);
        }
    }
}
