use std::collections::HashMap;

use rchat_perms::eval::{self, Channel, Mode, Ow, Who};
use rchat_perms::rules::HOSTED;
use rchat_perms::{Mask, masks};
use serde::Deserialize;
use serde_json::Value;
use sqlx::Row;

use super::overwrite_sql::overwrite_sql;
use super::perms::VISITOR_CAPS;
use super::perms::{
    ChannelAccess, EVERYONE, PermRow, Restrict, Standing, allow_lists, channel_mask, everyone_mask,
    perm_columns, perm_row, rule_narrows,
};
use super::rules::{channel_access_within, channel_viewers, standing};
use super::{
    Proof, member_channel_rights, resolve_channel, resolve_server, ws_channel_policy,
    ws_view_rules, ws_view_under,
};
use crate::api::test_util::{add_member, each_db, mem_user};
use crate::db::{Db, NewUser, User};

const V: Mask = masks::VIEW;
const S: Mask = masks::SEND;
const H: Mask = masks::HISTORY;
const OPEN: Mask = masks::BASE & masks::CHANNEL;
const SERVER: &str = "ow";

async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn id_of(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
        .try_get(0)
        .expect("id")
}

/// A rule as a fixture writes it: the three flags alone, or masks.
#[derive(Clone, Copy)]
enum Rule {
    Flags(bool, bool, bool),
    Masks(Mask, Mask, bool),
}

impl Rule {
    fn row(self, subject: &str) -> PermRow {
        match self {
            Rule::Flags(view, send, history) => PermRow {
                subject: subject.to_string(),
                view,
                send,
                history,
                allow: 0,
                deny: 0,
                merge: false,
            },
            Rule::Masks(allow, deny, merge) => PermRow {
                subject: subject.to_string(),
                view: true,
                send: true,
                history: true,
                allow: allow as i64,
                deny: deny as i64,
                merge,
            },
        }
    }

    async fn insert(self, db: &Db, channel: i64, subject: &str) {
        let sql = match self {
            Rule::Flags(view, send, history) => format!(
                "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({channel}, '{subject}', {}, {}, {})",
                i64::from(view),
                i64::from(send),
                i64::from(history)
            ),
            Rule::Masks(allow, deny, merge) => format!(
                "INSERT INTO channel_perms(channel_id, subject, allow, deny, mode) VALUES({channel}, '{subject}', {allow}, {deny}, '{}')",
                match merge {
                    true => "merge",
                    false => "override",
                }
            ),
        };
        exec(db, &sql).await;
    }
}

struct Place {
    name: &'static str,
    voice: bool,
    restrict: Restrict,
    rules: Vec<(&'static str, Rule)>,
}

fn place(name: &'static str, flags: u8, rules: &[(&'static str, Rule)]) -> Place {
    Place {
        name,
        voice: flags & 4 != 0,
        restrict: Restrict {
            view: flags & 1 != 0,
            send: flags & 2 != 0,
        },
        rules: rules.to_vec(),
    }
}

/// Channels with every kind of rule. Subjects name the roles `ra`, `rb`, `rs` and accounts.
fn places(flags_only: bool) -> Vec<Place> {
    use Rule::{Flags, Masks};
    let mut out = vec![
        place("open", 0, &[]),
        place("private", 1, &[]),
        place("quiet", 2, &[]),
        place("shut", 3, &[]),
        place("talk", 4, &[]),
        place("talk_quiet", 6, &[]),
        place("role_in", 1, &[("ra", Flags(true, true, true))]),
        place("role_reads", 0, &[("ra", Flags(true, false, true))]),
        place("role_out", 0, &[("ra", Flags(false, false, false))]),
        place("role_recent", 0, &[("ra", Flags(true, true, false))]),
        place(
            "two_roles",
            3,
            &[
                ("ra", Flags(true, false, true)),
                ("rb", Flags(false, true, true)),
            ],
        ),
        place("own_recent", 1, &[("u:plain", Flags(true, true, false))]),
        place(
            "own_and_role",
            0,
            &[
                ("u:a", Flags(false, true, true)),
                ("ra", Flags(true, true, true)),
            ],
        ),
        place("outsider_in", 1, &[("u:out", Flags(true, true, false))]),
        place("outsider_out", 0, &[("u:out", Flags(false, false, false))]),
        place("nobody_holds_it", 1, &[("r:0", Flags(true, true, true))]),
        place("talk_role", 5, &[("ra", Flags(true, false, true))]),
    ];
    if flags_only {
        return out;
    }
    let pin = rchat_perms::registry::value("PinMessages");
    let delete = rchat_perms::registry::value("DeleteMessages");
    out.extend([
        place("all_quiet", 0, &[(EVERYONE, Masks(0, S, false))]),
        place("all_in_private", 1, &[(EVERYONE, Masks(V, 0, false))]),
        place(
            "all_out_role_in",
            0,
            &[(EVERYONE, Masks(0, V, false)), ("ra", Masks(V, 0, false))],
        ),
        place(
            "allow_beats_deny",
            0,
            &[("ra", Masks(0, S, false)), ("rb", Masks(S, 0, false))],
        ),
        place(
            "own_overrides",
            0,
            &[("u:ab", Masks(0, S, false)), ("rb", Masks(S, 0, false))],
        ),
        place(
            "own_merges",
            0,
            &[("u:ab", Masks(0, S, true)), ("rb", Masks(S, 0, false))],
        ),
        place("role_recent_mask", 0, &[("ra", Masks(0, H, false))]),
        place(
            "all_recent_own_whole",
            0,
            &[
                (EVERYONE, Masks(0, H, false)),
                ("u:plain", Masks(H, 0, false)),
            ],
        ),
        place("role_pins", 0, &[("ra", Masks(pin, 0, false))]),
        place("no_deleting", 0, &[(EVERYONE, Masks(0, delete, false))]),
        place("outsider_in_mask", 1, &[("u:out", Masks(V, 0, false))]),
        place("outsider_out_mask", 0, &[("u:out", Masks(0, V, true))]),
        place("all_by_flags", 0, &[(EVERYONE, Flags(false, true, true))]),
        place(
            "role_send_in_quiet",
            2,
            &[("rs", Masks(S, 0, false)), ("ra", Masks(0, V, false))],
        ),
        place("talk_all_out", 4, &[(EVERYONE, Masks(0, S | V, false))]),
    ]);
    out
}

struct Person {
    name: &'static str,
    roles: &'static [&'static str],
    admin: Option<i64>,
    site_admin: bool,
    member: bool,
}

const PEOPLE: [Person; 10] = [
    person("plain", &[], None, false, true),
    person("a", &["ra"], None, false, true),
    person("ab", &["ra", "rb"], None, false, true),
    person("s", &["rs"], None, false, true),
    person("mgr", &["rm"], None, false, true),
    person("modr", &["rd", "ra"], None, false, true),
    person("adm", &["ra"], Some(4), false, true),
    person("full", &[], Some(0), false, true),
    person("site", &["ra"], None, true, true),
    person("out", &[], None, false, false),
];

