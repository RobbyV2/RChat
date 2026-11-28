//! The site admin page's rows: each live setting's label, line and how the page shows it.
//! Its kind, range and env name come from its item. `rows_ts` writes the web app's rows.

use crate::Setting;
use crate::items::*;

/// A choice's option.
pub struct Opt {
    pub value: &'static str,
    pub label: &'static str,
    /// What choosing it means.
    pub line: Option<&'static str>,
}

/// How the page shows a row.
pub enum View {
    /// `off`: what off means, shown while it is off.
    Switch {
        off: Option<&'static str>,
    },
    /// `list`: a list with each option's line instead of chips; `note`: shown under the choices.
    Choice {
        options: &'static [Opt],
        list: bool,
        note: Option<&'static str>,
    },
    Number {
        unit: &'static str,
    },
    Targets,
    Names,
    /// A control another section edits.
    Link {
        to: &'static str,
        action: &'static str,
    },
    /// A control only the server config or its own editor sets.
    Info,
    Text {
        placeholder: Option<&'static str>,
    },
    Links,
    Suggestions,
}

/// Where a row sits.
pub enum Place {
    /// The Features section: its group, and the key of the row it sits under.
    Features {
        group: &'static str,
        under: Option<&'static str>,
    },
    Branding,
}

pub struct Row {
    pub setting: &'static Setting,
    pub place: Place,
    pub label: &'static str,
    pub line: &'static str,
    pub keywords: &'static [&'static str],
    pub view: View,
}

/// The Features section's groups, in order.
pub const GROUPS: &[&str] = &[
    "Accounts",
    "Servers",
    "Privacy",
    "Messages and files",
    "Calls",
    "P2P",
    "Safety",
    "Widgets",
    "Encryption",
    "This site's app",
];

const fn row(
    setting: &'static Setting,
    place: Place,
    label: &'static str,
    line: &'static str,
    keywords: &'static [&'static str],
    view: View,
) -> Row {
    Row {
        setting,
        place,
        label,
        line,
        keywords,
        view,
    }
}

const fn features(group: &'static str) -> Place {
    Place::Features { group, under: None }
}

const fn under(group: &'static str, key: &'static str) -> Place {
    Place::Features {
        group,
        under: Some(key),
    }
}

