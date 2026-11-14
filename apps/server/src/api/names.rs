use crate::api::NAME_MAX;
use crate::db::{Db, PURGING_HASH, User, user_row};

pub(crate) const STAFF_NAME: &str = "instance staff";

/// Whether `name` could be a username, by the rules of sign-up: not blank, at most `NAME_MAX`
/// characters, without `@` or NUL. By-name moderation answers every such name alike, whether an
/// account has it or not.
pub(crate) fn could_be_username(name: &str) -> bool {
    !name.trim().is_empty()
        && name.chars().count() <= crate::api::NAME_MAX
        && !name.contains(['@', '\0'])
}

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
        0x34f | 0x115f | 0x1160 | 0x17b4 | 0x17b5 | 0x180b..=0x180f
    ) || matches!(c as u32, 0x2800 | 0x3164 | 0xffa0 | 0x1d159)
}

/// What a name looks like, for comparing names: hidden characters (`hidden_char`) and variation
/// selectors dropped, NFKC, full case folding, whitespace collapsed, then the UTS #39 confusable
/// skeleton (folded again, and taken again until it no longer changes), so `ALICE` in fullwidth
/// letters, a Cyrillic a (U+0430), a no-break space or a zero-width space all match the plain
/// name.
pub fn name_key(name: &str) -> String {
    name_keys(name)[1].clone()
}

/// The version of `name_keys`. Usernames are stored with their keys, so raise this with any
/// change to `name_keys` or to the exactly pinned Unicode crates it uses (`Cargo.toml`): every
/// stored key is then made again at the next start.
pub(crate) const KEY_VERSION: u32 = 3;

/// The keys two names are compared by: lookalike skeletons taken both before and after case
/// folding (capital I passes for l only before folding), with combining marks dropped so a
/// mark stacked on a letter cannot hide the match, and without hidden characters, so a name
/// that hides one passes for its visible spelling. The characters of `OWN_LOOKS` keep their
/// own look through compatibility normalization (a long s is an f). Each key is taken again
/// until it is its own key: a Greek capital Mu (U+039C) is an M, and m passes for rn. The third
/// key reads a capital that passes for l as i, so U+039C followed by `IKE` passes for `mike`;
/// usernames are stored under the first two keys (`username_keys`). Two names clash when any
/// keys are equal.
pub fn name_keys(name: &str) -> [String; 3] {
    keys_reading(name, &OWN_LOOKS)
}

/// Characters (by code point) that keep the look UTS #39 gives them, which compatibility
/// normalization or dropping marks would take away: a long s is an f (not an s), the lunate sigmas are c and C
/// (not sigmas), the ogonek and the ypogegrammeni are i, the anusvara signs are o, the Oriya
/// visarga is 8, and the halfwidth bar is l.
const OWN_LOOKS: [(u32, char); 11] = [
    (0x17f, 'f'),
    (0x2db, 'i'),
    (0x37a, 'i'),
    (0x3f2, 'c'),
    (0x3f9, 'C'),
    (0xb03, '8'),
    (0xc02, 'o'),
    (0xc82, 'o'),
    (0xd02, 'o'),
    (0xd82, 'o'),
    (0xffe8, 'l'),
];

/// `name_keys`, with each character of `own_looks` (by code point) read as its look before
/// compatibility normalization (after canonical decomposition, so a long s with a dot is read
/// too).
fn keys_reading(name: &str, own_looks: &[(u32, char)]) -> [String; 3] {
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
    let own = |c: char| match own_looks.iter().find(|(from, _)| *from == c as u32) {
        Some((_, look)) => *look,
        None => c,
    };
    let bare = |s: &str| -> String {
        s.chars()
            .filter(|c| !hidden_char(*c))
            .nfd()
            .map(own)
            .nfkd()
            .filter(|c| !is_combining_mark(*c))
            .collect()
    };
    let skeleton = |s: &str| unicode_security::skeleton(s).collect::<String>();
    let settle = |mut key: String| {
        for _ in 0..8 {
            let next = fold(&skeleton(&bare(&key)));
            if next == key {
                break;
            }
            key = next;
        }
        key
    };
    let name = bare(name);
    let capitals = name
        .chars()
        .map(
            |c| match c.is_uppercase() && skeleton(c.encode_utf8(&mut [0; 4])) == "l" {
                true => 'i',
                false => c,
            },
        )
        .collect();
    [
        settle(name.nfkc().collect()),
        settle(fold(&name)),
        settle(capitals),
    ]
}

pub(crate) fn names_clash(a: &[String; 3], b: &[String; 3]) -> bool {
    a.iter().any(|x| b.contains(x))
}