const fn person(
    name: &'static str,
    roles: &'static [&'static str],
    admin: Option<i64>,
    site_admin: bool,
    member: bool,
) -> Person {
    Person {
        name,
        roles,
        admin,
        site_admin,
        member,
    }
}

struct World {
    roles: HashMap<&'static str, (i64, i64)>,
    channels: Vec<(i64, Place)>,
}

impl World {
    fn subject(&self, name: &str) -> String {
        match self.roles.get(name) {
            Some((id, _)) => format!("r:{id}"),
            None => name.to_string(),
        }
    }

    fn rows(&self, place: &Place) -> Vec<PermRow> {
        place
            .rules
            .iter()
            .map(|(subject, rule)| rule.row(&self.subject(subject)))
            .collect()
    }

    /// The viewer as the shared rules read them, from this fixture alone.
    fn who(&self, person: Option<&Person>, caps: Mask) -> (Who, Vec<String>) {
        let Some(p) = person else {
            return (
                Who::Visitor {
                    signed_in: false,
                    caps,
                },
                Vec::new(),
            );
        };
        let mut subjects = vec![format!("u:{}", p.name)];
        let mut bits = 0;
        for role in p.roles {
            let (id, perms) = self.roles[role];
            subjects.push(format!("r:{id}"));
            bits |= perms as Mask;
        }
        let who = match (p.site_admin, p.member, p.admin) {
            (true, _, _) => Who::Staff,
            (false, false, _) => Who::Visitor {
                signed_in: true,
                caps,
            },
            (false, true, Some(mask)) => Who::Admin {
                mask: mask as Mask,
                roles: bits,
            },
            (false, true, None) => Who::Member { roles: bits },
        };
        (who, subjects)
    }

    /// What the shared rules give, evaluated on this fixture alone.
    fn expected(&self, place: &Place, person: Option<&Person>, everyone: Mask, caps: Mask) -> Mask {
        let (who, subjects) = self.who(person, caps);
        let visitor = matches!(
            who,
            Who::Visitor {
                signed_in: _,
                caps: _
            }
        );
        let (mut all, mut roles, mut member) = (None, Vec::new(), None);
        for row in self.rows(place) {
            let (ow, mode) = row.evaluated();
            match row.subject.as_str() {
                EVERYONE => all = Some(ow),
                s if s.starts_with("u:") && subjects.iter().any(|x| x == s) => {
                    member = Some((ow, mode))
                }
                s if !visitor && subjects.iter().any(|x| x == s) => roles.push(ow),
                _ => {}
            }
        }
        let Restrict { view, send } = place.restrict;
        let channel = Channel {
            everyone: all,
            restrict_view: view,
            restrict_send: send,
            voice: place.voice,
            roles: &roles,
            member,
        };
        eval::channel_mask(&who, everyone, &channel, false, false, &HOSTED)
    }
}

async fn world(db: &Db, flags_only: bool) -> World {
    exec(db, "INSERT INTO servers(name, display_name, creator, created_at, public_read) VALUES('ow', 'Ow', 'full', 0, 1)").await;
    let mut roles = HashMap::new();
    let manage = masks::MANAGE_CHANNELS as i64;
    for (name, perms) in [
        ("ra", 0),
        ("rb", 0),
        ("rs", (S | V) as i64),
        ("rm", manage),
        ("rd", 2),
    ] {
        let id = id_of(db, &format!("INSERT INTO roles(server, name, color, perms) VALUES('ow', '{name}', '#ffffff', {perms}) RETURNING id")).await;
        roles.insert(name, (id, perms));
    }
    for p in &PEOPLE {
        NewUser::plain(p.name).at(1).add(db).await;
        if p.site_admin {
            exec(
                db,
                &format!(
                    "UPDATE users SET is_site_admin = 1 WHERE username = '{}'",
                    p.name
                ),
            )
            .await;
        }
        if !p.member {
            continue;
        }
        let (is_admin, perms) = match p.admin {
            Some(mask) => (1, mask),
            None => (0, 0),
        };
        add_member(db, SERVER, p.name, is_admin, perms, 10).await;
        for role in p.roles {
            exec(
                db,
                &format!(
                    "INSERT INTO user_roles(server, username, role_id) VALUES('ow', '{}', {})",
                    p.name, roles[role].0
                ),
            )
            .await;
        }
    }
    let mut out = World {
        roles,
        channels: Vec::new(),
    };
    for place in places(flags_only) {
        let kind = match place.voice {
            true => "voice",
            false => "text",
        };
        let id = id_of(db, &format!("INSERT INTO channels(server, name, kind, created_at, restrict_view, restrict_send) VALUES('ow', '{}', '{kind}', 0, {}, {}) RETURNING id", place.name, i64::from(place.restrict.view), i64::from(place.restrict.send))).await;
        for (subject, rule) in &place.rules {
            rule.insert(db, id, &out.subject(subject)).await;
        }
        out.channels.push((id, place));
    }
    out
}

fn user_of(person: Option<&Person>) -> Option<User> {
    person.map(|p| mem_user(p.name, p.site_admin))
}

fn vsh(mask: Mask) -> [bool; 3] {
    let ChannelAccess {
        view,
        send,
        history,
        mask: _,
    } = ChannelAccess::of(mask);
    [view, send, history]
}

/// One SQL condition of the generator per channel of the server, for the viewer bound as `$2`.
async fn holds(db: &Db, bit: Mask, viewer: Option<&str>) -> HashMap<i64, bool> {
    let sql = format!(
        "SELECT c.id, CASE WHEN {} THEN 1 ELSE 0 END FROM channels c WHERE c.server = $1",
        overwrite_sql(bit, viewer.map(|_| "$2"))
    );
    let query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(SERVER);
    let query = match viewer {
        Some(name) => query.bind(name.to_string()),
        None => query,
    };
    query
        .fetch_all(db)
        .await
        .expect("holds")
        .iter()
        .map(|r| {
            (
                r.try_get(0).expect("id"),
                r.try_get::<i64, _>(1).expect("held") != 0,
            )
        })
        .collect()
}

