use prost::Message;
use prost::encoding::{WireType, encode_key, encode_varint};
use rchat_fed::ids::letter_id;
use rchat_fed::pb::{
    self, Hello, LetterCore, LetterEntry, LetterKind, Malformed, P2pEntry, letter_entry::Who,
};

fn core() -> LetterCore {
    LetterCore {
        v: 1,
        kind: LetterKind::Message as i32,
        author: "alice@a.example".to_string(),
        uid: "u1".to_string(),
        to: vec![LetterEntry {
            who: Some(Who::Acct("bob@b.example".to_string())),
        }],
        subject: "Q3 plan".to_string(),
        body: "Hello".to_string(),
        ts: 1_800_000_000_000,
        salt: vec![1; 16],
        ..LetterCore::default()
    }
}

fn field(tag: u32, bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    encode_key(tag, WireType::LengthDelimited, &mut out);
    encode_varint(bytes.len() as u64, &mut out);
    out.extend_from_slice(bytes);
    out
}

fn varint(tag: u32, value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    encode_key(tag, WireType::Varint, &mut out);
    encode_varint(value, &mut out);
    out
}

fn with_new_fields(base: &[u8]) -> Vec<u8> {
    [base, &field(40, b"added later"), &field(41, &[8, 1])].concat()
}

#[test]
fn an_older_reader_decodes_a_newer_message_and_keeps_every_known_field() {
    let bytes = with_new_fields(&core().encode_to_vec());
    let got = LetterCore::decode(bytes.as_slice()).unwrap();
    assert_eq!(got.subject, "Q3 plan");
    assert_eq!(got.to[0].who, Some(Who::Acct("bob@b.example".to_string())));
}

#[test]
fn content_ids_are_over_the_bytes_as_received_so_unknown_fields_never_change_them() {
    let bytes = with_new_fields(&core().encode_to_vec());
    let id = letter_id(&bytes);
    assert_eq!(id.len(), 43);
    let stripped = LetterCore::decode(bytes.as_slice())
        .unwrap()
        .encode_to_vec();
    assert_ne!(stripped, bytes);
    assert_ne!(letter_id(&stripped), id);
}

#[test]
fn an_unknown_enum_value_is_read_as_its_number() {
    let got = LetterCore::decode(varint(2, 9).as_slice()).unwrap();
    assert_eq!(got.kind, 9);
    assert!(LetterKind::try_from(got.kind).is_err());
}

#[test]
fn a_new_oneof_member_reads_as_an_entry_of_no_known_kind() {
    let got = LetterEntry::decode(field(3, b"future-kind-of-recipient").as_slice()).unwrap();
    assert_eq!(got.who, None);
}

#[test]
fn a_known_field_with_the_wrong_wire_type_fails_to_decode() {
    assert!(LetterCore::decode(varint(9, 5).as_slice()).is_err());
    assert_eq!(
        pb::decode::<LetterCore>(&varint(9, 5), 1024),
        Err(Malformed::Decode)
    );
}

#[test]
fn invalid_utf8_in_a_string_field_is_malformed() {
    assert_eq!(
        pb::decode::<LetterCore>(&[0x52, 0x02, 0xff, 0xfe], 1024),
        Err(Malformed::Decode)
    );
}

#[test]
fn a_removed_field_from_an_older_writer_is_an_unknown_field_ignored() {
    let bytes = [field(1, b"blind123"), field(2, b"Dana")].concat();
    let got = P2pEntry::decode(bytes.as_slice()).unwrap();
    assert_eq!(got.blind, "blind123");
    assert!(!format!("{got:?}").contains("Dana"));
}

#[test]
fn defaults_are_absent_on_the_wire_an_empty_hello_is_zero_bytes() {
    assert!(Hello::default().encode_to_vec().is_empty());
}

#[test]
fn a_truncated_body_is_malformed() {
    let bytes = core().encode_to_vec();
    assert_eq!(
        pb::decode::<LetterCore>(&bytes[..bytes.len() - 3], 1024),
        Err(Malformed::Decode)
    );
    assert_eq!(pb::decode::<LetterCore>(&bytes, 1024), Ok(core()));
}