/// Whether `name` passes for the instance staff, compared by `name_keys`.
pub(crate) fn passes_for_staff(name: &str) -> bool {
    names_clash(&name_keys(name), &name_keys(STAFF_NAME))
}

/// The looks of the lowercase `username`, shown as `shown`: its key after folding, the look of
/// the name as shown when it is the username in another case (else of the username), and the
/// look of the lowercase username.
fn username_looks(username: &str, shown: &str) -> [String; 3] {
    let name = match shown.to_lowercase() == username {
        true => shown,
        false => username,
    };
    let [look, key, _] = name_keys(name);
    let [lower, _, _] = name_keys(username);
    [key, look, lower]
}

/// The `name_keys` of a username as `users` and `banned_usernames` store them: `username_key`,
/// and in `username_key_alt` a look that differs from it. The first look is taken from the name
/// as shown when it is the username in another case, so capitals that pass for other letters
/// (`Ian` for `lan`, a Greek capital Beta for B) count whichever spelling came first. The second
/// is the look of the lowercase username: a Cherokee capital passes for a Latin letter only as
/// a small letter (U+13A4 for o), so the name typed with one passes for its plain twin too.
/// When both differ from the key and from each other (`three_looks`), only the first is stored.
pub(crate) fn username_keys(username: &str, shown: &str) -> (String, Option<String>) {
    let [key, look, lower] = username_looks(username, shown);
    let alt = [look, lower].into_iter().find(|alt| *alt != key);
    (key, alt)
}

/// Whether the lowercase `username`, shown as `shown`, has three looks that all differ, one more
/// than `username_keys` stores. A capital that passes for l next to a Cherokee capital gives
/// them (U+13A4 before `lIvia`), and so does one next to U+03D2 (before `Iq`). A new account can
/// not have such a name.
pub(crate) fn three_looks(username: &str, shown: &str) -> bool {
    let [key, look, lower] = username_looks(username, shown);
    key != look && key != lower && look != lower
}

pub(crate) const OTHER_USERNAME_SQL: &str = "SELECT 1 FROM users WHERE username_key IN ($1, $2, $3) AND username <> $4 UNION ALL SELECT 1 FROM users WHERE username_key_alt IN ($1, $2, $3) AND username <> $4 LIMIT 1";

/// Whether one of `keys` (up to three) is a stored key of an account other than `me`.
async fn another_holds(db: &Db, keys: &[String], me: &str) -> sqlx::Result<bool> {
    let Some(first) = keys.first() else {
        return Ok(false);
    };
    let key = |at: usize| keys.get(at).unwrap_or(first);
    Ok(sqlx::query(OTHER_USERNAME_SQL)
        .bind(first)
        .bind(key(1))
        .bind(key(2))
        .bind(me)
        .fetch_optional(db)
        .await?
        .is_some())
}

/// Whether `name` passes for the username of an account other than `me`, compared by
/// `name_keys` through the stored keys.
pub(crate) async fn passes_for_another(db: &Db, name: &str, me: &str) -> sqlx::Result<bool> {
    another_holds(db, &name_keys(name), me).await
}

/// Whether the capitals of `shown`, the username `me` in another case, pass for the username of
/// another account: only the keys they add to the username's own are compared, so an account
/// that already passes for another keeps its own name and still gains no further look-alike.
pub(crate) async fn capitals_pass_for_another(
    db: &Db,
    shown: &str,
    me: &str,
) -> sqlx::Result<bool> {
    let own = name_keys(me);
    let added: Vec<String> = name_keys(shown)
        .into_iter()
        .filter(|key| !own.contains(key))
        .collect();
    another_holds(db, &added, me).await
}

/// Whether the lowercase username `$7` is an account's, or passes for one by the keys `$1` to
/// `$6`.
pub(crate) const TAKEN_SQL: &str = "SELECT 1 FROM users WHERE username = $7 UNION ALL SELECT 1 FROM users WHERE username_key IN ($1, $2, $3, $4, $5, $6) UNION ALL SELECT 1 FROM users WHERE username_key_alt IN ($1, $2, $3, $4, $5, $6) LIMIT 1";

/// `TAKEN_SQL` for the banned usernames.
pub(crate) const BANNED_SQL: &str = "SELECT 1 FROM banned_usernames WHERE username = $7 UNION ALL SELECT 1 FROM banned_usernames WHERE username_key IN ($1, $2, $3, $4, $5, $6) UNION ALL SELECT 1 FROM banned_usernames WHERE username_key_alt IN ($1, $2, $3, $4, $5, $6) LIMIT 1";