/// Every path that answers what someone holds in a channel, against the shared rules.
async fn paths_agree(db: &Db, w: &World, stored: Option<i64>, model: bool) {
    match stored {
        Some(bits) => exec(db, &format!("UPDATE servers SET everyone_perms = {bits}")).await,
        None => exec(db, "UPDATE servers SET everyone_perms = NULL").await,
    }
    let everyone = everyone_mask(stored);
    let viewers: Vec<Option<&Person>> = PEOPLE.iter().map(Some).chain([None]).collect();
    let members: Vec<String> = PEOPLE
        .iter()
        .filter(|p| p.member)
        .map(|p| p.name.to_string())
        .collect();
    for viewer in &viewers {
        let name = viewer.map_or("guest", |p| p.name);
        let user = user_of(*viewer);
        let caps = VISITOR_CAPS;
        let access = resolve_server(db, SERVER, user.as_ref(), &Proof::none())
            .await
            .expect("server");
        let rights = access.channel_rights(db).await.expect("rights");
        let stand = standing(db, SERVER, user.as_ref(), caps)
            .await
            .expect("standing");
        let (who, subjects) = w.who(*viewer, caps);
        assert_eq!(stand.who, who, "{name}");
        let manages = stand.manages_channels(everyone);
        let unread = match (viewer, &user) {
            (Some(p), Some(u)) if p.member => {
                Some(member_channel_rights(db, u).await.expect("unread"))
            }
            _ => None,
        };
        let reading = access.text_reading(2);
        let sql = format!(
            "SELECT t.id, CAST(t.whole AS BIGINT) FROM ({}) t",
            reading.sql
        );
        let read: HashMap<i64, bool> = reading
            .bind(sqlx::query(sqlx::AssertSqlSafe(sql)).bind(SERVER))
            .fetch_all(db)
            .await
            .expect("text reading")
            .iter()
            .map(|r| {
                (
                    r.try_get(0).expect("id"),
                    r.try_get::<i64, _>(1).expect("whole") != 0,
                )
            })
            .collect();
        let searched: Option<HashMap<i64, bool>> = match viewer {
            Some(p) if !p.member => None,
            _ => Some(
                crate::api::messages::search_reach(db, user.as_ref(), SERVER)
                    .await
                    .expect("search")
                    .into_iter()
                    .collect(),
            ),
        };
        let mut generated = Vec::new();
        for bit in [V, S, H] {
            generated.push(holds(db, bit, viewer.map(|p| p.name)).await);
        }
        for (id, place) in &w.channels {
            let what = format!("{name} in {} with {stored:?}", place.name);
            let want = w.expected(place, *viewer, everyone, caps);
            let [view, send, history] = vsh(want);
            // A site admin counts as a plain member where only instance powers would add
            // something: the channel itself (until opened as staff), unread counts and search.
            let staff = viewer.is_some_and(|p| p.site_admin);
            let plain = viewer.map(|p| person(p.name, p.roles, p.admin, false, p.member));
            let plain_want = match staff {
                true => w.expected(place, plain.as_ref(), everyone, caps),
                false => want,
            };
            let [plain_view, plain_send, plain_history] = vsh(plain_want);
            let got = channel_access_within(db, SERVER, *id, user.as_ref(), caps)
                .await
                .expect("access");
            assert_eq!(got.mask as Mask, want, "channel_access: {what}");
            assert_eq!(rights[id].mask as Mask, want, "channel_rights: {what}");
            match resolve_channel(db, *id, user.as_ref(), &Proof::none()).await {
                Ok(channel) => {
                    let shown = match (staff, plain_history) {
                        (true, false) => want & !H,
                        _ => want,
                    };
                    assert_eq!(channel.rights().mask as Mask, shown, "channel: {what}")
                }
                Err(_) => assert!(!view || (staff && !plain_view), "channel: {what}"),
            }
            if model {
                let lists = allow_lists(&w.rows(place), &subjects, manages, place.restrict);
                assert_eq!([view, send, history], lists, "the allow lists: {what}");
            }
            if let (Some(unread), false) = (&unread, place.voice) {
                let shown = unread.get(id).map_or([true; 3], |a| vsh(a.mask as Mask));
                assert_eq!(
                    shown,
                    [plain_view, plain_send, plain_history],
                    "member_channel_rights: {what}"
                );
            }
            if !manages && !place.voice {
                assert_eq!(
                    read.get(id).copied(),
                    view.then_some(history),
                    "text_reading: {what}"
                );
            }
            if let Some(searched) = &searched {
                let reach = searched.get(id).copied();
                match viewer {
                    None => assert_eq!(reach.is_some(), view && history, "guest search: {what}"),
                    Some(_) => {
                        assert_eq!(reach, plain_view.then_some(plain_history), "search: {what}")
                    }
                }
            }
            if !manages {
                let sql = [generated[0][id], generated[1][id], generated[2][id]];
                let held = [sql[0], sql[0] && sql[1], sql[0] && sql[2]];
                assert_eq!(held, [view, send, history], "overwrite_sql: {what}");
            }
            let rules = ws_view_rules(db, *id).await.expect("view rules");
            let under = ws_view_under(db, SERVER, &rules, viewer.map(|p| p.name))
                .await
                .expect("view under");
            assert_eq!(under, view, "view_under: {what}");
        }
    }
    for (id, place) in &w.channels {
        let what = format!("{} with {stored:?}", place.name);
        let rows = w.rows(place);
        let Restrict { view, send } = place.restrict;
        let all = rows
            .iter()
            .find(|r| r.subject == EVERYONE)
            .map(|r| r.evaluated().0);
        let channel = Channel {
            everyone: all,
            restrict_view: view,
            restrict_send: send,
            voice: place.voice,
            roles: &[],
            member: None,
        };
        let stage = eval::everyone_stage(everyone, &channel, &HOSTED);
        let others: Vec<Ow> = rows
            .iter()
            .filter(|r| r.subject != EVERYONE)
            .map(|r| r.evaluated().0)
            .collect();
        let denied = |bit: Mask| others.iter().any(|o| o.deny & bit != 0);
        let public = stage & V != 0 && !denied(V);
        let policy = ws_channel_policy(db, *id)
            .await
            .expect("policy")
            .expect("channel");
        assert_eq!(policy.public_view, public, "public_view: {what}");
        assert_eq!(
            policy.limits_history,
            stage & H == 0 || denied(H),
            "limits_history: {what}"
        );
        let at = crate::api::audit::channel_ref(db, *id)
            .await
            .expect("ref")
            .expect("channel");
        assert_eq!(at.private, !public, "the privacy flag: {what}");
        let full = resolve_channel(db, *id, Some(&mem_user("full", false)), &Proof::none())
            .await
            .expect("full admin");
        assert_eq!(
            full.restricted(db).await.expect("restricted"),
            !public,
            "restricted: {what}"
        );
        let guest_send: i64 = id_of(
            db,
            &format!(
                "SELECT CASE WHEN {} AND {} THEN 1 ELSE 0 END FROM channels c WHERE c.id = {id}",
                overwrite_sql(V, None),
                overwrite_sql(S, None)
            ),
        )
        .await;
        assert_eq!(
            guest_send != 0,
            stage & (V | S) == V | S,
            "the guest send check: {what}"
        );
        // A site admin counts as a plain member.
        for (expect_history, readable) in [(false, None), (true, Some(0))] {
            let got = channel_viewers(db, SERVER, *id, &members, readable)
                .await
                .expect("viewers");
            let want: Vec<String> = PEOPLE
                .iter()
                .filter(|p| p.member)
                .filter(|p| {
                    let plain = person(p.name, p.roles, p.admin, false, p.member);
                    let [view, _, history] =
                        vsh(w.expected(place, Some(&plain), everyone, VISITOR_CAPS));
                    view && (history || !expect_history)
                })
                .map(|p| p.name.to_string())
                .collect();
            assert_eq!(got, want, "channel_viewers {readable:?}: {what}");
        }
        if public {
            for viewer in PEOPLE.iter().map(Some).chain([None]) {
                let mask = w.expected(place, viewer, everyone, VISITOR_CAPS);
                assert!(mask & V != 0, "everyone views a public channel: {what}");
            }
        }
        for row in rows.iter().filter(|r| r.subject.starts_with("r:")) {
            let alone = Standing {
                who: Who::Member { roles: 0 },
                subjects: vec![row.subject.clone()],
            };
            let none = Standing {
                who: Who::Member { roles: 0 },
                subjects: Vec::new(),
            };
            let with = channel_mask(&rows, &alone, everyone, place.restrict, place.voice, false);
            let without = channel_mask(&rows, &none, everyone, place.restrict, place.voice, false);
            let narrows = rule_narrows(row, &rows, everyone, place.restrict);
            let widens = without & !with != 0;
            assert!(!widens || narrows, "rule_narrows: {what}");
            if stage & V != 0 {
                assert_eq!(narrows, widens, "rule_narrows: {what}");
            }
        }
    }
}