/// Every row, in the page's order.
pub const ROWS: &[Row] = &[
    row(
        &AUTH_REGISTRATION.setting,
        features("Accounts"),
        "New accounts",
        "Who can sign up with a password.",
        &["sign-up", "signup", "registration", "register"],
        View::Choice {
            options: &[
                Opt {
                    value: "open",
                    label: "Open",
                    line: Some("Anyone can create an account."),
                },
                Opt {
                    value: "sso",
                    label: "Sign-on only",
                    line: Some("Accounts come from your sign-in provider."),
                },
                Opt {
                    value: "closed",
                    label: "Closed",
                    line: Some("Nobody can sign up."),
                },
            ],
            list: true,
            note: None,
        },
    ),
    row(
        &AUTH_PASSWORD_LOGIN.setting,
        features("Accounts"),
        "Password sign-in",
        "Lets people sign in and sign up with a password.",
        &["login", "log in"],
        View::Switch {
            off: Some("No new passwords. Existing ones still work."),
        },
    ),
    row(
        &TEMP_PASSWORD_CHANGE.setting,
        features("Accounts"),
        "Temporary passwords",
        "What people do after they sign in with a temporary password.",
        &["temp", "reset", "first sign-in"],
        View::Choice {
            options: &[
                Opt {
                    value: "required",
                    label: "Change required",
                    line: Some("They choose their own password before anything else."),
                },
                Opt {
                    value: "encouraged",
                    label: "Change encouraged",
                    line: Some("They are asked to, and must once the temporary password expires."),
                },
            ],
            list: false,
            note: None,
        },
    ),
    row(
        &TEMP_PASSWORD_HOURS.setting,
        under("Accounts", "password_change"),
        "Temporary passwords last",
        "Hours a temporary password signs in, 1 to 720. 0: it never expires.",
        &["temp", "expiry", "lifetime"],
        View::Number { unit: "hours" },
    ),
    row(
        &GUESTS_ENABLED.setting,
        features("Accounts"),
        "Guests",
        "Lets people open servers without an account.",
        &[],
        View::Switch {
            off: Some("Guests can't read anything. Their pages show sign-in."),
        },
    ),
    row(
        &GUEST_CHAT_ENABLED.setting,
        under("Accounts", "guests_enabled"),
        "Guest text chat",
        "Lets servers allow messages from guests.",
        &[],
        View::Switch {
            off: Some("No server takes guest messages. Each keeps its choice for later."),
        },
    ),
    row(
        &GUEST_VOICE_ENABLED.setting,
        under("Accounts", "guests_enabled"),
        "Guest voice",
        "Lets servers allow guests in voice channels.",
        &[],
        View::Switch {
            off: Some(
                "No server takes guests in voice, and guests in calls leave. Each keeps its choice for later.",
            ),
        },
    ),
    row(
        &FEATURE_DISPLAY_NAMES.setting,
        features("Accounts"),
        "Display names",
        "Lets people change their display name.",
        &[],
        View::Switch {
            off: Some("Display names stay as they are."),
        },
    ),
    row(
        &FEATURE_ONBOARDING.setting,
        features("Accounts"),
        "Onboarding",
        "Shows new accounts a short tour.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_BACKUP_PHRASE.setting,
        features("Accounts"),
        "Backup phrase",
        "Lets people set or reset a backup phrase.",
        &["recovery"],
        View::Switch {
            off: Some("Existing phrases still work."),
        },
    ),
    row(
        &SERVER_CREATION.setting,
        features("Servers"),
        "Who can create servers",
        "Existing servers and their owners are untouched.",
        &[],
        View::Choice {
            options: &[
                Opt {
                    value: "everyone",
                    label: "Everyone",
                    line: Some("Anyone with an account can create a server."),
                },
                Opt {
                    value: "nobody",
                    label: "Nobody",
                    line: Some(
                        "Nobody can create a server. You can still make one for someone in Servers.",
                    ),
                },
                Opt {
                    value: "some",
                    label: "Some people",
                    line: Some("Only the people and holders of the roles on the list below."),
                },
            ],
            list: false,
            note: None,
        },
    ),
    row(
        &SERVER_CREATORS.setting,
        under("Servers", "server_creation"),
        "People who can create servers",
        "Usernames, and roles as server:role, for example lobby:Staff. Used while only some people can create servers.",
        &["creators"],
        View::Names,
    ),
    row(
        &SERVER_JOINING.setting,
        features("Servers"),
        "How people join servers",
        "Members stay whatever you choose, and leaving works.",
        &["invite", "private"],
        View::Choice {
            options: &[
                Opt {
                    value: "everyone",
                    label: "Everyone",
                    line: Some("Anyone can join a server by its name."),
                },
                Opt {
                    value: "invites",
                    label: "Only with an invite or password",
                    line: Some("Servers can't be opened or joined by name alone."),
                },
                Opt {
                    value: "nobody",
                    label: "Nobody",
                    line: Some("Only members can open servers. Nobody new can join."),
                },
            ],
            list: false,
            note: None,
        },
    ),
    row(
        &PUBLIC_READING.setting,
        features("Servers"),
        "Public reading",
        "Lets a server's owner let people who aren't members read it.",
        &[],
        View::Switch {
            off: Some("Only members read servers."),
        },
    ),
    row(
        &SERVER_SEARCH.setting,
        features("Servers"),
        "Server search",
        "Lets people find servers by name.",
        &["discovery", "browse"],
        View::Switch {
            off: Some(
                "Browsing and join suggestions are hidden. Servers stay reachable by name or invite.",
            ),
        },
    ),
    row(
        &DEFAULT_SERVERS.setting,
        features("Servers"),
        "Default servers",
        "The servers every new account joins. Guests start in the ones anyone can read.",
        &[],
        View::Link {
            to: "servers",
            action: "Edit in Servers",
        },
    ),
    row(
        &PROFILE_VISIBILITY.setting,
        features("Privacy"),
        "Who can see profiles",
        "Description, banner and account age.",
        &[],
        View::Choice {
            options: &[
                Opt {
                    value: "everyone",
                    label: "Everyone",
                    line: Some("Anyone who can use the app here sees every profile."),
                },
                Opt {
                    value: "public_servers",
                    label: "People in public servers",
                    line: Some(
                        "Profiles of people in a public server are open to all. Others show only to people who share a server with them.",
                    ),
                },
                Opt {
                    value: "shared",
                    label: "People who share a server",
                    line: Some(
                        "A profile shows only to people who share a server, a DM or a friendship with that person.",
                    ),
                },
            ],
            list: true,
            note: Some(
                "Names next to messages and in member lists always show where people can read them.",
            ),
        },
    ),
    row(
        &PROFILE_CHOICES.setting,
        features("Privacy"),
        "What accounts may choose",
        r#"For "Who can see your profile and find you by name" in their settings."#,
        &[],
        View::Choice {
            options: &[
                Opt {
                    value: "any",
                    label: "Anything",
                    line: Some("Friends only, people who share a server, or everyone."),
                },
                Opt {
                    value: "narrower",
                    label: "Only narrower",
                    line: Some(
                        "Only choices that show the profile to fewer people than the site does.",
                    ),
                },
                Opt {
                    value: "site",
                    label: "Nothing",
                    line: Some("Every account follows the site."),
                },
            ],
            list: true,
            note: None,
        },
    ),
    row(
        &DM_CREATION.setting,
        features("Messages and files"),
        "Direct messages",
        "Who can start a direct conversation. Existing ones keep working.",
        &["dm", "dms"],
        View::Choice {
            options: &[
                Opt {
                    value: "everyone",
                    label: "Everyone",
                    line: Some("Anyone can start a direct conversation."),
                },
                Opt {
                    value: "friends",
                    label: "Only between friends",
                    line: Some("Only friends can start a direct conversation."),
                },
                Opt {
                    value: "nobody",
                    label: "Nobody",
                    line: Some("Nobody can start a new direct conversation."),
                },
            ],
            list: false,
            note: None,
        },
    ),
    row(
        &FEATURE_FRIEND_REQUESTS.setting,
        features("Messages and files"),
        "Friend requests",
        "Lets people send friend requests.",
        &[],
        View::Switch {
            off: Some(
                "New requests are refused. Pending ones can still be answered, and friends stay.",
            ),
        },
    ),
    row(
        &FEATURE_FILE_UPLOADS.setting,
        features("Messages and files"),
        "File uploads",
        "Lets people upload files to this instance.",
        &["attachments"],
        View::Switch {
            off: Some("Files already uploaded stay."),
        },
    ),
    row(
        &UPLOAD_EXPIRY_MAX_DAYS.setting,
        under("Messages and files", "asset_uploads"),
        "Longest file expiry",
        "Days a server may keep uploaded files, 1 to 365. 0: no limit, and servers may keep files until they are removed.",
        &[],
        View::Number { unit: "days" },
    ),
    row(
        &P2P_ATTACHMENTS.setting,
        features("Messages and files"),
        "P2P attachments",
        "Files stay in the sender's browser, with no size limit.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_LINK_PREVIEWS.setting,
        features("Messages and files"),
        "Link previews",
        "Shows a preview of links in messages.",
        &["embeds"],
        View::Switch { off: None },
    ),
    row(
        &OUTGOING_WEBHOOKS.setting,
        features("Messages and files"),
        "Outgoing webhooks",
        "Lets server managers send events to URLs they choose.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_INCOMING_WEBHOOKS.setting,
        features("Messages and files"),
        "Incoming webhooks",
        "Lets server managers post messages from other services.",
        &[],
        View::Switch {
            off: Some("None can be created and none post. Existing ones are kept."),
        },
    ),
    row(
        &FEATURE_CALLS.setting,
        features("Calls"),
        "Calls",
        "Voice channels and calls through this instance.",
        &["voice"],
        View::Switch {
            off: Some(
                "Running calls end and nobody can start one. Voice channels stay. P2P calls follow Peer-to-peer.",
            ),
        },
    ),
    row(
        &FEATURE_SFU.setting,
        features("Calls"),
        "Media server",
        "Sends calls through the media server when it runs.",
        &["sfu"],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_P2P.setting,
        features("P2P"),
        "Peer-to-peer",
        "Shows P2P servers and conversations in the app.",
        &[],
        View::Switch {
            off: Some("The app hides P2P. Data stays on devices."),
        },
    ),
    row(
        &FEATURE_P2P_BACKUP.setting,
        features("P2P"),
        "P2P backups",
        "Lets people store P2P backups here.",
        &[],
        View::Switch {
            off: Some("No new backups. Restores always work."),
        },
    ),
    row(
        &PROFANITY_FILTER.setting,
        features("Safety"),
        "Profanity filter",
        "Blocks profanity in what people post.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &PROFANITY_TARGETS.setting,
        under("Safety", "profanity_filter"),
        "Profanity filter applies to",
        "What the filter checks while it is on.",
        &[],
        View::Targets,
    ),
    row(
        &PROFANITY_STRICT_FILE_NAMES.setting,
        under("Safety", "profanity_filter"),
        "Strict file names",
        "Also checks file names and the paths of links like messages, extension included. Only while the filter checks file names.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_SERVER_REPORTS.setting,
        features("Safety"),
        "Server reports",
        "Lets people report to a server's moderators.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_INSTANCE_REPORTS.setting,
        features("Safety"),
        "Instance reports",
        "Lets people report to this instance.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &REPORT_FORMS_FILE.setting,
        features("Safety"),
        "Report forms",
        "The report categories and their fields. The server config names a file that holds them.",
        &[],
        View::Info,
    ),
    row(
        &WIDGETS.setting,
        features("Widgets"),
        "Widgets",
        "Lets servers embed their chat on other sites.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_WIDGET_CHAT.setting,
        features("Widgets"),
        "Widget chat",
        "Lets widget visitors send messages and quick join.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_WIDGET_READ_LINKS.setting,
        features("Widgets"),
        "Widget read links",
        "Lets read-only widget links work.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &WIDGET_BRIDGE.setting,
        features("Widgets"),
        "Widget bridge",
        "Serves widgets for P2P servers through a bridge.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &E2EE.setting,
        features("Encryption"),
        "Encryption",
        "Lets servers and DMs turn on end-to-end encryption.",
        &["e2ee"],
        View::Switch { off: None },
    ),
    row(
        &E2EE_COMPLIANCE.setting,
        features("Encryption"),
        "Encryption archive",
        "Adds a compliance archive to new encrypted spaces.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_CLIENT_OTHER_INSTANCES.setting,
        features("This site's app"),
        "Other instances in this site's app",
        "Lets people add other instances in this site's web app. Other apps ignore it.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_SERVER_PROFILES.setting,
        features("Servers"),
        "Server profiles",
        "Lets members set a name, avatar, banner and description per server.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_DOCS.setting,
        features("This site's app"),
        "Documentation",
        "Serves the documentation at /docs.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_SCHEDULED_MESSAGES.setting,
        features("Messages and files"),
        "Scheduled messages",
        "Lets people schedule messages that this site sends for them later. Turning it off stops new ones; scheduled ones still send.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_INTERACTIVE_DOCS.setting,
        features("This site's app"),
        "Interactive docs",
        "Lets the docs run requests as the accounts people hold on this site.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_MEMBER_LISTS.setting,
        features("Servers"),
        "Member lists",
        "Allow users to view server member lists. Turning this off hides member lists across all servers.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_PROFILE_PICTURES.setting,
        features("Accounts"),
        "Profile pictures",
        "Lets people upload a profile picture. Turning it off stops uploads and shows the built-in avatars.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &FEATURE_ANIMATED_PROFILE_PICTURES.setting,
        under("Accounts", "profile_pictures"),
        "Animated pictures",
        "Keeps the animation of an animated upload. Turning it off keeps and shows only the first frame.",
        &[],
        View::Switch { off: None },
    ),
    row(
        &INSTANCE_NAME.setting,
        Place::Branding,
        "Instance name",
        "The name people see for the instance, here and in other apps.",
        &["site name", "title"],
        View::Text { placeholder: None },
    ),
    row(
        &BRAND_APP_NAME.setting,
        Place::Branding,
        "App name",
        "The name of the app served here: the page title and the installed app. Empty uses the instance name.",
        &["title", "white label"],
        View::Text { placeholder: None },
    ),
    row(
        &BRAND_SHORT_NAME.setting,
        Place::Branding,
        "Short name",
        "The name under the icon on a home screen. Empty uses the app name.",
        &["home screen", "install"],
        View::Text { placeholder: None },
    ),
    row(
        &BRAND_ABOUT.setting,
        Place::Branding,
        "About text",
        "Plain text shown where the app tells about itself.",
        &["description", "information"],
        View::Text { placeholder: None },
    ),
    row(
        &BRAND_LINKS.setting,
        Place::Branding,
        "Links",
        "Up to 4 links shown with the about text and under the sign-in form.",
        &["help", "terms", "privacy"],
        View::Links,
    ),
    row(
        &BRAND_LOGIN_NOTE.setting,
        Place::Branding,
        "Sign-in note",
        "Plain text under the sign-in form, for example how to get an account.",
        &["login", "log in"],
        View::Text { placeholder: None },
    ),
    row(
        &INSTANCE_SUGGESTIONS.setting,
        Place::Branding,
        "Instances the app suggests",
        "Up to 20 instances offered when someone adds an instance.",
        &["servers list", "default list", "other instances"],
        View::Suggestions,
    ),
];