/// The accounts, not being deleted, whose username passes for the keys `$1` to `$3`. An account
/// can match through both stored keys, so three rows tell one account from several.
pub(crate) const SIGN_IN_SQL: &str = "SELECT * FROM users WHERE username_key IN ($1, $2, $3) AND password_hash <> '!purging' UNION ALL SELECT * FROM users WHERE username_key_alt IN ($1, $2, $3) AND password_hash <> '!purging' LIMIT 3";

/// The account a sign-in as `name` is for: the account with that username in any case, else the
/// one account, not being deleted, whose username `name` passes for (`name_keys` through the
/// stored keys). None when the account with that username is being deleted, when there is none,
/// or when `name` passes for several. A name over `NAME_MAX` characters reaches none, with no
/// lookup and no keys; every other name costs the same two lookups.
pub(crate) async fn sign_in_account(db: &Db, name: &str) -> sqlx::Result<Option<User>> {
    if name.chars().count() > NAME_MAX {
        return Ok(None);
    }
    let exact = user_row(db, name).await?;
    let [a, b, c] = name_keys(name);
    let alike = sqlx::query(SIGN_IN_SQL)
        .bind(a)
        .bind(b)
        .bind(c)
        .fetch_all(db)
        .await?
        .iter()
        .map(User::from_row)
        .collect::<sqlx::Result<Vec<_>>>()?;
    let one = match alike.as_slice() {
        [first, rest @ ..] if rest.iter().all(|user| user.username == first.username) => {
            Some(first.clone())
        }
        _ => None,
    };
    Ok(match exact {
        Some(user) => Some(user).filter(|user| user.password_hash != PURGING_HASH),
        None => one,
    })
}

/// The `login_attempts` rows a sign-in as `name` is paced and counted under, sorted (the order
/// they are locked in): the account it reaches, and each look-alike key of `name` behind an `@`,
/// which no username holds. A spelling reaches an account through a key the account's username
/// is stored under, so two spellings that reach it through one key share a pace whether or not
/// the account exists, and a name that passes for several accounts counts against none of them.
pub(crate) fn pace_keys(account: Option<&User>, name: &str) -> Vec<String> {
    let mut rows: Vec<String> = name_keys(name)
        .iter()
        .map(|key| format!("@{key}"))
        .chain(account.map(|user| user.username.clone()))
        .collect();
    rows.sort_unstable();
    rows.dedup();
    rows
}

/// Whether a username holds a character that shows as nothing: a hidden character
/// (`hidden_char`), a variation selector, a space other than U+0020, or a space at either end.
fn shown_as_nothing(username: &str) -> bool {
    username.trim() != username
        || username.chars().any(|c| {
            hidden_char(c)
                || (c.is_whitespace() && c != ' ')
                || matches!(c as u32, 0xfe00..=0xfe0f | 0xe0100..=0xe01ef)
        })
}

/// Why a new account can not have its name.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The name holds a hidden character, has more looks than its keys hold (`three_looks`), or
    /// it is or passes for an account's username.
    Taken,
    /// The name is or passes for a banned username.
    Banned,
}