#[test]
fn a_body_over_its_limit_is_refused_before_decoding() {
    let bytes = core().encode_to_vec();
    assert_eq!(
        pb::decode::<LetterCore>(&bytes, bytes.len() - 1),
        Err(Malformed::TooLarge)
    );
    assert_eq!(
        pb::decode::<LetterCore>(&[0xff; 64], 63),
        Err(Malformed::TooLarge)
    );
    assert!(pb::decode::<LetterCore>(&bytes, bytes.len()).is_ok());
}

#[test]
fn nesting_deeper_than_the_recursion_limit_is_malformed() {
    let mut deep = Vec::new();
    for _ in 0..150 {
        encode_key(40, WireType::StartGroup, &mut deep);
    }
    for _ in 0..150 {
        encode_key(40, WireType::EndGroup, &mut deep);
    }
    assert_eq!(
        pb::decode::<LetterCore>(&deep, 4096),
        Err(Malformed::Decode)
    );
    let mut shallow = Vec::new();
    for _ in 0..20 {
        encode_key(40, WireType::StartGroup, &mut shallow);
    }
    for _ in 0..20 {
        encode_key(40, WireType::EndGroup, &mut shallow);
    }
    assert_eq!(
        pb::decode::<LetterCore>(&shallow, 4096),
        Ok(LetterCore::default())
    );
}

mod ranges {
    use prost::Message;
    use rchat_fed::limits::hello::{
        BUDGETS_MAX, CALL_KIDS_MAX, ENDORSEMENTS_MAX, FEATURES_MAX, MAJORS_MAX, POLICY_MAX,
        TEXT_MAX,
    };
    use rchat_fed::limits::ranges::{NAME_MAX, QUERY_MAX, REPORT_IDS_MAX, USERNAMES_MAX};
    use rchat_fed::pb::{
        self, AvatarRequest, FeatureLevel, FeaturePolicy, ForwardRequest, GetRequest, Hello,
        HelloAnswer, HelloRequest, IconRequest, KeyEndorsement, Malformed, Ranged, SealedKey,
        SearchRequest, ServiceBudget,
    };

    fn hello(name: &str) -> HelloRequest {
        HelloRequest {
            caller: Some(Hello {
                name: name.to_string(),
                ..Hello::default()
            }),
        }
    }

    #[test]
    fn a_hello_names_its_caller_in_at_most_64_characters() {
        assert!(hello(&"n".repeat(NAME_MAX)).in_range());
        assert!(hello(&"\u{e9}".repeat(NAME_MAX)).in_range());
        assert!(!hello(&"n".repeat(NAME_MAX + 1)).in_range());
        assert!(!HelloRequest { caller: None }.in_range());
    }

    #[test]
    fn a_profile_call_asks_for_at_most_50_names() {
        let names = |n: usize| GetRequest {
            usernames: vec!["bob".to_string(); n],
        };
        assert!(names(USERNAMES_MAX).in_range());
        assert!(!names(USERNAMES_MAX + 1).in_range());
    }

    #[test]
    fn a_search_is_at_most_100_characters() {
        let query = |n: usize| SearchRequest {
            query: "q".repeat(n),
            cursor: Vec::new(),
        };
        assert!(query(0).in_range());
        assert!(query(QUERY_MAX).in_range());
        assert!(!query(QUERY_MAX + 1).in_range());
    }

    #[test]
    fn an_image_is_asked_for_by_a_sha_256() {
        let icon = |n: usize| IconRequest {
            server: "club".to_string(),
            sha256: vec![1; n],
        };
        let avatar = |n: usize| AvatarRequest {
            username: "bob".to_string(),
            sha256: vec![1; n],
        };
        assert!(icon(32).in_range() && avatar(32).in_range());
        assert!(!icon(31).in_range() && !avatar(33).in_range());
    }

    #[test]
    fn a_decode_checks_the_ranges_right_after_decoding() {
        let over = GetRequest {
            usernames: vec!["bob".to_string(); USERNAMES_MAX + 1],
        }
        .encode_to_vec();
        assert_eq!(
            pb::decode_ranged::<GetRequest>(&over, 4096),
            Err(Malformed::Range)
        );
        assert_eq!(
            pb::decode_ranged::<GetRequest>(&over, 16),
            Err(Malformed::TooLarge)
        );
        assert_eq!(
            pb::decode_ranged::<GetRequest>(&[0x0a, 0x02, 0xff, 0xfe], 4096),
            Err(Malformed::Decode)
        );
        let fine = GetRequest {
            usernames: vec!["bob".to_string()],
        };
        assert_eq!(
            pb::decode_ranged::<GetRequest>(&fine.encode_to_vec(), 4096),
            Ok(fine)
        );
    }