#[tokio::test]
async fn bulk_paths_agree() {
    for (state, temp) in each_db("bulk_paths").await {
        let db = &state.db;
        let w = world(db, false).await;
        let masks: [Option<Mask>; 6] = [
            None,
            Some(OPEN & !S),
            Some(V | H),
            Some(OPEN & !H),
            Some(OPEN & !V),
            Some(S | H),
        ];
        for stored in masks {
            paths_agree(db, &w, stored.map(|m| m as i64), false).await;
        }
        temp.done(state).await;
    }
}

#[tokio::test]
async fn rows_written_with_flags_only_keep_their_meaning() {
    for (state, temp) in each_db("flag_rows").await {
        let db = &state.db;
        let w = world(db, true).await;
        let stored: i64 = id_of(db, "SELECT COUNT(*) FROM channel_perms WHERE allow <> 0 OR deny <> 0 OR mode <> 'override'").await;
        assert_eq!(stored, 0, "a row written with flags only has no masks");
        paths_agree(db, &w, None, true).await;
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT {} FROM channel_perms cp",
            perm_columns("cp")
        )))
        .fetch_all(db)
        .await
        .expect("rows");
        for r in &rows {
            let row = perm_row(r, 0).expect("row");
            let (Ow { allow, deny }, mode) = row.evaluated();
            assert_eq!(allow | deny, V | masks::SEND_GROUP | H, "{}", row.subject);
            assert_eq!(allow & deny, 0);
            assert_eq!(mode == Mode::Merge, row.subject.starts_with("u:"));
        }
        temp.done(state).await;
    }
}

#[derive(Deserialize)]
struct CaseRow {
    #[serde(default)]
    allow: Vec<Value>,
    #[serde(default)]
    deny: Vec<Value>,
    #[serde(default)]
    merge: bool,
    can: Option<String>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    who: String,
    #[serde(default)]
    mask: Vec<Value>,
    #[serde(default)]
    roles: Vec<Value>,
    #[serde(default)]
    caps: Vec<Value>,
    everyone: Option<Vec<Value>>,
    #[serde(default)]
    restrict: u8,
    #[serde(default)]
    voice: bool,
    ev: Option<CaseRow>,
    #[serde(default)]
    rows: Vec<CaseRow>,
    own: Option<CaseRow>,
    #[serde(default)]
    timed_out: bool,
    #[serde(default)]
    acting: bool,
    out: Vec<Value>,
}

/// A list of bit names, numbers, the groups `OPEN` and `SEND_GROUP`, and `-name` removals.
fn mask_of(list: &[Value]) -> Mask {
    let one = |name: &str| match name {
        "OPEN" => OPEN,
        "SEND_GROUP" => masks::SEND_GROUP,
        name => {
            rchat_perms::registry::BITS
                .iter()
                .find(|b| b.name == name)
                .unwrap_or_else(|| panic!("unknown bit {name}"))
                .value
        }
    };
    let mut m = 0;
    for v in list {
        match (v.as_u64(), v.as_str().map(|s| s.strip_prefix('-').ok_or(s))) {
            (Some(n), _) => m |= n,
            (None, Some(Err(name))) => m |= one(name),
            (None, Some(Ok(name))) => m &= !one(name),
            (None, None) => panic!("bad mask entry {v}"),
        }
    }
    m
}

fn rule_of(row: &CaseRow) -> Rule {
    let CaseRow {
        allow,
        deny,
        merge,
        can,
    } = row;
    match can {
        Some(flags) => Rule::Flags(
            flags.contains('v'),
            flags.contains('s'),
            flags.contains('h'),
        ),
        None => Rule::Masks(mask_of(allow), mask_of(deny), *merge),
    }
}