fn js(text: &str) -> String {
    serde_json::to_string(text).expect("json")
}

fn object(fields: &[(&str, String)]) -> String {
    let body: Vec<String> = fields.iter().map(|(k, v)| format!("{k}: {v}")).collect();
    format!("{{ {} }}", body.join(", "))
}

fn row_ts(r: &Row) -> String {
    let s = r.setting;
    let key = s.key.expect("a row's setting is live");
    let mut f = vec![("key", js(key)), ("env", js(s.env))];
    if let Place::Features { group, under } = r.place {
        f.push(("group", js(group)));
        if let Some(under) = under {
            f.push(("under", js(under)));
        }
    }
    let kind = match r.view {
        View::Switch { off: _ } => "switch",
        View::Choice {
            options: _,
            list: _,
            note: _,
        } => "choice",
        View::Number { unit: _ } => "number",
        View::Targets => "targets",
        View::Names => "names",
        View::Link { to: _, action: _ } => "link",
        View::Info => "info",
        View::Text { placeholder: _ } => "text",
        View::Links => "links",
        View::Suggestions => "suggestions",
    };
    f.push(("kind", js(kind)));
    f.push(("label", js(r.label)));
    f.push(("line", js(r.line)));
    if !r.keywords.is_empty() {
        let words: Vec<String> = r.keywords.iter().map(|k| js(k)).collect();
        f.push(("keywords", format!("[{}]", words.join(", "))));
    }
    match (&r.view, s.kind) {
        (View::Switch { off }, _) => {
            if let Some(off) = off {
                f.push(("off", js(off)));
            }
        }
        (
            View::Choice {
                options,
                list,
                note,
            },
            _,
        ) => {
            let options: Vec<String> = options
                .iter()
                .map(|o| {
                    let mut of = vec![("value", js(o.value)), ("label", js(o.label))];
                    if let Some(line) = o.line {
                        of.push(("line", js(line)));
                    }
                    object(&of)
                })
                .collect();
            f.push(("options", format!("[{}]", options.join(", "))));
            if *list {
                f.push(("list", "true".to_string()));
            }
            if let Some(note) = note {
                f.push(("note", js(note)));
            }
        }
        (View::Number { unit }, crate::Kind::Number { min, max }) => {
            f.push(("min", min.to_string()));
            f.push(("max", max.to_string()));
            f.push(("unit", js(unit)));
        }
        (View::Text { placeholder }, crate::Kind::Text { min, max, lines }) => {
            f.push(("min", min.to_string()));
            f.push(("max", max.to_string()));
            f.push(("lines", lines.to_string()));
            if let Some(p) = placeholder {
                f.push(("placeholder", js(p)));
            }
        }
        (View::Link { to, action }, _) => {
            f.push(("to", js(to)));
            f.push(("action", js(action)));
        }
        (View::Number { unit: _ } | View::Text { placeholder: _ }, kind) => {
            panic!("{}: a {kind:?} setting", s.env)
        }
        (View::Targets | View::Names | View::Info | View::Links | View::Suggestions, _) => {}
    }
    object(&f)
}

