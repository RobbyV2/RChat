//! The sheet engine has no budget of its own. One formula can run without end (`=FACT(1e308)`,
//! `=SUM(A:XFD+1)`) or take hundreds of megabytes (`=SEQUENCE(1000000)`), and a call into this
//! crate does not return until the engine does. Call it from a process that can be stopped.

use ironcalc::base::Model;
use ironcalc::base::types::CellType;
use quick_xml::XmlVersion;
use quick_xml::events::{BytesStart, Event};
use std::collections::HashSet;
use std::fmt;
use std::io::{BufRead, BufReader, Cursor, Read};

/// The longest formula a cell may hold, in bytes. The sheet engine reads formulas by recursion,
/// and the thread it runs on is sized for the deepest formula of this length.
pub const MAX_FORMULA: usize = 8_192;

const STACK: usize = 256 << 20;
const MAX_ROW: i32 = 1_048_576;
const MAX_COLUMN: i32 = 16_384;
const MAX_FILES: usize = 10_000;
const MAX_NESTING: usize = 256;
const WORKBOOK_RELS: &str = "xl/_rels/workbook.xml.rels";
// The elements whose text the engine never reads as a formula: a cell's value and text.
const PLAIN: [&str; 2] = ["v", "t"];

/// One tab of a book: its name and what was typed into each filled cell, by address (`B7`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tab {
    pub name: String,
    pub cells: Vec<Cell>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    pub at: String,
    pub input: String,
}

/// What an XLSX file may hold: the bytes of its parts once unpacked, and the filled cells of
/// one tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub unpacked: u64,
    pub cells: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// A tab's name can't be used, or two tabs share one.
    Tab,
    /// A cell's address is not one of the sheet's.
    Cell,
    /// A formula is longer than `MAX_FORMULA`.
    Formula,
    /// The bytes are not an XLSX file this crate takes.
    Xlsx,
    /// The file holds more than the limits allow.
    TooLarge,
    /// The sheet engine gave up.
    Engine,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Error::Tab => "a tab name is not usable",
            Error::Cell => "not a cell address",
            Error::Formula => "a formula is too long",
            Error::Xlsx => "not an XLSX file",
            Error::TooLarge => "the file holds too much",
            Error::Engine => "the sheet engine gave up",
        })
    }
}

impl std::error::Error for Error {}

// The engine recurses once for each level of a formula and overflows a common thread's stack at
// a few hundred levels, which stops the process. It runs on a thread of its own, sized for
// `MAX_FORMULA`; a panic there is an error here.
fn run<T: Send>(work: impl FnOnce() -> Result<T, Error> + Send) -> Result<T, Error> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .stack_size(STACK)
            .spawn_scoped(scope, work)
            .map_err(|_| Error::Engine)?
            .join()
            .unwrap_or(Err(Error::Engine))
    })
}

fn address(at: &str) -> Option<(i32, i32)> {
    let letters = at.bytes().take_while(u8::is_ascii_uppercase).count();
    let (column, row) = at.split_at(letters);
    let plain = row.bytes().all(|b| b.is_ascii_digit()) && !row.starts_with('0');
    if !(1..=3).contains(&letters) || !(1..=7).contains(&row.len()) || !plain {
        return None;
    }
    let column = column
        .bytes()
        .fold(0, |n, b| n * 26 + i32::from(b - b'A') + 1);
    let row: i32 = row.parse().ok()?;
    (column <= MAX_COLUMN && row <= MAX_ROW).then_some((row, column))
}

fn at(row: i32, column: i32) -> String {
    let mut letters = Vec::new();
    let mut n = column;
    while n > 0 {
        letters.push(b'A' + ((n - 1) % 26) as u8);
        n = (n - 1) / 26;
    }
    letters.reverse();
    format!("{}{row}", String::from_utf8_lossy(&letters))
}

fn book(tabs: &[Tab]) -> Result<Model<'static>, Error> {
    let mut model = Model::new_empty("book", "en", "UTC", "en").map_err(|_| Error::Engine)?;
    for (index, tab) in tabs.iter().enumerate() {
        let named = match index {
            0 => model.rename_sheet_by_index(0, &tab.name).is_ok() || tab.name == "Sheet1",
            _ => model.add_sheet(&tab.name).is_ok(),
        };
        if !named {
            return Err(Error::Tab);
        }
    }
    for (index, tab) in tabs.iter().enumerate() {
        for cell in &tab.cells {
            let (row, column) = address(&cell.at).ok_or(Error::Cell)?;
            // the engine reads an input that starts with a sign as a formula too
            if cell.input.starts_with(['=', '+', '-']) && cell.input.len() > MAX_FORMULA {
                return Err(Error::Formula);
            }
            model
                .set_user_input(index as u32, row, column, cell.input.clone())
                .map_err(|_| Error::Cell)?;
        }
    }
    model.evaluate();
    Ok(model)
}

