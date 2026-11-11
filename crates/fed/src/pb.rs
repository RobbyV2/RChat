use std::fmt;

use crate::limits::hello::{
    BUDGETS_MAX, CALL_KIDS_MAX, ENDORSEMENTS_MAX, FEATURES_MAX, MAJORS_MAX, ORIGIN_MAX, POLICY_MAX,
    SIG_BYTES, TEXT_MAX,
};
use crate::limits::ranges::{
    NAME_MAX, NOTE_MAX, QUERY_MAX, REF_BYTES, REPORT_IDS_MAX, SHA256_BYTES, USERNAMES_MAX,
};

include!(concat!(env!("OUT_DIR"), "/rchat.fed.v1.rs"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Malformed {
    TooLarge,
    Decode,
    Range,
}

pub fn decode<M: prost::Message + Default>(body: &[u8], max: usize) -> Result<M, Malformed> {
    if body.len() > max {
        return Err(Malformed::TooLarge);
    }
    M::decode(body).map_err(|_| Malformed::Decode)
}

pub trait Ranged {
    fn in_range(&self) -> bool;
}

pub fn decode_ranged<M: prost::Message + Default + Ranged>(
    body: &[u8],
    max: usize,
) -> Result<M, Malformed> {
    let message: M = decode(body, max)?;
    match message.in_range() {
        true => Ok(message),
        false => Err(Malformed::Range),
    }
}

fn chars(text: &str, max: usize) -> bool {
    text.chars().count() <= max
}

fn short(text: &str) -> bool {
    text.len() <= TEXT_MAX
}

fn hello_in_range(hello: &Hello) -> bool {
    let Hello {
        software,
        version,
        instance_id,
        origin,
        name,
        majors,
        features,
        rev: _,
        limits: _,
        call_kids,
        endorsements,
        budgets,
    } = hello;
    let statement = |end: &KeyEndorsement| {
        short(&end.new_kid) && short(&end.by_kid) && end.sig.len() <= SIG_BYTES
    };
    chars(name, NAME_MAX)
        && short(software)
        && short(version)
        && short(instance_id)
        && origin.len() <= ORIGIN_MAX
        && majors.len() <= MAJORS_MAX
        && features.len() <= FEATURES_MAX
        && features.iter().all(|feature| short(&feature.name))
        && call_kids.len() <= CALL_KIDS_MAX
        && call_kids.iter().all(|kid| short(kid))
        && endorsements.len() <= ENDORSEMENTS_MAX
        && endorsements.iter().all(statement)
        && budgets.len() <= BUDGETS_MAX
        && budgets.iter().all(|budget| short(&budget.service))
}

impl Ranged for HelloRequest {
    fn in_range(&self) -> bool {
        self.caller.as_ref().is_some_and(hello_in_range)
    }
}

impl Ranged for HelloAnswer {
    fn in_range(&self) -> bool {
        self.callee.as_ref().is_none_or(hello_in_range)
            && self.policy.len() <= POLICY_MAX
            && self.policy.iter().all(|policy| short(&policy.name))
    }
}

impl Ranged for GetRequest {
    fn in_range(&self) -> bool {
        self.usernames.len() <= USERNAMES_MAX
    }
}

impl Ranged for SearchRequest {
    fn in_range(&self) -> bool {
        chars(&self.query, QUERY_MAX)
    }
}

impl Ranged for IconRequest {
    fn in_range(&self) -> bool {
        self.sha256.len() == SHA256_BYTES
    }
}

impl Ranged for AvatarRequest {
    fn in_range(&self) -> bool {
        self.sha256.len() == SHA256_BYTES
    }
}

impl Ranged for ForwardRequest {
    fn in_range(&self) -> bool {
        self.message_ids.len() <= REPORT_IDS_MAX
            && self.annotation_ids.len() <= REPORT_IDS_MAX
            && self.sealed_keys.len() <= REPORT_IDS_MAX
            && self.p2p_events.len() <= REPORT_IDS_MAX
            && chars(&self.note, NOTE_MAX)
            && self.r#ref.len() == REF_BYTES
    }
}

struct Redacted;

impl fmt::Debug for Redacted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

impl fmt::Debug for PreviewRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let PreviewRequest {
            server,
            password: _,
        } = self;
        f.debug_struct("PreviewRequest")
            .field("server", server)
            .field("password", &Redacted)
            .finish()
    }
}

impl fmt::Debug for SealedKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let SealedKey { message_id, key: _ } = self;
        f.debug_struct("SealedKey")
            .field("message_id", message_id)
            .field("key", &Redacted)
            .finish()
    }
}

impl fmt::Debug for ShareKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ShareKey { id, key: _ } = self;
        f.debug_struct("ShareKey")
            .field("id", id)
            .field("key", &Redacted)
            .finish()
    }
}

impl fmt::Debug for SealedFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let SealedFile {
            name,
            mime,
            key: _,
            size,
            sha256,
        } = self;
        f.debug_struct("SealedFile")
            .field("name", name)
            .field("mime", mime)
            .field("key", &Redacted)
            .field("size", size)
            .field("sha256", sha256)
            .finish()
    }
}

impl fmt::Debug for DeliverResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let DeliverResponse {
            accepted,
            upload: _,
            upload_expires,
        } = self;
        f.debug_struct("DeliverResponse")
            .field("accepted", accepted)
            .field("upload", &Redacted)
            .field("upload_expires", upload_expires)
            .finish()
    }
}

impl fmt::Debug for PutObjectsRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let PutObjectsRequest {
            upload: _,
            objects,
            snapshots,
            anns,
            last,
        } = self;
        f.debug_struct("PutObjectsRequest")
            .field("upload", &Redacted)
            .field("objects", objects)
            .field("snapshots", snapshots)
            .field("anns", anns)
            .field("last", last)
            .finish()
    }
}