/// `apps/web/app/lib/admin/rows.gen.ts`: the admin page's rows and the settings' number defaults.
pub fn rows_ts() -> String {
    let groups: Vec<String> = GROUPS.iter().map(|g| js(g)).collect();
    let features: Vec<String> = ROWS
        .iter()
        .filter(|r| matches!(r.place, Place::Features { group: _, under: _ }))
        .map(|r| format!("  {},\n", row_ts(r)))
        .collect();
    let branding: Vec<String> = ROWS
        .iter()
        .filter(|r| matches!(r.place, Place::Branding))
        .map(|r| format!("  {},\n", row_ts(r)))
        .collect();
    let kinds: Vec<String> = crate::ALL
        .iter()
        .filter_map(|s| {
            let kind = match s.kind {
                crate::Kind::Switch => "switch",
                crate::Kind::Choice(_) => "choice",
                crate::Kind::Number { min: _, max: _ } => "number",
                crate::Kind::Text {
                    min: _,
                    max: _,
                    lines: _,
                } => "text",
                crate::Kind::Targets => "targets",
                crate::Kind::Names => "names",
                crate::Kind::Forms => "forms",
                crate::Kind::Servers => "servers",
                crate::Kind::Links => "links",
                crate::Kind::Suggestions => "suggestions",
                crate::Kind::Numbers
                | crate::Kind::Pins
                | crate::Kind::Value
                | crate::Kind::Secret => return None,
            };
            Some(format!("  {}: {},\n", s.key?, js(kind)))
        })
        .collect();
    let defaults: Vec<String> = crate::ALL
        .iter()
        .filter_map(|s| match s.default {
            crate::Preset::Number(n) => Some(format!("  {}: {n},\n", s.env)),
            _ => None,
        })
        .collect();
    format!(
        "// Written by `UPDATE_FIXTURES=1 cargo test -p rchat-settings` from crates/settings: the site\n\
         // admin page's rows and the number settings' defaults.\n\n\
         import type {{ BrandRow }} from '../admin_brand'\n\
         import type {{ AdminRow }} from '../admin_rows'\n\n\
         export const ADMIN_GROUPS = [{}] as const\n\n\
         export const ADMIN_ROWS: AdminRow[] = [\n{}]\n\n\
         export const BRAND_ROWS: BrandRow[] = [\n{}]\n\n\
         export const SETTING_DEFAULTS = {{\n{}}} as const\n\n\
         // How each control's value is written, by key.\n\
         export const CONTROL_KINDS: Record<string, string> = {{\n{}}}\n",
        groups.join(", "),
        features.concat(),
        branding.concat(),
        defaults.concat(),
        kinds.concat()
    )
}