/// The shared hosted cases, each built as rows in the database and read back through the gate.
#[tokio::test]
async fn hosted_cases_hold_through_the_gate() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/perm_cases.json");
    let all: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("cases")).expect("json");
    let cases: Vec<Case> = serde_json::from_value(all["hosted"]["channel"].clone()).expect("cases");
    assert!(cases.len() > 40);
    for (state, temp) in each_db("hosted_cases").await {
        let db = &state.db;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at, public_read) VALUES('ow', 'Ow', NULL, 0, 1)").await;
        NewUser::plain("who").at(1).add(db).await;
        for (n, case) in cases.iter().enumerate() {
            let Case {
                name,
                who,
                mask,
                roles,
                caps,
                everyone,
                restrict,
                voice,
                ev,
                rows,
                own,
                timed_out,
                acting,
                out,
            } = case;
            for table in ["user_roles", "members"] {
                exec(db, &format!("DELETE FROM {table} WHERE server = 'ow'")).await;
            }
            exec(db, "DELETE FROM roles WHERE server = 'ow'").await;
            match everyone {
                Some(bits) => {
                    exec(
                        db,
                        &format!("UPDATE servers SET everyone_perms = {}", mask_of(bits)),
                    )
                    .await
                }
                None => exec(db, "UPDATE servers SET everyone_perms = NULL").await,
            }
            let kind = match voice {
                true => "voice",
                false => "text",
            };
            let cid = id_of(db, &format!("INSERT INTO channels(server, name, kind, created_at, restrict_view, restrict_send) VALUES('ow', 'c{n}', '{kind}', 0, {}, {}) RETURNING id", restrict & 1, (restrict >> 1) & 1)).await;
            let member = matches!(who.as_str(), "admin" | "member");
            match who.as_str() {
                "admin" => add_member(db, SERVER, "who", 1, mask_of(mask) as i64, 0).await,
                "member" => add_member(db, SERVER, "who", 0, 0, 0).await,
                "staff" | "guest" | "visitor" => {}
                other => panic!("{name}: no hosted viewer is {other}"),
            }
            let mut held = Vec::new();
            if member {
                held.push(id_of(db, &format!("INSERT INTO roles(server, name, color, perms) VALUES('ow', 'bits', '#ffffff', {}) RETURNING id", mask_of(roles) as i64)).await);
            }
            for (i, row) in rows.iter().enumerate() {
                let id = id_of(db, &format!("INSERT INTO roles(server, name, color, perms) VALUES('ow', 'r{i}', '#ffffff', 0) RETURNING id")).await;
                rule_of(row).insert(db, cid, &format!("r:{id}")).await;
                held.push(id);
            }
            if member {
                for id in held {
                    exec(db, &format!("INSERT INTO user_roles(server, username, role_id) VALUES('ow', 'who', {id})")).await;
                }
            }
            if let Some(row) = ev {
                rule_of(row).insert(db, cid, EVERYONE).await;
            }
            if let Some(row) = own {
                rule_of(row).insert(db, cid, "u:who").await;
            }
            let user = match who.as_str() {
                "guest" => None,
                "staff" => Some(mem_user("who", true)),
                _ => Some(mem_user("who", false)),
            };
            let caps = mask_of(caps);
            let want = mask_of(out);
            let got = match (timed_out, acting) {
                (true, true) => {
                    let stand = standing(db, SERVER, user.as_ref(), caps)
                        .await
                        .expect("standing");
                    let rules = ws_view_rules(db, cid).await.expect("rules");
                    channel_mask(
                        &rules.rules,
                        &stand,
                        everyone_mask(rules.everyone),
                        rules.restrict,
                        *voice,
                        true,
                    )
                }
                _ => {
                    channel_access_within(db, SERVER, cid, user.as_ref(), caps)
                        .await
                        .expect("access")
                        .mask as Mask
                }
            };
            assert_eq!(got, want, "{name}");
        }
        temp.done(state).await;
    }
}

mod rest {
    use axum::Json;
    use axum::extract::{Path, Query, State};
    use axum::http::{HeaderMap, StatusCode};
    use serde_json::json;

    use super::*;
    use crate::api::servers::{
        clear_channel_perm, create_role, get_server, list_channel_perms, set_channel_perm,
        set_everyone_perms,
    };
    use crate::api::{ApiError, Authed, ChannelPerm, MaybeAuthed, Paged, PermMode, ServerDetail};
    use crate::state::AppState;

    const DELETE: i64 = 2;
    const MENTION: i64 = 32;
    const KICK: i64 = 4;
    const MANAGE: i64 = 1;
    const ROLES: i64 = 16384;
    const SEND: i64 = S as i64;
    const VIEW: i64 = V as i64;
    const BASE: i64 = masks::BASE as i64;

    fn me(name: &str) -> Authed {
        Authed(mem_user(name, false))
    }

    fn status<T>(res: Result<T, ApiError>) -> (StatusCode, String) {
        match res {
            Ok(_) => (StatusCode::OK, String::new()),
            Err(ApiError(code, text, _)) => (code, text),
        }
    }

    const OK: (StatusCode, &str) = (StatusCode::OK, "");
    const GRANTS: (StatusCode, &str) = (
        StatusCode::FORBIDDEN,
        "You can't allow permissions you don't have in this channel",
    );
    const DENIES: (StatusCode, &str) = (
        StatusCode::FORBIDDEN,
        "You can't deny moderation permissions you don't have in this channel",
    );
    const OUTRANKED: (StatusCode, &str) = (
        StatusCode::FORBIDDEN,
        "You can't take moderation permissions from this role or member",
    );

    struct Club {
        state: AppState,
        channel: i64,
        roles: HashMap<&'static str, i64>,
    }

    impl Club {
        async fn put_as(&self, by: Authed, body: Value) -> (StatusCode, String) {
            status(
                set_channel_perm(
                    State(self.state.clone()),
                    by,
                    Path(self.channel),
                    Json(serde_json::from_value(body).expect("body")),
                )
                .await,
            )
        }

        async fn put(&self, by: &str, body: Value) -> (StatusCode, String) {
            self.put_as(me(by), body).await
        }

        async fn clear(&self, by: &str, subject: &str) -> (StatusCode, String) {
            status(
                clear_channel_perm(
                    State(self.state.clone()),
                    me(by),
                    Path((self.channel, subject.to_string())),
                )
                .await,
            )
        }

        async fn rules(&self) -> Vec<ChannelPerm> {
            let query = serde_json::from_value(json!({})).expect("query");
            let Paged(rows, _) = list_channel_perms(
                State(self.state.clone()),
                me("own"),
                Path(self.channel),
                Query(query),
            )
            .await
            .expect("rules");
            rows
        }

        async fn rule(&self, subject: &str) -> Option<(i64, i64, PermMode, [bool; 3])> {
            self.rules()
                .await
                .into_iter()
                .find(|r| r.subject == subject)
                .map(|r| {
                    let ChannelPerm {
                        subject: _,
                        can_view,
                        can_send,
                        can_read_history,
                        allow,
                        deny,
                        mode,
                    } = r;
                    (allow, deny, mode, [can_view, can_send, can_read_history])
                })
        }

        async fn detail(&self, by: &str) -> ServerDetail {
            let Json(detail) = get_server(
                State(self.state.clone()),
                MaybeAuthed(Some(mem_user(by, false))),
                HeaderMap::new(),
                Path("club".to_string()),
            )
            .await
            .expect("detail");
            detail
        }

        async fn everyone(&self, by: &str, body: Value) -> Result<i64, (StatusCode, String)> {
            set_everyone_perms(
                State(self.state.clone()),
                me(by),
                Path("club".to_string()),
                Json(serde_json::from_value(body).expect("body")),
            )
            .await
            .map(|Json(answer)| answer.everyone_perms)
            .map_err(|ApiError(code, text, _)| (code, text))
        }

        fn role(&self, name: &str) -> String {
            format!("r:{}", self.roles[name])
        }
    }

    fn says(got: (StatusCode, String), want: (StatusCode, &str), what: &str) {
        assert_eq!((got.0, got.1.as_str()), want, "{what}");
    }