    fn full() -> Hello {
        let text = "t".repeat(TEXT_MAX);
        Hello {
            software: text.clone(),
            version: text.clone(),
            instance_id: text.clone(),
            origin: format!("https://{}.example", "a".repeat(60)),
            name: "n".repeat(NAME_MAX),
            majors: vec![1; MAJORS_MAX],
            features: vec![
                FeatureLevel {
                    name: text.clone(),
                    level: 1,
                    min: 1
                };
                FEATURES_MAX
            ],
            rev: u64::MAX,
            limits: None,
            call_kids: vec![text.clone(); CALL_KIDS_MAX],
            endorsements: vec![
                KeyEndorsement {
                    new_kid: text.clone(),
                    at: 1,
                    by_kid: text.clone(),
                    sig: vec![7; 64]
                };
                ENDORSEMENTS_MAX
            ],
            budgets: vec![
                ServiceBudget {
                    service: text.clone(),
                    calls_per_minute: 1
                };
                BUDGETS_MAX
            ],
        }
    }

    fn request(change: impl FnOnce(&mut Hello)) -> HelloRequest {
        let mut caller = full();
        change(&mut caller);
        HelloRequest {
            caller: Some(caller),
        }
    }

    #[test]
    fn the_hello_list_limits_are_the_documented_ones() {
        assert_eq!(
            (MAJORS_MAX, FEATURES_MAX, CALL_KIDS_MAX, ENDORSEMENTS_MAX),
            (8, 64, 16, 16)
        );
        assert_eq!((BUDGETS_MAX, POLICY_MAX, TEXT_MAX), (32, 64, 64));
    }

    #[test]
    fn a_hello_with_every_list_and_text_at_its_limit_is_in_range() {
        assert!(request(|_| {}).in_range());
        let bytes = request(|_| {}).encode_to_vec();
        assert!(bytes.len() < 16 * 1024, "{}", bytes.len());
        assert!(pb::decode_ranged::<HelloRequest>(&bytes, 16 * 1024).is_ok());
    }

    #[test]
    fn one_entry_more_in_any_list_of_a_hello_is_out_of_range() {
        let level = || FeatureLevel {
            name: "x".to_string(),
            level: 1,
            min: 1,
        };
        let statement = || KeyEndorsement {
            new_kid: "k".to_string(),
            at: 1,
            by_kid: "k".to_string(),
            sig: Vec::new(),
        };
        let budget = || ServiceBudget {
            service: "x".to_string(),
            calls_per_minute: 1,
        };
        assert!(!request(|h| h.majors.push(2)).in_range());
        assert!(!request(|h| h.features.push(level())).in_range());
        assert!(!request(|h| h.call_kids.push("k".to_string())).in_range());
        assert!(!request(|h| h.endorsements.push(statement())).in_range());
        assert!(!request(|h| h.budgets.push(budget())).in_range());
        let over = request(|h| h.endorsements.push(statement())).encode_to_vec();
        assert_eq!(
            pb::decode_ranged::<HelloRequest>(&over, 64 * 1024),
            Err(Malformed::Range)
        );
    }

    #[test]
    fn a_text_of_a_hello_one_byte_too_long_is_out_of_range() {
        let long = || "t".repeat(TEXT_MAX + 1);
        assert!(!request(|h| h.software = long()).in_range());
        assert!(!request(|h| h.version = long()).in_range());
        assert!(!request(|h| h.instance_id = long()).in_range());
        assert!(!request(|h| h.origin = format!("https://{}", "a".repeat(254))).in_range());
        assert!(!request(|h| h.features[3].name = long()).in_range());
        assert!(!request(|h| h.call_kids[15] = long()).in_range());
        assert!(!request(|h| h.endorsements[0].new_kid = long()).in_range());
        assert!(!request(|h| h.endorsements[15].by_kid = long()).in_range());
        assert!(!request(|h| h.endorsements[2].sig = vec![7; 65]).in_range());
        assert!(!request(|h| h.budgets[31].service = long()).in_range());
    }

