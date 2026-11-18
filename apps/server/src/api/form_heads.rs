//! The heads of the parts of a `multipart/form-data` body as the multipart parser reads them:
//! the preamble before the first boundary, each boundary line with its padding, and each part's
//! headers. The parser looks through all of an unfinished head again each time more bytes come,
//! so each head is kept short.

use memchr::memmem::Finder;

/// Most bytes of a part's head: from the end of the previous part's data (for the first part,
/// the start of the body) to the blank line after its headers.
pub(crate) const HEAD_MAX: usize = 16 * 1024;

/// Where the parser is in a body.
#[derive(Clone, Copy)]
enum Stage {
    /// Before the first boundary.
    First,
    /// Just after a boundary, where `--` ends the body; `dash` once one `-` came.
    Kind { dash: bool },
    /// Spaces and tabs, then CRLF; `cr` once the CR came.
    Padding { cr: bool },
    /// A part's headers, up to the first blank line.
    Headers,
    /// A part's data, up to CRLF and the next boundary.
    Data,
    /// After the closing boundary, which the parser reads no further than.
    End,
    /// Bytes the parser refuses: all of them count as head.
    Broken,
}

/// Follows a body with the boundary it was given, part by part.
pub(crate) struct Heads {
    /// `--` and the boundary, which starts the first part.
    open: Finder<'static>,
    /// CRLF, `--` and the boundary, which ends a part's data.
    delimiter: Finder<'static>,
    /// The blank line after a part's headers.
    blank: Finder<'static>,
    stage: Stage,
    /// Bytes of the current head so far.
    head: usize,
    /// The last bytes of the current search, fewer than it looks for.
    tail: Vec<u8>,
}

impl Heads {
    pub(crate) fn new(boundary: &str) -> Heads {
        let open = format!("--{boundary}");
        let delimiter = format!("\r\n{open}");
        Heads {
            open: Finder::new(open.as_bytes()).into_owned(),
            delimiter: Finder::new(delimiter.as_bytes()).into_owned(),
            blank: Finder::new(b"\r\n\r\n").into_owned(),
            stage: Stage::First,
            head: 0,
            tail: Vec::new(),
        }
    }

    /// Follows the next `chunk` of the body: `Err(n)` when a head passes `HEAD_MAX` after the
    /// first `n` bytes of `chunk`.
    pub(crate) fn scan(&mut self, chunk: &[u8]) -> Result<(), usize> {
        let mut at = 0;
        while at < chunk.len() {
            let rest = &chunk[at..];
            let (used, next) = self.step(rest);
            if !matches!(self.stage, Stage::Data | Stage::End) {
                if self.head + used > HEAD_MAX {
                    return Err(at + HEAD_MAX.saturating_sub(self.head));
                }
                self.head += used;
            }
            self.head = match (self.stage, next) {
                (Stage::Headers, Stage::Data) => 0,
                (Stage::Data, Stage::Kind { .. }) => self.delimiter.needle().len(),
                _ => self.head,
            };
            self.stage = next;
            at += used;
        }
        Ok(())
    }

    /// How many bytes of `rest` the current stage takes, and the stage after them.
    fn step(&mut self, rest: &[u8]) -> (usize, Stage) {
        let byte = rest[0];
        match self.stage {
            Stage::First => match search(&mut self.tail, &self.open, rest) {
                Some(n) => (n, Stage::Kind { dash: false }),
                None => (rest.len(), Stage::First),
            },
            Stage::Kind { dash: false } if byte == b'-' => (1, Stage::Kind { dash: true }),
            Stage::Kind { dash: false } => (0, Stage::Padding { cr: false }),
            Stage::Kind { dash: true } if byte == b'-' => (1, Stage::End),
            Stage::Kind { dash: true } => (1, Stage::Broken),
            Stage::Padding { cr: false } => match byte {
                b' ' | b'\t' => (1, Stage::Padding { cr: false }),
                b'\r' => (1, Stage::Padding { cr: true }),
                _ => (1, Stage::Broken),
            },
            Stage::Padding { cr: true } if byte == b'\n' => (1, Stage::Headers),
            Stage::Padding { cr: true } => (1, Stage::Broken),
            Stage::Headers => match search(&mut self.tail, &self.blank, rest) {
                Some(n) => (n, Stage::Data),
                None => (rest.len(), Stage::Headers),
            },
            Stage::Data => match search(&mut self.tail, &self.delimiter, rest) {
                Some(n) => (n, Stage::Kind { dash: false }),
                None => (rest.len(), Stage::Data),
            },
            Stage::End => (rest.len(), Stage::End),
            Stage::Broken => (rest.len(), Stage::Broken),
        }
    }
}

/// Looks for what `finder` finds in the bytes this search saw before (`tail`) and then `rest`:
/// how many bytes of `rest` it takes to the end of the first match. Otherwise keeps in `tail`
/// the last bytes seen, fewer than the match needs.
fn search(tail: &mut Vec<u8>, finder: &Finder<'_>, rest: &[u8]) -> Option<usize> {
    let needed = finder.needle().len();
    let keep = needed - 1;
    if !tail.is_empty() {
        let start = &rest[..rest.len().min(keep)];
        let joined = [tail.as_slice(), start].concat();
        if let Some(i) = finder.find(&joined) {
            let used = i + needed - tail.len();
            tail.clear();
            return Some(used);
        }
    }
    if let Some(i) = finder.find(rest) {
        tail.clear();
        return Some(i + needed);
    }
    tail.extend_from_slice(&rest[rest.len().saturating_sub(keep)..]);
    let over = tail.len().saturating_sub(keep);
    tail.drain(..over);
    None
}