    /// A server with its owner `own`, a channel manager `mgr`, `boss` (Manage channels, Manage
    /// messages and Manage roles), `peer` (Manage channels and Manage messages), a moderator
    /// `modr` (Manage messages) and a member `low`.
    async fn club(state: AppState) -> Club {
        let db = &state.db;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'own', 0)").await;
        let channel = id_of(db, "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 0) RETURNING id").await;
        let mut roles = HashMap::new();
        for (name, perms) in [
            ("rmgr", MANAGE),
            ("rboss", MANAGE | DELETE | ROLES),
            ("rpeer", MANAGE | DELETE),
            ("rmod", DELETE),
            ("rlow", 0),
        ] {
            let id = id_of(db, &format!("INSERT INTO roles(server, name, color, perms) VALUES('club', '{name}', '#ffffff', {perms}) RETURNING id")).await;
            roles.insert(name, id);
        }
        for (name, role) in [
            ("own", None),
            ("mgr", Some("rmgr")),
            ("boss", Some("rboss")),
            ("peer", Some("rpeer")),
            ("modr", Some("rmod")),
            ("low", Some("rlow")),
        ] {
            NewUser::plain(name).at(1).add(db).await;
            add_member(db, "club", name, i64::from(name == "own"), 0, 0).await;
            if let Some(role) = role {
                exec(db, &format!("INSERT INTO user_roles(server, username, role_id) VALUES('club', '{name}', {})", roles[role])).await;
            }
        }
        NewUser::plain("zed").at(1).add(db).await;
        Club {
            state,
            channel,
            roles,
        }
    }

    #[tokio::test]
    async fn rule_edits_grant_only_what_the_editor_holds() {
        for (state, temp) in each_db("rule_edits").await {
            let c = club(state.clone()).await;
            let low = c.role("rlow");
            says(
                c.put("mgr", json!({ "subject": low, "allow": SEND, "deny": 0 }))
                    .await,
                OK,
                "a base bit",
            );
            assert_eq!(
                c.rule(&low).await,
                Some((SEND, 0, PermMode::Override, [true; 3]))
            );
            says(
                c.put("mgr", json!({ "subject": low, "allow": DELETE, "deny": 0 }))
                    .await,
                GRANTS,
                "Manage messages without holding it",
            );
            says(
                c.put(
                    "boss",
                    json!({ "subject": low, "allow": DELETE, "deny": 0 }),
                )
                .await,
                OK,
                "Manage messages by a holder",
            );
            says(
                c.clear("mgr", &low).await,
                OUTRANKED,
                "taking Manage messages from a role you couldn't edit",
            );
            says(
                c.put("own", json!({ "subject": low, "allow": MENTION }))
                    .await,
                OK,
                "the owner lets the role mention everyone",
            );
            says(
                c.clear("boss", &low).await,
                OK,
                "removing a rule that allows what you lack, from a role you could edit",
            );
            assert_eq!(c.rule(&low).await, None);
            says(
                c.put("boss", json!({ "subject": "everyone", "deny": MENTION }))
                    .await,
                DENIES,
                "denying everyone a moderation bit needs holding it",
            );
            says(
                c.put("own", json!({ "subject": "Everyone", "deny": MENTION }))
                    .await,
                OK,
                "an admin with every permission",
            );
            assert_eq!(
                c.rule("everyone").await,
                Some((0, MENTION, PermMode::Override, [true; 3]))
            );
            says(
                c.put(
                    "mgr",
                    json!({ "subject": "everyone", "allow": 0, "deny": 0 }),
                )
                .await,
                GRANTS,
                "lifting a deny you lack",
            );
            says(
                c.clear("mgr", "everyone").await,
                GRANTS,
                "removing a deny you lack",
            );
            says(
                c.put(
                    "mgr",
                    json!({ "subject": "everyone", "deny": MENTION | SEND }),
                )
                .await,
                OK,
                "a deny that was already there is not checked again",
            );
            says(c.clear("own", "everyone").await, OK, "the owner lifts it");
            let moderators = c.role("rmod");
            says(
                c.put("mgr", json!({ "subject": moderators, "deny": DELETE }))
                    .await,
                DENIES,
                "a manager without Manage messages",
            );
            says(
                c.put("peer", json!({ "subject": moderators, "deny": DELETE }))
                    .await,
                OUTRANKED,
                "a holder who can't manage the role",
            );
            says(
                c.put("boss", json!({ "subject": moderators, "deny": DELETE }))
                    .await,
                OK,
                "a holder who manages the role",
            );
            says(
                c.put("peer", json!({ "subject": "u:modr", "deny": DELETE }))
                    .await,
                OK,
                "a member you could moderate",
            );
            says(
                c.put("peer", json!({ "subject": "u:boss", "deny": DELETE }))
                    .await,
                OUTRANKED,
                "a member you couldn't moderate",
            );
            says(
                c.put("mgr", json!({ "subject": "u:boss", "deny": SEND }))
                    .await,
                OK,
                "base bits need neither",
            );
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn taking_a_moderation_allow_needs_outranking_the_subject() {
        for (state, temp) in each_db("allow_removal").await {
            let c = club(state.clone()).await;
            let peer = c.role("rpeer");
            says(
                c.put("own", json!({ "subject": peer, "allow": MENTION }))
                    .await,
                OK,
                "the owner lets a role above mgr mention everyone",
            );
            says(c.clear("mgr", &peer).await, OUTRANKED, "deleting the rule");
            says(
                c.put("mgr", json!({ "subject": peer, "allow": SEND }))
                    .await,
                OUTRANKED,
                "rewriting it without the allow",
            );
            says(
                c.put("mgr", json!({ "subject": peer, "allow": MENTION | SEND }))
                    .await,
                OK,
                "adding a base bit next to it",
            );
            says(
                c.put("boss", json!({ "subject": peer, "allow": SEND }))
                    .await,
                OK,
                "a manager who could edit the role",
            );
            assert_eq!(
                c.rule(&peer).await,
                Some((SEND, 0, PermMode::Override, [true; 3]))
            );
            for (subject, by, want) in [
                ("u:low", "mgr", OK),
                ("u:boss", "mgr", OUTRANKED),
                ("everyone", "mgr", OK),
            ] {
                says(
                    c.put("own", json!({ "subject": subject, "allow": MENTION }))
                        .await,
                    OK,
                    subject,
                );
                says(c.clear(by, subject).await, want, subject);
            }
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn a_rule_as_listed_with_a_flag_changed_saves() {
        for (state, temp) in each_db("rule_echo").await {
            let c = club(state.clone()).await;
            let db = &state.db;
            let low = c.role("rlow");
            let toggled = async |subject: &str, flag: &str| {
                let row = c.rules().await.into_iter().find(|r| r.subject == subject);
                let mut body = serde_json::to_value(row.expect("rule")).expect("json");
                body[flag] = Value::Bool(!body[flag].as_bool().expect("flag"));
                body
            };
            let all = json!({ "subject": low, "can_view": true, "can_send": true, "can_read_history": true });
            says(c.put("mgr", all).await, OK, "a flag rule");
            let echo = toggled(&low, "can_send").await;
            says(c.put("mgr", echo).await, OK, "Send turned off");
            let flags: i64 = id_of(db, &format!("SELECT COUNT(*) FROM channel_perms WHERE subject = '{low}' AND allow = 0 AND deny = 0 AND can_view = 1 AND can_send = 0 AND can_read_history = 1")).await;
            assert_eq!(flags, 1, "it stays a flag rule");
            let group = masks::SEND_GROUP as i64;
            assert_eq!(
                c.rule(&low).await,
                Some((
                    (V | H) as i64,
                    group,
                    PermMode::Override,
                    [true, false, true]
                ))
            );
            says(
                c.put("own", json!({ "subject": "everyone", "deny": MENTION }))
                    .await,
                OK,
                "a mask rule",
            );
            says(
                c.put("mgr", toggled("everyone", "can_view").await).await,
                OK,
                "View turned off keeps the deny the editor lacks",
            );
            assert_eq!(
                c.rule("everyone").await,
                Some((0, MENTION | VIEW, PermMode::Override, [false, true, true]))
            );
            let attach = rchat_perms::registry::value("AttachFiles") as i64;
            says(
                c.put(
                    "mgr",
                    json!({ "subject": "u:low", "deny": attach, "mode": "merge" }),
                )
                .await,
                OK,
                "a rule that denies one bit of the send group",
            );
            let stale = toggled("u:low", "can_view").await;
            says(c.put("mgr", stale.clone()).await, OK, "View turned off");
            assert_eq!(
                c.rule("u:low").await,
                Some((0, attach | VIEW, PermMode::Merge, [false, false, true]))
            );
            says(
                c.put("mgr", toggled("u:low", "can_send").await).await,
                OK,
                "Send turned on",
            );
            assert_eq!(
                c.rule("u:low").await,
                Some((group, VIEW, PermMode::Merge, [false, true, true]))
            );
            let changed = (StatusCode::BAD_REQUEST, "This rule changed. Try again.");
            says(
                c.put("mgr", stale).await,
                changed,
                "masks that are not the stored rule's",
            );
            let gone = toggled("u:low", "can_view").await;
            says(c.clear("mgr", "u:low").await, OK, "the rule is removed");
            says(c.put("mgr", gone.clone()).await, changed, "no stored rule");
            let mut half = gone;
            half.as_object_mut().expect("body").remove("deny");
            says(
                c.put("mgr", half).await,
                (
                    StatusCode::BAD_REQUEST,
                    "Send allow and deny, or can_view, can_send and can_read_history",
                ),
                "the flags with one mask",
            );
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn the_socket_gate_follows_what_everyone_holds() {
        for (state, temp) in each_db("everyone_policy").await {
            let c = club(state.clone()).await;
            let db = &state.db;
            let policy = async || {
                let slot = state.hub.channels().slot(c.channel);
                let policy = slot
                    .get_or_try_init(|| ws_channel_policy(db, c.channel))
                    .await
                    .expect("policy");
                policy.as_ref().map(|p| (p.public_view, p.limits_history))
            };
            assert_eq!(policy().await, Some((true, false)));
            let hidden = json!({ "perms": 0, "mask": VIEW | H as i64 });
            assert_eq!(
                c.everyone("own", hidden).await,
                Ok(BASE & !VIEW & !(H as i64))
            );
            assert_eq!(policy().await, Some((false, true)), "the kept policy");
            assert_eq!(
                ws_channel_policy(db, c.channel)
                    .await
                    .expect("fresh")
                    .map(|p| (p.public_view, p.limits_history)),
                Some((false, true))
            );
            let shown = json!({ "perms": BASE, "mask": VIEW | H as i64 });
            assert_eq!(c.everyone("own", shown).await, Ok(BASE));
            assert_eq!(policy().await, Some((true, false)));
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn rules_are_stored_as_masks_or_as_flags() {
        for (state, temp) in each_db("rule_forms").await {
            let c = club(state.clone()).await;
            let db = &state.db;
            let invalid = |text: &'static str| (StatusCode::BAD_REQUEST, text);
            for (body, text) in [
                (
                    json!({ "subject": "u:low", "allow": SEND, "deny": SEND }),
                    "Invalid permissions",
                ),
                (
                    json!({ "subject": "u:low", "allow": KICK }),
                    "Invalid permissions",
                ),
                (
                    json!({ "subject": "u:low", "deny": 1i64 << 40 }),
                    "Invalid permissions",
                ),
                (
                    json!({ "subject": c.role("rlow"), "allow": SEND, "mode": "merge" }),
                    "Invalid mode",
                ),
                (
                    json!({ "subject": "everyone", "deny": SEND, "mode": "merge" }),
                    "Invalid mode",
                ),
                (
                    json!({ "subject": "u:low", "allow": SEND, "can_view": true, "can_send": true, "can_read_history": true }),
                    "Send allow and deny, or can_view, can_send and can_read_history",
                ),
                (
                    json!({ "subject": "u:low", "can_view": true }),
                    "Send allow and deny, or can_view, can_send and can_read_history",
                ),
                (
                    json!({ "subject": "u:low" }),
                    "Send allow and deny, or can_view, can_send and can_read_history",
                ),
                (
                    json!({ "subject": "u:nobody", "deny": SEND }),
                    "Invalid subject",
                ),
                (
                    json!({ "subject": "u:a@b", "deny": SEND }),
                    "Invalid subject",
                ),
                (json!({ "subject": "r:0", "deny": SEND }), "Role not found"),
                (json!({ "subject": "all", "deny": SEND }), "Invalid subject"),
            ] {
                let got = c.put("own", body.clone()).await;
                let want = match text {
                    "Role not found" => (StatusCode::NOT_FOUND, text),
                    _ => invalid(text),
                };
                says(got, want, &body.to_string());
            }
            says(
                c.put("mgr", json!({ "subject": "u:zed", "deny": SEND }))
                    .await,
                OK,
                "an account outside the server",
            );
            let flags = json!({ "subject": "u:low", "can_view": true, "can_send": false, "can_read_history": true });
            says(c.put("mgr", flags).await, OK, "the three flags");
            let stored: i64 = id_of(db, "SELECT COUNT(*) FROM channel_perms WHERE subject = 'u:low' AND allow = 0 AND deny = 0 AND can_view = 1 AND can_send = 0 AND can_read_history = 1").await;
            assert_eq!(stored, 1, "a flag rule keeps its masks at 0");
            let group = masks::SEND_GROUP as i64;
            assert_eq!(
                c.rule("u:low").await,
                Some(((V | H) as i64, group, PermMode::Merge, [true, false, true])),
                "a flag rule reads as the masks it stands for"
            );
            says(
                c.put(
                    "mgr",
                    json!({ "subject": "u:low", "allow": 0, "deny": SEND }),
                )
                .await,
                OK,
                "masks over a flag rule",
            );
            assert_eq!(
                c.rule("u:low").await,
                Some((0, SEND, PermMode::Merge, [true, false, true])),
                "the rule keeps how it combined"
            );
            says(
                c.put(
                    "mgr",
                    json!({ "subject": "u:low", "allow": VIEW, "deny": SEND, "mode": "override" }),
                )
                .await,
                OK,
                "a mode",
            );
            assert_eq!(
                c.rule("u:low").await,
                Some((VIEW, SEND, PermMode::Override, [true, false, true]))
            );
            let stored: i64 = id_of(db, "SELECT COUNT(*) FROM channel_perms WHERE subject = 'u:low' AND mode = 'override' AND can_view = 1 AND can_send = 0 AND can_read_history = 1").await;
            assert_eq!(stored, 1, "a mask rule also sets the flags");
            says(
                c.put("mgr", json!({ "subject": "u:low", "allow": 0, "deny": 0 }))
                    .await,
                OK,
                "nothing allowed or denied",
            );
            assert_eq!(
                c.rule("u:low").await,
                None,
                "a rule that says nothing is removed"
            );
            let empty: i64 = id_of(
                db,
                "SELECT COUNT(*) FROM channel_perms WHERE subject = 'u:low'",
            )
            .await;
            assert_eq!(empty, 0);
            says(
                c.clear("mgr", "u:low").await,
                (StatusCode::NOT_FOUND, "No such rule"),
                "no rule to remove",
            );
            let logged: i64 = id_of(db, "SELECT COUNT(*) FROM audit_log WHERE server = 'club' AND action IN ('channel.perm_set', 'channel.perm_clear')").await;
            assert_eq!(logged, 5, "each change is logged once");
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn everyone_and_my_permissions() {
        for (state, temp) in each_db("everyone_perms").await {
            let c = club(state.clone()).await;
            let db = &state.db;
            let before = c.detail("low").await;
            assert_eq!(before.everyone_perms, BASE);
            assert_eq!(before.my_perms, BASE);
            assert_eq!(before.channels[0].my_perms, Some(OPEN as i64));
            assert_eq!(c.detail("mgr").await.my_perms, BASE | MANAGE);
            let refused = (
                StatusCode::FORBIDDEN,
                "You can't grant permissions you don't have".to_string(),
            );
            assert_eq!(
                c.everyone("mgr", json!({ "perms": BASE })).await,
                Err((StatusCode::FORBIDDEN, "Missing permission".to_string())),
                "Manage roles is needed"
            );
            assert_eq!(
                c.everyone("boss", json!({ "perms": 0, "mask": SEND }))
                    .await,
                Ok(BASE & !SEND),
                "only the bits of the mask change"
            );
            assert_eq!(
                c.everyone("boss", json!({ "perms": BASE | KICK | (1i64 << 40) }))
                    .await,
                Err(refused.clone()),
                "a bit you no longer hold"
            );
            let quiet = c.detail("low").await;
            assert_eq!(quiet.everyone_perms, BASE & !SEND);
            assert_eq!(quiet.my_perms, BASE & !SEND);
            assert_eq!(quiet.channels[0].my_perms, Some(OPEN as i64 & !SEND));
            assert_eq!(quiet.read_only, vec![c.channel]);
            assert_eq!(
                c.detail("mgr").await.channels[0].my_perms,
                Some(masks::MANAGER_PASS as i64),
                "Manage channels keeps the base bits"
            );
            let role = |by: &'static str, perms: i64| {
                let state = state.clone();
                async move {
                    let body = json!({ "name": "talkers", "color": "#ffffff", "perms": perms });
                    create_role(
                        State(state),
                        me(by),
                        Path("club".to_string()),
                        Json(serde_json::from_value(body).expect("role")),
                    )
                    .await
                    .map(|Json(role)| role.perms)
                    .map_err(|ApiError(code, text, _)| (code, text))
                }
            };
            assert_eq!(role("boss", SEND).await, Err(refused.clone()));
            assert_eq!(role("boss", DELETE | (1i64 << 40)).await, Ok(DELETE));
            assert_eq!(
                role("own", SEND | KICK).await,
                Ok(SEND | KICK),
                "a role can hold what everyone can"
            );
            let talkers = id_of(db, "SELECT MAX(id) FROM roles WHERE server = 'club'").await;
            exec(db, &format!("INSERT INTO user_roles(server, username, role_id) VALUES('club', 'low', {talkers})")).await;
            let talking = c.detail("low").await;
            assert_eq!(talking.my_perms, BASE | KICK);
            assert_eq!(talking.channels[0].my_perms, Some(OPEN as i64));
            assert!(talking.read_only.is_empty());
            assert_eq!(
                c.everyone("own", json!({ "perms": BASE | KICK })).await,
                Ok(BASE),
                "bits everyone can't hold are left as they are"
            );
            assert_eq!(c.everyone("own", json!({ "perms": BASE })).await, Ok(BASE));
            let logged: i64 = id_of(db, "SELECT COUNT(*) FROM audit_log WHERE server = 'club' AND action = 'server.update' AND details LIKE '%everyone_perms%'").await;
            assert_eq!(logged, 2, "each change is logged once");
            temp.done(state).await;
        }
    }

    #[tokio::test]
    async fn a_site_admin_editing_past_their_membership_is_logged_as_staff() {
        for (state, temp) in each_db("rule_staff").await {
            let c = club(state.clone()).await;
            let db = &state.db;
            exec(
                db,
                "UPDATE users SET is_site_admin = 1 WHERE username = 'mgr'",
            )
            .await;
            let root = || Authed(mem_user("mgr", true));
            let low = c.role("rlow");
            says(
                c.put_as(root(), json!({ "subject": low, "allow": SEND }))
                    .await,
                OK,
                "within the membership",
            );
            says(
                c.put_as(root(), json!({ "subject": low, "allow": SEND | DELETE }))
                    .await,
                OK,
                "past the membership",
            );
            let rows = sqlx::query("SELECT actor, staff FROM audit_log WHERE server = 'club' AND action = 'channel.perm_set' ORDER BY id")
                .fetch_all(db)
                .await
                .expect("log");
            let logged: Vec<(Option<String>, i64)> = rows
                .iter()
                .map(|r| (r.try_get(0).expect("actor"), r.try_get(1).expect("staff")))
                .collect();
            assert_eq!(logged, [(Some("mgr".to_string()), 0), (None, 1)]);
            temp.done(state).await;
        }
    }
}