    #[test]
    fn a_hello_answer_is_ranged_like_the_hello_it_carries_and_in_its_policy_list() {
        let policy = |n: usize, name: &str| {
            vec![
                FeaturePolicy {
                    name: name.to_string(),
                    policy: 1
                };
                n
            ]
        };
        let answer = |callee: Option<Hello>, policy: Vec<FeaturePolicy>| HelloAnswer {
            callee,
            policy,
            now: 1,
        };
        assert!(answer(Some(full()), policy(POLICY_MAX, "letters")).in_range());
        assert!(answer(None, policy(1, "letters")).in_range());
        assert!(!answer(Some(full()), policy(POLICY_MAX + 1, "letters")).in_range());
        assert!(!answer(None, policy(1, &"t".repeat(TEXT_MAX + 1))).in_range());
        let mut callee = full();
        callee.call_kids.push("k".to_string());
        assert!(!answer(Some(callee), Vec::new()).in_range());
        let mut named = full();
        named.name = "n".repeat(NAME_MAX + 1);
        assert!(!answer(Some(named), Vec::new()).in_range());
    }

    #[test]
    fn a_forward_carries_at_most_20_sealed_keys() {
        let keys = |n: usize| ForwardRequest {
            r#ref: vec![5; 16],
            sealed_keys: vec![
                SealedKey {
                    message_id: "m".to_string(),
                    key: vec![1; 32]
                };
                n
            ],
            ..ForwardRequest::default()
        };
        assert!(keys(REPORT_IDS_MAX).in_range());
        assert!(!keys(REPORT_IDS_MAX + 1).in_range());
    }
}

mod secrets {
    use rchat_fed::pb::{
        DeliverResponse, ForwardRequest, PreviewRequest, PutObjectsRequest, SealedContent,
        SealedFile, SealedKey, ShareKey,
    };

    const KEY: [u8; 32] = [171; 32];

    fn hidden(text: String) -> String {
        assert!(!text.contains("171, 171"), "{text}");
        assert!(!text.contains("hunter2"), "{text}");
        assert!(text.contains("<redacted>"), "{text}");
        text
    }

    #[test]
    fn debug_output_never_shows_an_invite_password() {
        let preview = PreviewRequest {
            server: "club".to_string(),
            password: "hunter2".to_string(),
        };
        assert!(hidden(format!("{preview:?}")).contains("club"));
    }

    #[test]
    fn debug_output_never_shows_a_content_key_or_a_file_key() {
        let sealed = SealedKey {
            message_id: "m1".to_string(),
            key: KEY.to_vec(),
        };
        assert!(hidden(format!("{sealed:?}")).contains("m1"));
        let forward = ForwardRequest {
            subject: "bob@b.example".to_string(),
            sealed_keys: vec![sealed],
            ..ForwardRequest::default()
        };
        assert!(hidden(format!("{forward:?}")).contains("bob@b.example"));
        let content = SealedContent {
            subject: "Q3".to_string(),
            body: String::new(),
            files: vec![SealedFile {
                name: "plan.pdf".to_string(),
                mime: "application/pdf".to_string(),
                key: KEY.to_vec(),
                size: 9,
                sha256: vec![1; 32],
            }],
            keys: vec![ShareKey {
                id: "m0".to_string(),
                key: KEY.to_vec(),
            }],
        };
        let text = hidden(format!("{content:?}"));
        assert!(text.contains("plan.pdf") && text.contains("m0"));
    }

    #[test]
    fn debug_output_never_shows_an_upload_token() {
        let answer = DeliverResponse {
            accepted: true,
            upload: KEY.to_vec(),
            upload_expires: 1_800_000_600,
        };
        assert!(hidden(format!("{answer:?}")).contains("1800000600"));
        let chunk = PutObjectsRequest {
            upload: KEY.to_vec(),
            last: true,
            ..PutObjectsRequest::default()
        };
        assert!(hidden(format!("{chunk:?}")).contains("last: true"));
    }
}