/// What every given cell shows, tab by tab in the order given. A formula reads the other tabs
/// given by name; a tab that was not given is a bad reference (`#REF!`).
pub fn values(tabs: &[Tab]) -> Result<Vec<Vec<String>>, Error> {
    run(|| {
        let model = book(tabs)?;
        tabs.iter()
            .enumerate()
            .map(|(index, tab)| {
                tab.cells
                    .iter()
                    .map(|cell| {
                        let (row, column) = address(&cell.at).ok_or(Error::Cell)?;
                        model
                            .get_formatted_cell_value(index as u32, row, column)
                            .map_err(|_| Error::Engine)
                    })
                    .collect()
            })
            .collect()
    })
}

/// The tabs as an XLSX file, with the values the formulas have now.
pub fn to_xlsx(tabs: &[Tab]) -> Result<Vec<u8>, Error> {
    if tabs.is_empty() {
        return Err(Error::Tab);
    }
    run(|| {
        let model = book(tabs)?;
        ironcalc::export::save_xlsx_to_writer(&model, Cursor::new(Vec::new()))
            .map(Cursor::into_inner)
            .map_err(|_| Error::Engine)
    })
}

// The bytes left of what a file may unpack to; a part that would go past it fails as it is read.
struct Counted<R> {
    part: R,
    left: u64,
    over: bool,
}

impl<R: Read> Read for Counted<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.part.read(buf)?;
        match self.left.checked_sub(n as u64) {
            Some(left) => {
                self.left = left;
                Ok(n)
            }
            None => {
                self.over = true;
                Err(std::io::Error::other("unpacks to too much"))
            }
        }
    }
}

// The engine joins the text of an element across the comments, instructions and child elements
// inside it, and reads it as a formula by recursion; it drops a tree of elements by recursion too.
// So the text of an element that may be a formula, and one tag, may be at most a formula long,
// and elements may nest only so deep. The part is read by the same reader the engine uses, and
// `each` sees every element in it.
fn markup(part: impl BufRead, mut each: impl FnMut(&BytesStart)) -> Result<(), Error> {
    let mut reader = quick_xml::Reader::from_reader(part);
    let mut buffer = Vec::new();
    let mut open = vec![Some(0)];
    loop {
        let added = match reader
            .read_event_into(&mut buffer)
            .map_err(|_| Error::Xlsx)?
        {
            Event::Eof => return Ok(()),
            Event::Start(tag) | Event::Empty(tag) if tag.len() > MAX_FORMULA => {
                return Err(Error::Formula);
            }
            Event::Start(tag) => {
                each(&tag);
                let plain = PLAIN.contains(&tag.local_name().as_ref());
                open.push((!plain).then_some(0));
                0
            }
            Event::Empty(tag) => {
                each(&tag);
                0
            }
            Event::End(_) => {
                if open.len() > 1 {
                    open.pop();
                }
                0
            }
            Event::Text(run) => run.len(),
            // an escaped character (`&lt;`) is one character of a formula
            Event::GeneralRef(_) => 1,
            Event::CData(_) => return Err(Error::Xlsx),
            Event::Comment(_) | Event::Decl(_) | Event::PI(_) | Event::DocType(_) => 0,
        };
        if open.len() > MAX_NESTING {
            return Err(Error::Xlsx);
        }
        if let Some(Some(own)) = open.last_mut() {
            *own += added;
            if *own > MAX_FORMULA {
                return Err(Error::Formula);
            }
        }
        buffer.clear();
    }
}

// The path the engine opens for a part that a relationship of the part `rels` names, when it
// reads that part as markup: worksheets and the theme from the workbook's relationships, comments
// and tables from a worksheet's. The engine joins the path from the target as written; for
// comments and tables the folder of the worksheet takes the place of the target's first two
// bytes (`../comments1.xml`).
fn opened(rels: &str, kind: &str, target: &str) -> Option<String> {
    let absolute = target.strip_prefix('/').map(str::to_string);
    if rels == WORKBOOK_RELS && (kind.ends_with("worksheet") || kind.ends_with("/theme")) {
        return Some(absolute.unwrap_or_else(|| format!("xl/{target}")));
    }
    let (folder, _) = rels.split_once("/worksheets/")?;
    let relative = || target.get(2..).map(|rest| format!("{folder}{rest}"));
    if kind.ends_with("comments") {
        relative()
    } else if kind.ends_with("table") {
        absolute.or_else(relative)
    } else {
        None
    }
}

