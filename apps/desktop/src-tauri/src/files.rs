use std::collections::VecDeque;
use std::collections::hash_map::RandomState;
use std::fs::{self, File, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const NAME_MAX: usize = 200;

// File extensions for a dialog filter from an `<input accept>` value.
pub fn extensions(accept: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in accept.split(',').map(str::trim) {
        let ext = match part {
            "application/json" => "json".to_string(),
            "text/plain" => "txt".to_string(),
            p => p.strip_prefix('.').unwrap_or_default().to_ascii_lowercase(),
        };
        let ok = !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric());
        if ok && !out.contains(&ext) {
            out.push(ext);
        }
    }
    out
}

// A file name the save dialog can suggest: no folders, no control characters.
pub fn file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .take(NAME_MAX)
        .collect();
    let clean = clean.trim().trim_start_matches('.').to_string();
    if clean.is_empty() {
        "download".to_string()
    } else {
        clean
    }
}

// Reads a picked text file, or None when it is larger than `max` bytes or not UTF-8.
pub fn read_text(path: &Path, max: u64) -> Option<String> {
    let file = File::open(path).ok()?;
    if file.metadata().ok()?.len() > max {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > max {
        return None;
    }
    String::from_utf8(bytes).ok()
}

// At most this many saves are open at once; starting another drops the oldest.
pub const OPEN_MAX: usize = 8;

// A save in progress. Bytes go to a new randomly named `.part` file next to the chosen file, which
// takes its place only once every piece is written; dropping an unfinished save deletes the part
// file this shell created, never anything else.
struct Pending {
    id: u32,
    file: Option<File>,
    part: PathBuf,
    dest: PathBuf,
}

impl Drop for Pending {
    fn drop(&mut self) {
        if self.file.take().is_some() {
            let _ = fs::remove_file(&self.part);
        }
    }
}

fn random_hex() -> String {
    let state = RandomState::new();
    let mut out = String::new();
    for salt in 0u8..2 {
        let mut hasher = state.build_hasher();
        hasher.write_u8(salt);
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}

// Creates a fresh temp file beside `dest`. `create_new` never opens or follows an existing path.
fn create_part(dest: &Path) -> io::Result<(File, PathBuf)> {
    let dir = dest.parent().unwrap_or_else(|| Path::new("."));
    let mut last = None;
    for _ in 0..16 {
        let part = dir.join(format!(".rchat-{}.part", random_hex()));
        match OpenOptions::new().write(true).create_new(true).open(&part) {
            Ok(file) => return Ok((file, part)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("no temp file")))
}

// Files being written after the user picked where to save them. The page only ever sees the id.
#[derive(Default)]
pub struct Saves {
    next: Mutex<u32>,
    open: Mutex<VecDeque<Pending>>,
}

impl Saves {
    fn open(&self) -> MutexGuard<'_, VecDeque<Pending>> {
        self.open.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn start(&self, dest: PathBuf) -> io::Result<u32> {
        let (file, part) = create_part(&dest)?;
        let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
        *next = next.wrapping_add(1);
        let id = *next;
        let mut open = self.open();
        while open.len() >= OPEN_MAX {
            open.pop_front();
        }
        open.push_back(Pending {
            id,
            file: Some(file),
            part,
            dest,
        });
        Ok(id)
    }

    fn take(&self, id: u32) -> Option<Pending> {
        let mut open = self.open();
        let at = open.iter().position(|p| p.id == id)?;
        open.remove(at)
    }

    pub fn write(&self, id: u32, bytes: &[u8]) -> Result<(), String> {
        let mut open = self.open();
        let file = open
            .iter_mut()
            .find(|p| p.id == id)
            .and_then(|p| p.file.as_mut())
            .ok_or("Unknown save")?;
        file.write_all(bytes).map_err(|e| e.to_string())
    }

    pub fn finish(&self, id: u32) -> Result<(), String> {
        let mut pending = self.take(id).ok_or("Unknown save")?;
        let file = pending.file.as_ref().ok_or("Unknown save")?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(pending.file.take());
        fs::rename(&pending.part, &pending.dest).map_err(|e| {
            let _ = fs::remove_file(&pending.part);
            e.to_string()
        })
    }

    pub fn abort(&self, id: u32) {
        drop(self.take(id));
    }

    // Drops every open save, e.g. when the page reloads and can no longer finish them.
    pub fn clear(&self) {
        self.open().clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.open().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_to_extensions() {
        assert_eq!(
            extensions(".json,application/json, .TXT ,text/plain"),
            ["json", "txt"]
        );
        assert_eq!(extensions(""), Vec::<String>::new());
        assert_eq!(extensions("image/*,.tar.gz,.."), Vec::<String>::new());
    }

    #[test]
    fn names_lose_folders_and_odd_characters() {
        assert_eq!(file_name("rchat-config.json"), "rchat-config.json");
        assert_eq!(file_name("../../etc/passwd"), "passwd");
        assert_eq!(file_name("C:\\x\\a<b>.txt"), "ab.txt");
        assert_eq!(file_name("..."), "download");
        assert_eq!(file_name(".bashrc"), "bashrc");
        assert_eq!(file_name("a\u{0}b\nc"), "abc");
        assert_eq!(file_name(&"x".repeat(500)).len(), NAME_MAX);
    }

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rchat-desktop-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn parts(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .unwrap()
            .filter(|e| {
                let name = e.as_ref().unwrap().file_name();
                name.to_string_lossy().ends_with(".part")
                    && name.to_string_lossy().starts_with(".rchat-")
            })
            .count()
    }

    #[test]
    fn saves_write_in_pieces_then_rename() {
        let dir = temp("save");
        let path = dir.join("out.bin");
        std::fs::write(&path, b"old").unwrap();
        let saves = Saves::default();
        let id = saves.start(path.clone()).unwrap();
        saves.write(id, b"hello ").unwrap();
        saves.write(id, b"world").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        assert_eq!(parts(&dir), 1);
        saves.finish(id).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"hello world");
        assert_eq!(parts(&dir), 0);
        assert!(saves.write(id, b"again").is_err());
        assert_eq!(saves.len(), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn aborted_saves_leave_nothing() {
        let dir = temp("abort");
        let path = dir.join("b.bin");
        let saves = Saves::default();
        let id = saves.start(path.clone()).unwrap();
        saves.write(id, b"half").unwrap();
        saves.abort(id);
        assert_eq!(parts(&dir), 0);
        assert!(!path.exists());
        assert!(saves.finish(id).is_err());
        let a = saves.start(dir.join("c.bin")).unwrap();
        let b = saves.start(dir.join("d.bin")).unwrap();
        assert_ne!(a, b);
        saves.clear();
        assert_eq!(saves.len(), 0);
        assert_eq!(parts(&dir), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn existing_siblings_are_never_touched() {
        let dir = temp("sibling");
        let path = dir.join("x");
        let sibling = dir.join("x.part");
        std::fs::write(&sibling, b"keep").unwrap();
        let target = dir.join("target");
        std::fs::write(&target, b"safe").unwrap();
        #[cfg(unix)]
        {
            let link = dir.join("y.part");
            std::os::unix::fs::symlink(&target, &link).unwrap();
        }
        let saves = Saves::default();
        let one = saves.start(path.clone()).unwrap();
        let two = saves.start(path.clone()).unwrap();
        saves.write(one, b"A").unwrap();
        saves.write(two, b"B").unwrap();
        assert_eq!(parts(&dir), 2);
        saves.abort(one);
        saves.finish(two).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"B");
        assert_eq!(std::fs::read(&sibling).unwrap(), b"keep");
        assert_eq!(std::fs::read(&target).unwrap(), b"safe");
        #[cfg(unix)]
        assert!(dir.join("y.part").is_symlink());
        assert_eq!(parts(&dir), 0);
        let again = saves.start(dir.join("y")).unwrap();
        saves.abort(again);
        assert_eq!(std::fs::read(&sibling).unwrap(), b"keep");
        assert_eq!(std::fs::read(&target).unwrap(), b"safe");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_saves_are_capped() {
        let dir = temp("cap");
        let saves = Saves::default();
        let first = saves.start(dir.join("0.bin")).unwrap();
        for i in 1..=OPEN_MAX {
            saves.start(dir.join(format!("{i}.bin"))).unwrap();
        }
        assert_eq!(saves.len(), OPEN_MAX);
        assert!(saves.write(first, b"x").is_err());
        assert_eq!(parts(&dir), OPEN_MAX);
        saves.clear();
        assert_eq!(parts(&dir), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_small_utf8_only() {
        let dir = std::env::temp_dir().join(format!("rchat-desktop-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let text = dir.join("a.txt");
        std::fs::write(&text, "rc1.abc").unwrap();
        assert_eq!(read_text(&text, 100).as_deref(), Some("rc1.abc"));
        assert_eq!(read_text(&text, 3), None);
        let bin = dir.join("b.bin");
        std::fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read_text(&bin, 100), None);
        assert_eq!(read_text(&dir.join("missing"), 100), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