#[cfg(test)]
mod tests {
    use super::{HEAD_MAX, Heads};

    /// A part with the boundary `XB` whose head (with the boundary line before it) is `head`
    /// bytes long, and `data` after it.
    fn part(head: usize, data: &[u8], first: bool) -> Vec<u8> {
        let start: &[u8] = if first { b"--XB\r\n" } else { b"\r\n--XB\r\n" };
        let named = b"Content-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\nX-Pad: ";
        let mut part = [start, named].concat();
        let pad = head - part.len() - 4;
        part.resize(part.len() + pad, b'p');
        part.extend_from_slice(b"\r\n\r\n");
        assert_eq!(part.len(), head);
        part.extend_from_slice(data);
        part
    }

    fn scanned(body: &[u8], pieces: &[usize]) -> Result<(), usize> {
        let mut heads = Heads::new("XB");
        let mut at = 0;
        for &n in pieces.iter().chain([&body.len()]) {
            let end = n.min(body.len());
            if end < at {
                continue;
            }
            heads.scan(&body[at..end]).map_err(|k| at + k)?;
            at = end;
        }
        Ok(())
    }

    /// What `Heads` says of `body` sent at once, the same for it sent in two pieces split
    /// anywhere and sent a byte at a time.
    fn verdict(body: &[u8]) -> Result<(), usize> {
        let once = scanned(body, &[]);
        for split in 0..=body.len() {
            assert_eq!(scanned(body, &[split]), once, "split at {split}");
        }
        let bytes: Vec<usize> = (1..body.len()).collect();
        assert_eq!(scanned(body, &bytes), once, "a byte at a time");
        once
    }

    #[test]
    fn a_head_may_take_up_to_its_cap() {
        let body = [part(HEAD_MAX, b"hello", true), b"\r\n--XB--\r\n".to_vec()].concat();
        assert_eq!(verdict(&body), Ok(()));
        let body = [
            part(HEAD_MAX + 1, b"hello", true),
            b"\r\n--XB--\r\n".to_vec(),
        ]
        .concat();
        assert_eq!(verdict(&body), Err(HEAD_MAX), "one byte more is refused");
    }

    #[test]
    fn a_preamble_counts_toward_the_first_head() {
        let preamble = vec![b'x'; 100];
        let body = [
            preamble.clone(),
            b"\r\n".to_vec(),
            part(HEAD_MAX - 102, b"hello", true),
            b"\r\n--XB--\r\n".to_vec(),
        ]
        .concat();
        assert_eq!(verdict(&body), Ok(()));
        let body = [
            preamble,
            b"\r\n".to_vec(),
            part(HEAD_MAX - 101, b"hi", true),
        ]
        .concat();
        assert_eq!(verdict(&body), Err(HEAD_MAX));
        assert_eq!(
            verdict(&vec![b'x'; HEAD_MAX + 10]),
            Err(HEAD_MAX),
            "a body with no boundary is all preamble"
        );
    }

    #[test]
    fn data_does_not_count_and_every_later_head_has_the_same_cap() {
        let data = [b"\r\n--X".as_slice(), &[b'd'; 40_000], b"\r\n-"].concat();
        let first = part(200, &data, true);
        let second = part(HEAD_MAX, b"two", false);
        let body = [first.clone(), second, b"\r\n--XB--\r\n".to_vec()].concat();
        assert_eq!(scanned(&body, &[]), Ok(()));
        assert_eq!(scanned(&body, &(1..body.len()).collect::<Vec<_>>()), Ok(()));
        let long = part(HEAD_MAX + 1, b"two", false);
        let body = [first.clone(), long].concat();
        assert_eq!(scanned(&body, &[]), Err(first.len() + HEAD_MAX));
        assert_eq!(
            scanned(&body, &[first.len() + 7, first.len() + 9000]),
            Err(first.len() + HEAD_MAX)
        );
    }

    #[test]
    fn padding_and_the_closing_boundary_follow_the_parser() {
        let padded = b"--XB \t \r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nv\r\n--XB--";
        let mut body = padded.to_vec();
        body.extend(vec![b'e'; HEAD_MAX * 2]);
        assert_eq!(verdict(&body[..padded.len() + 300]), Ok(()));
        assert_eq!(
            scanned(&body, &[]),
            Ok(()),
            "after the closing boundary nothing is parsed"
        );
        let mut bad = b"--XB-x".to_vec();
        bad.extend(vec![b'e'; HEAD_MAX]);
        assert_eq!(
            scanned(&bad, &[]),
            Err(HEAD_MAX),
            "a boundary the parser refuses is all head"
        );
        let mut empty = b"--XB\r\n\r\n".to_vec();
        empty.extend(vec![b'h'; HEAD_MAX]);
        assert_eq!(
            scanned(&empty, &[]),
            Err(HEAD_MAX),
            "the blank line ending the boundary line does not end the headers"
        );
    }
}