// The parts a relationship element of the part `rels` has the engine read as markup, whatever
// their names, with every type and target it may take.
fn relationship(rels: &str, tag: &BytesStart) -> Vec<String> {
    if tag.local_name().as_ref() != "Relationship" {
        return Vec::new();
    }
    let (mut kinds, mut targets) = (Vec::new(), Vec::new());
    for attribute in tag.attributes().flatten() {
        let value = attribute
            .normalized_value(XmlVersion::Implicit1_0)
            .map(|v| v.into_owned())
            .unwrap_or_default();
        match attribute.key.local_name().as_ref() {
            "Type" => kinds.push(value),
            "Target" => targets.push(value),
            _ => {}
        }
    }
    kinds
        .iter()
        .flat_map(|kind| targets.iter().filter_map(|t| opened(rels, kind, t)))
        .map(|path| path.to_ascii_lowercase())
        .collect()
}

// Read before the engine sees the file: how much it unpacks to, and that no part the engine reads
// as markup holds text it could read as a formula deeper than its thread can follow, or elements
// nested deeper than it can drop. The relationships come first, since they name such parts; every
// part is read once, against one budget.
fn inspect(bytes: &[u8], limits: Limits) -> Result<(), Error> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| Error::Xlsx)?;
    if archive.len() > MAX_FILES {
        return Err(Error::TooLarge);
    }
    let mut left = limits.unpacked;
    let mut followed = HashSet::new();
    for rels in [true, false] {
        for index in 0..archive.len() {
            let part = archive.by_index(index).map_err(|_| Error::Xlsx)?;
            let name = part.name().map_err(|_| Error::Xlsx)?.into_owned();
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".rels") != rels {
                continue;
            }
            let is_markup = rels || lower.ends_with(".xml") || followed.contains(&lower);
            let mut named = Vec::new();
            let mut part = Counted {
                part,
                left,
                over: false,
            };
            let read = match is_markup {
                true => markup(BufReader::new(&mut part), |tag| {
                    if rels {
                        named.extend(relationship(&name, tag));
                    }
                }),
                false => std::io::copy(&mut part, &mut std::io::sink())
                    .map(|_| ())
                    .map_err(|_| Error::Xlsx),
            };
            if part.over {
                return Err(Error::TooLarge);
            }
            read?;
            left = part.left;
            followed.extend(named);
        }
    }
    Ok(())
}

// Text as it must be typed to stay text: with a mark in front when the engine would read it as
// a formula, a number, a date, yes or no, or an error.
fn typed(scratch: &mut Model, text: String) -> String {
    let plain = !text.starts_with(['=', '+', '-', '\''])
        && scratch.set_user_input(0, 1, 1, text.clone()).is_ok()
        && scratch.get_cell_type(0, 1, 1) == Ok(CellType::Text)
        && scratch.get_formatted_cell_value(0, 1, 1).as_ref() == Ok(&text);
    match plain {
        true => text,
        false => format!("'{text}"),
    }
}

/// The tabs of an XLSX file: every filled cell with its formula, or else its content. Formats,
/// styles, charts and the rest of the file are not read.
pub fn from_xlsx(bytes: &[u8], limits: Limits) -> Result<Vec<Tab>, Error> {
    run(|| {
        inspect(bytes, limits)?;
        let workbook = ironcalc::import::load_from_xlsx_bytes(bytes, "book", "en", "UTC")
            .map_err(|_| Error::Xlsx)?;
        let model = Model::from_workbook(workbook, "en").map_err(|_| Error::Xlsx)?;
        let mut scratch =
            Model::new_empty("typed", "en", "UTC", "en").map_err(|_| Error::Engine)?;
        let mut tabs: Vec<Tab> = model
            .get_worksheets_properties()
            .into_iter()
            .map(|sheet| Tab {
                name: sheet.name,
                cells: Vec::new(),
            })
            .collect();
        for cell in model.get_all_cells() {
            let (index, row, column) = (cell.index, cell.row, cell.column);
            let formula = model
                .get_cell_formula(index, row, column)
                .map_err(|_| Error::Xlsx)?
                .is_some();
            let text = !formula && model.get_cell_type(index, row, column) == Ok(CellType::Text);
            let input = match text {
                true => model.get_formatted_cell_value(index, row, column),
                false => model.get_localized_cell_content(index, row, column),
            }
            .map_err(|_| Error::Xlsx)?;
            if input.is_empty() {
                continue;
            }
            let input = match text {
                true => typed(&mut scratch, input),
                false => input,
            };
            let tab = tabs.get_mut(cell.index as usize).ok_or(Error::Xlsx)?;
            if tab.cells.len() >= limits.cells {
                return Err(Error::TooLarge);
            }
            tab.cells.push(Cell {
                at: at(cell.row, cell.column),
                input,
            });
        }
        Ok(tabs)
    })
}