/// Whether a new account with the lowercase `username`, shown as `shown`, is refused: the
/// username holds a character that shows as nothing (`shown_as_nothing`), the display name a
/// hidden character, the name has three looks (`three_looks`), or either passes for a username
/// that is taken or banned (compared by `name_keys` through the stored keys). Both lookups always
/// run, so every answer costs the same.
pub(crate) async fn refusal(
    conn: &mut sqlx::AnyConnection,
    username: &str,
    shown: &str,
) -> sqlx::Result<Option<Refusal>> {
    let keys = [name_keys(username), name_keys(shown)].concat();
    let mut found = [false; 2];
    for (sql, hit) in [TAKEN_SQL, BANNED_SQL].into_iter().zip(&mut found) {
        *hit = keys
            .iter()
            .fold(sqlx::query(sql), |query, key| query.bind(key))
            .bind(username)
            .fetch_optional(&mut *conn)
            .await?
            .is_some();
    }
    let [taken, banned] = found;
    let unfit = shown_as_nothing(username)
        || shown.chars().any(hidden_char)
        || three_looks(username, shown);
    Ok(match (banned, taken || unfit) {
        (true, _) => Some(Refusal::Banned),
        (false, true) => Some(Refusal::Taken),
        (false, false) => None,
    })
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
            let (key, alt) = username_keys(name, name);
            (key, alt.unwrap_or_default())
        };
        for (name, key, alt) in [
            ("alice", "alice", ""),
            ("b\u{43e}b", "bob", ""),
            ("b0b", "bob", ""),
            ("mom", "rnorn", ""),
            ("\u{2110}an", "ian", "lan"),
            ("zed\u{200b}", "zed", ""),
            ("\u{200f}amy", "arny", ""),
        ] {
            assert_eq!(stored(name), (key.to_string(), alt.to_string()), "{name}");
        }
        for (username, shown, twin) in [
            ("ian", "Ian", "lan"),
            ("aiice", "AIice", "alice"),
            ("\u{3b2}ob", "\u{392}ob", "bob"),
            ("\u{3bc}ike", "\u{39c}ike", "mike"),
            ("\u{432}en", "\u{412}en", "ben"),
            ("\u{442}om", "\u{422}om", "tom"),
            ("\u{43d}ank", "\u{41d}ank", "hank"),
            ("\u{3ba}ate", "\u{39a}ate", "kate"),
            ("\u{3bd}ina", "\u{39d}ina", "nina"),
        ] {
            let (key, alt) = username_keys(username, shown);
            assert_eq!(key, name_key(username), "{shown}: the key after folding");
            assert_eq!(alt, Some(name_key(twin)), "{shown}: its capitals");
            assert_eq!(username_keys(username, username).0, key, "{username}");
        }
        for (shown, twin) in [
            ("B\u{13a4}B", "bob"),
            ("\u{13b1}ose", "rose"),
            ("D\u{13a4}N", "don"),
            ("\u{13aa}nn", "\u{1d00}nn"),
        ] {
            let username = shown.to_lowercase();
            let (key, alt) = username_keys(&username, shown);
            assert_eq!(key, name_key(shown), "{shown}: the key after folding");
            assert_eq!(alt, Some(name_key(twin)), "{shown}: its lower case");
            assert_eq!(
                username_keys(&username, &username),
                (key, alt),
                "{username}"
            );
        }
        assert_eq!(
            username_keys("b\u{ab74}b", "B\u{13a4}B"),
            ("bo'b".to_string(), Some("bob".to_string()))
        );
        assert_eq!(
            username_keys("carol", "Lena"),
            username_keys("carol", "carol"),
            "a display name that is not the username keeps its keys off it"
        );
    }

    #[test]
    fn names_with_three_looks_are_found() {
        for name in [
            "\u{13a4}lIvia",
            "\u{13a4}LIVIA",
            "\u{13b1}Iley",
            "\u{3d2}Iq",
            "I\u{3d2}a",
        ] {
            assert!(three_looks(&name.to_lowercase(), name), "{name:?}");
        }
        for name in [
            "Ian",
            "Olivia",
            "\u{ab74}livia",
            "\u{39c}Ike",
            "\u{39c}IKE",
            "B\u{13a4}B",
            "\u{13b1}ose",
            "I\u{17f}a",
            "\u{3d2}iq",
            "zed\u{200b}",
        ] {
            assert!(!three_looks(&name.to_lowercase(), name), "{name:?}");
        }
        assert!(
            !three_looks("carol", "\u{13a4}lIvia"),
            "a display name that is not the username keeps its looks off it"
        );
        assert_eq!(
            username_keys("i\u{17f}a", "I\u{17f}a"),
            ("ifa".to_string(), Some("lfa".to_string())),
            "a long s is an f"
        );
    }

    /// A sign-up refused next to each account it is compared with, as `refusal` compares them:
    /// the keys of the new lowercase username and display name against the stored keys.
    struct Typed {
        stored: [Option<String>; 2],
        keys: Vec<String>,
        looks: [String; 2],
        lower: String,
        /// The key, the look as typed and the look in lower case all differ: one more than the
        /// two stored keys hold.
        three_looks: bool,
    }

    impl Typed {
        fn of(name: &str) -> Typed {
            let lower = name.to_lowercase();
            let (key, alt) = username_keys(&lower, name);
            let (typed, lowered) = (name_keys(name), name_keys(&lower));
            let mut keys = [lowered.clone(), typed.clone()].concat();
            keys.sort();
            keys.dedup();
            let [look, folded, _] = typed;
            let [lowered, _, _] = lowered;
            let looks = [look, lowered];
            Typed {
                stored: [Some(key), alt],
                three_looks: looks[0] != looks[1] && !looks.contains(&folded),
                looks,
                keys,
                lower,
            }
        }

        fn refuses(&self, new: &Typed) -> bool {
            self.lower == new.lower
                || new
                    .keys
                    .iter()
                    .any(|k| self.stored.contains(&Some(k.clone())))
        }
    }

    /// What a search over `names` finds: each name whose refusal at sign-up (`three_looks`) is not
    /// whether it has three looks, and, among the names that can sign up, the pairs that share a
    /// key, as (first, then), where refusal depends on which signs up first although neither name
    /// has more than two keys, or where the two look alike as typed or in lower case and one
    /// still gets in after the other.
    fn order_matters(names: &[String]) -> Vec<String> {
        let mut found = Vec::new();
        let mut typed: Vec<(&String, Typed)> = Vec::new();
        for name in names {
            let of = Typed::of(name);
            let refused = three_looks(&of.lower, name);
            if refused != of.three_looks {
                found.push(format!(
                    "{name:?}: refused {refused}, three looks {}",
                    of.three_looks
                ));
            }
            if !refused {
                typed.push((name, of));
            }
        }
        let mut sharing: std::collections::HashMap<&str, Vec<usize>> = Default::default();
        for (at, (_, name)) in typed.iter().enumerate() {
            for key in &name.keys {
                sharing.entry(key).or_default().push(at);
            }
        }
        let mut pairs: Vec<(usize, usize)> = sharing
            .values()
            .flat_map(|at| at.iter().flat_map(|a| at.iter().map(|b| (*a, *b))))
            .collect();
        pairs.sort_unstable();
        pairs.dedup();
        for (a, b) in pairs {
            let ((first_name, x), (then_name, y)) = (&typed[a], &typed[b]);
            let (first, second) = (x.refuses(y), y.refuses(x));
            let two_keys = x.keys.len() <= 2 && y.keys.len() <= 2;
            let twins = x.looks.iter().any(|look| y.looks.contains(look));
            if (first != second && two_keys) || (twins && !(first && second)) {
                found.push(format!(
                    "{first_name:?} then {then_name:?}: {first}, the other way: {second}"
                ));
            }
        }
        found
    }

    /// Refusal does not depend on which of two look-alikes signs up first, unless one of them has
    /// three keys (U+039C before `Ike`: `rnlke` as typed, `rnike` with the I read as i, and its
    /// folded key). A name that looks like an account's name as typed or in lower case is refused
    /// whichever came first, and so is each spelling next to the name it is made from when its
    /// letter has the UTS #39 look of the letter it takes the place of (`own_look`). A name with
    /// three looks (U+13A4 before `LIVIA`: `o'llvla` as typed, `olivia` in lower case, `o'livia`
    /// folded) can not sign up.
    #[test]
    fn look_alikes_clash_whichever_signs_up_first() {
        let subs: [(char, &str); 18] = [
            ('A', "\u{13aa}"),
            ('B', "\u{392}\u{412}"),
            ('C', "\u{3f9}"),
            ('E', "\u{395}\u{415}"),
            ('H', "\u{397}\u{41d}"),
            ('I', "\u{399}\u{406}l1"),
            ('K', "\u{39a}\u{41a}"),
            ('M', "\u{39c}\u{41c}"),
            ('N', "\u{39d}"),
            ('O', "\u{39f}\u{41e}0\u{13a4}"),
            ('R', "\u{13b1}"),
            ('T', "\u{3a4}\u{422}"),
            ('a', "\u{1d00}"),
            ('c', "\u{3f2}"),
            ('f', "\u{17f}"),
            ('l', "I1"),
            ('o', "0\u{43e}"),
            ('e', "\u{435}"),
        ];
        let mut names = Vec::new();
        let mut made = Vec::new();
        for base in [
            "Ian", "Bob", "Mike", "Tim", "Kate", "Hank", "Nina", "Olivia", "Bill", "Liam", "Emil",
            "Ben", "Rose", "Don", "Ann", "Carol", "Chris", "Marc", "Fred", "Jeff",
        ] {
            for form in [base.to_string(), base.to_uppercase(), base.to_lowercase()] {
                let chars: Vec<char> = form.chars().collect();
                names.push(form.clone());
                for (at, c) in chars.iter().enumerate() {
                    for (_, to) in subs.iter().filter(|(from, _)| from == c) {
                        for to in to.chars() {
                            let own = own_look(&to.to_string()) == own_look(&c.to_string());
                            let mut name = chars.clone();
                            name[at] = to;
                            let name: String = name.into_iter().collect();
                            made.push((form.clone(), name.clone(), own));
                            names.push(name);
                        }
                    }
                }
            }
        }
        let apart: Vec<String> = made
            .iter()
            .filter(|(_, _, own)| *own)
            .filter(|(from, to, _)| {
                let (from, to) = (Typed::of(from), Typed::of(to));
                !(from.three_looks || to.three_looks || (from.refuses(&to) && to.refuses(&from)))
            })
            .map(|(from, to, _)| format!("{from:?} and {to:?}"))
            .collect();
        assert_eq!(
            apart,
            Vec::<String>::new(),
            "spellings apart from their name"
        );
        names.sort();
        names.dedup();
        assert_eq!(order_matters(&names), Vec::<String>::new());
    }

    /// The same for every letter of the cased scripts and the letter-like symbols, before and
    /// after `ab`, and before and after `Ia`, `ia` and `la`, where the names with three keys and
    /// with three looks are.
    #[test]
    fn look_alike_letters_clash_whichever_signs_up_first() {
        let blocks = [
            0x41..0x5b,
            0x61..0x7b,
            0xc0..0x250,
            0x250..0x2b0,
            0x370..0x400,
            0x400..0x530,
            0x13a0..0x1400,
            0x1c80..0x1cc0,
            0x1d00..0x1dc0,
            0x1e00..0x2000,
            0x2100..0x2190,
            0x2c00..0x2d00,
            0xa640..0xa6a0,
            0xa720..0xa800,
            0xab30..0xabc0,
            0xff21..0xff5b,
            0x10400..0x10500,
            0x10c80..0x10d00,
            0x16e40..0x16ea0,
            0x1d400..0x1d800,
        ];
        let letters: Vec<char> = blocks
            .into_iter()
            .flatten()
            .filter_map(char::from_u32)
            .filter(|c| c.is_alphabetic())
            .collect();
        assert!(letters.len() > 3500, "the search covers the blocks");
        for others in [&["ab"][..], &["Ia", "ia", "la"]] {
            let names: Vec<String> = others
                .iter()
                .flat_map(|other| {
                    letters
                        .iter()
                        .flat_map(move |c| [format!("{c}{other}"), format!("{other}{c}")])
                })
                .collect();
            assert_eq!(order_matters(&names), Vec::<String>::new(), "{others:?}");
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

    /// Every account row is written by `db::write_user`, which stores the keys: through
    /// `db::insert_user`, and in tests through `NewUser::plain(..).add(..)`. SQL files write
    /// `username_key` themselves.
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
        assert_eq!(helper, 1, "db::write_user is the one insert");
        assert_eq!(other, Vec::<String>::new(), "use db::insert_user");
    }

    /// Banned names are stored with their keys too, by `admin::ban_name`.
    #[test]
    fn banned_names_are_only_inserted_with_their_keys() {
        let insert = regex::Regex::new(
            r#"(?i)\binsert\b[^;]*?\binto\s+(?:"?\w+"?\.)?"?banned_usernames"?\b"#,
        )
        .expect("pattern");
        let root = repo();
        let mut found = Vec::new();
        for dir in ["apps/server", "crates", "scripts", "deploy"] {
            sources(&root.join(dir), &root, &mut found);
        }
        let mut keyed = 0;
        let mut other = Vec::new();
        for (file, text) in &found {
            for at in insert.find_iter(text) {
                let line = text[..at.start()].matches('\n').count() + 1;
                let statement = text[at.start()..].split(';').next().unwrap_or_default();
                match file.as_str() {
                    // Rows without keys on purpose: old databases, a constraint error, a name
                    // banned before.
                    "apps/server/src/db/tests.rs"
                    | "apps/server/src/db/pool/tests.rs"
                    | "apps/server/src/api/reports/tests.rs" => {}
                    _ if statement.contains("username_key_alt") => keyed += 1,
                    _ => other.push(format!("{file}:{line}")),
                }
            }
        }
        assert_eq!(keyed, 1, "admin::ban_name is the one insert");
        assert_eq!(other, Vec::<String>::new(), "store the keys");
    }

    #[test]
    fn the_load_seed_stores_the_keys_of_its_usernames() {
        let seed = std::fs::read_to_string(repo().join("scripts/load/seed.sql")).expect("seed");
        assert!(seed.contains("translate('u' || lpad(i::text, 5, '0'), '01', 'ol')"));
        for i in 0..5000 {
            let name = format!("u{i:05}");
            let key = name.replace('0', "o").replace('1', "l");
            assert_eq!(username_keys(&name, &name), (key, None), "{name}");
        }
    }

    async fn lookup_plan(db: &Db) -> String {
        plan_of(db, OTHER_USERNAME_SQL).await
    }

    async fn plan_of(db: &Db, sql: &str) -> String {
        let sql = (1..=7).fold(sql.to_string(), |sql, n| {
            sql.replace(&format!("${n}"), &format!("'{n}'"))
        });
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
        for name in ["alice", "b\u{43e}b", "\u{2110}an", "mia"] {
            crate::db::NewUser::plain(name).at(1).add(db).await;
        }
        for (name, me, taken) in [
            ("Alice", "carol", true),
            ("AIice", "carol", true),
            ("\u{39c}ia", "carol", true),
            ("\u{39c}IA", "carol", true),
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

    async fn names_are_looked_up_by_key(db: &Db) {
        for (sql, table) in [
            (TAKEN_SQL, "users"),
            (BANNED_SQL, "banned_usernames"),
            (SIGN_IN_SQL, "users"),
        ] {
            let plan = plan_of(db, sql).await;
            let key = format!("idx_{table}_username_key");
            let alt = format!("idx_{table}_username_key_alt");
            let (all, alts) = (plan.matches(&key).count(), plan.matches(&alt).count());
            assert!(alts > 0 && all > alts, "{table}, both indexes:\n{plan}");
            assert!(
                !plan.contains(&format!("SCAN {table}")) && !plan.contains("Seq Scan"),
                "no scan over {table}:\n{plan}"
            );
        }
    }

    #[tokio::test]
    async fn names_are_matched_through_the_key_indexes() {
        let (state, path) = temp_state("names_refusal_plan").await;
        names_are_looked_up_by_key(&state.db).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("names_refusal_plan").await {
            names_are_looked_up_by_key(&state.db).await;
            pg_done(state, pg).await;
        }
    }

    async fn look_alikes_added_at_once_keep_one(db: &Db) {
        use crate::db::{NewUser, NotAdded, insert_user};
        let mut first = db.begin().await.expect("begin");
        insert_user(&mut first, NewUser::plain("bob"))
            .await
            .expect("bob");
        let other = db.clone();
        let second = tokio::spawn(async move {
            let mut tx = other.begin().await.expect("begin");
            let added = insert_user(&mut tx, NewUser::plain("b0b")).await;
            tx.commit().await.expect("commit");
            added
        });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!second.is_finished(), "the second waits for the first");
        first.commit().await.expect("commit");
        let added = second.await.expect("join");
        assert!(
            matches!(added, Err(NotAdded::Refused(Refusal::Taken))),
            "{added:?}"
        );
        let mut tx = db.begin().await.expect("begin");
        for (user, refused) in [
            (NewUser::plain("zed").shown("B0B"), Some(Refusal::Taken)),
            (
                NewUser::plain("zed").shown("Zed\u{200b}"),
                Some(Refusal::Taken),
            ),
            (NewUser::plain("zed").shown("Zed"), None),
        ] {
            let shown = user.display_name;
            match (insert_user(&mut tx, user).await, refused) {
                (Err(NotAdded::Refused(got)), Some(want)) => assert_eq!(got, want, "{shown:?}"),
                (Ok(()), None) => {}
                (got, want) => panic!("{shown:?}: {got:?}, want {want:?}"),
            }
        }
        tx.commit().await.expect("commit");
        let count: i64 =
            sqlx::query("SELECT COUNT(*) FROM users WHERE username IN ('bob', 'b0b', 'zed')")
                .fetch_one(db)
                .await
                .expect("count")
                .try_get(0)
                .expect("count value");
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn look_alikes_added_at_once_never_both_get_in() {
        let (state, path) = temp_state("names_at_once").await;
        look_alikes_added_at_once_keep_one(&state.db).await;
        done(state, path).await;
        if let Some((state, pg)) = pg_state("names_at_once").await {
            look_alikes_added_at_once_keep_one(&state.db).await;
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
            ("zed\u{200b}", "zed"),
            ("\u{200f}amy", "amy"),
            ("bea\u{2060}", "bea"),
            ("cy\u{ad}d", "cyd"),
            ("\u{3164}bob", "bob"),
            ("b\u{feff}ob", "bob"),
            ("bob\u{1d159}", "bob"),
            ("\u{39c}ike", "mike"),
            ("\u{41c}ax", "max"),
            ("SA\u{39c}", "sam"),
            ("\u{13b7}o\u{13b7}", "mom"),
            ("\u{ab87}ia", "mia"),
            ("\u{39c}IKE", "mike"),
            ("\u{39c}ILO", "milo"),
            ("TI\u{39c}", "tim"),
            ("b\u{f8}b", "bob"),
            ("\u{111}an", "dan"),
            ("\u{142}uke", "luke"),
            ("\u{906}", "\u{905}\u{93e}"),
            ("\u{17f}red", "fred"),
            ("je\u{17f}\u{17f}", "Jeff"),
            ("\u{1e9b}ox", "fox"),
            ("\u{3f2}arol", "Carol"),
            ("\u{3f9}hris", "Chris"),
            ("Mar\u{3f2}", "marc"),
            ("\u{ffe8}ily", "lily"),
            ("\u{c02}livia", "olivia"),
        ] {
            assert!(names_clash(&name_keys(a), &name_keys(b)), "{a} vs {b}");
        }
        assert!(
            !names_clash(&name_keys("\u{17f}am"), &name_keys("sam")),
            "a long s is not an s"
        );
        let ms = "\u{271}\u{39c}\u{3fa}\u{41c}\u{4cd}\u{13b7}\u{15f0}\u{16d6}\u{1d6f}\u{1dac}\u{20a5}\u{2c6e}\u{2c98}\u{a4df}\u{ab87}\u{102b0}\u{10311}\u{1d6b3}\u{1d6ed}\u{1d727}\u{1d761}\u{1d79b}";
        for c in ms.chars() {
            let name = format!("{c}ike");
            assert!(
                names_clash(&name_keys(&name), &name_keys("mike")),
                "{name} passes for M"
            );
        }
        assert!(
            name_keys("\u{200b}\u{3164}\u{2060}")
                .iter()
                .all(String::is_empty),
            "hidden characters alone are no name"
        );
        assert!(!names_clash(&name_keys("alice"), &name_keys("alicia")));
        for c in [
            '\u{200b}',
            '\u{200d}',
            '\u{2060}',
            '\u{feff}',
            '\u{ad}',
            '\u{202e}',
            '\u{2028}',
            '\u{3164}',
            '\u{1d159}',
            '\t',
        ] {
            assert!(hidden_char(c), "{:?}", c);
        }
        for c in ['a', ' ', 'é', '☕', '\u{fe0f}'] {
            assert!(!hidden_char(c), "{:?}", c);
        }
    }

    /// The look UTS #39 gives `name` by itself: its skeleton, folded, taken again until it is its
    /// own look.
    fn own_look(name: &str) -> String {
        let mut look = name.to_string();
        for _ in 0..8 {
            let next = caseless::default_case_fold_str(
                &unicode_security::skeleton(&look).collect::<String>(),
            );
            if next == look {
                break;
            }
            look = next;
        }
        look
    }

    /// Each character whose own UTS #39 look is ASCII letters or digits has that look among its
    /// keys, as typed or in lower case. Read through compatibility normalization and with its
    /// marks dropped, the characters of `OWN_LOOKS` alone would lose it: a long s turns into s,
    /// the lunate sigmas into sigma, the ogonek and the ypogegrammeni into a mark, the halfwidth
    /// bar into a box line, and the anusvara signs and the Oriya visarga are marks.
    #[test]
    fn characters_keep_their_own_look() {
        let ascii =
            |look: &str| !look.is_empty() && look.chars().all(|c| c.is_ascii_alphanumeric());
        let looks: Vec<(char, String)> = (0..0x110000)
            .filter_map(char::from_u32)
            .filter(|c| !hidden_char(*c) && !c.is_whitespace())
            .filter(|c| !matches!(*c as u32, 0xfe00..=0xfe0f | 0xe0100..=0xe01ef))
            .map(|c| (c, own_look(&c.to_string())))
            .filter(|(_, look)| ascii(look))
            .collect();
        assert!(looks.len() > 1000, "the scan covers the confusables");
        let missing = |keys_of: &dyn Fn(&str) -> [String; 3]| -> Vec<String> {
            looks
                .iter()
                .filter(|(c, look)| {
                    let name = c.to_string();
                    let keys = [keys_of(&name), keys_of(&name.to_lowercase())].concat();
                    !keys.contains(look)
                })
                .map(|(c, _)| format!("U+{:04X}", *c as u32))
                .collect()
        };
        assert_eq!(missing(&name_keys), Vec::<String>::new());
        assert_eq!(
            missing(&|name: &str| keys_reading(name, &[])),
            OWN_LOOKS.map(|(c, _)| format!("U+{c:04X}")).to_vec(),
            "the characters that need their own look"
        );
        for (c, look) in OWN_LOOKS {
            let c = char::from_u32(c).expect("a character");
            let look = look.to_lowercase().to_string();
            assert_eq!(own_look(&c.to_string()), look, "{c:?}");
            assert_eq!(name_keys(&c.to_string())[1], look, "{c:?}");
        }
    }

    /// Each key is stored as its own key, so whatever passes for a name passes for its key too.
    #[test]
    fn keys_are_their_own_keys() {
        let blocks = [
            0x20..0x530,
            0x900..0x980,
            0x13a0..0x1400,
            0x1d00..0x2000,
            0x2100..0x2190,
            0x2c60..0x2d00,
            0xa4d0..0xa500,
            0xab70..0xabc0,
            0xff00..0xff60,
        ];
        let names = blocks
            .into_iter()
            .flatten()
            .filter_map(char::from_u32)
            .map(String::from)
            .chain(
                [
                    "Mike",
                    "\u{39c}IKE",
                    "SA\u{39c}",
                    "b\u{f8}b",
                    "\u{2110}an",
                    "AIice",
                ]
                .map(String::from),
            );
        for name in names {
            for key in name_keys(&name) {
                let (stored, alt) = username_keys(&key, &key);
                assert!(
                    stored == key || alt.as_ref() == Some(&key),
                    "{name:?}: key {key:?} is stored as {stored:?} / {alt:?}"
                );
            }
        }
    }
}
