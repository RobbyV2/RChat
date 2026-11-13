use rchat_app_sheet::{Cell, Error, Limits, MAX_FORMULA, Tab, from_xlsx, to_xlsx, values};
use serde_json::Value;
use std::io::{Cursor, Read, Write};
use std::path::PathBuf;

const ROOMY: Limits = Limits {
    unpacked: 64 << 20,
    cells: 1_000_000,
};

fn tab(name: &str, cells: &[(&str, &str)]) -> Tab {
    Tab {
        name: name.to_string(),
        cells: cells
            .iter()
            .map(|(at, input)| Cell {
                at: at.to_string(),
                input: input.to_string(),
            })
            .collect(),
    }
}

fn shown(tabs: &[Tab]) -> Vec<Vec<String>> {
    values(tabs).unwrap()
}

fn one(input: &str) -> String {
    shown(&[tab("Plan", &[("A1", input)])])[0][0].clone()
}

fn column(n: usize) -> String {
    let mut letters = Vec::new();
    let mut n = n;
    while n > 0 {
        letters.push(b'A' + ((n - 1) % 26) as u8);
        n = (n - 1) / 26;
    }
    letters.reverse();
    String::from_utf8(letters).unwrap()
}

fn vectors(dir: &str, file: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(dir)
        .join(file);
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn fixture(file: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/vectors")
            .join(file),
    )
    .unwrap()
}

// A copy of an XLSX file with each part passed through `change`, and the parts of `extra` added.
fn repack(
    bytes: &[u8],
    change: impl Fn(&str, Vec<u8>) -> Vec<u8>,
    extra: &[(&str, Vec<u8>)],
) -> Vec<u8> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for index in 0..archive.len() {
        let mut part = archive.by_index(index).unwrap();
        let name = part.name().unwrap().to_string();
        if name.ends_with('/') {
            continue;
        }
        let mut content = Vec::new();
        part.read_to_end(&mut content).unwrap();
        out.start_file(name.as_str(), options).unwrap();
        out.write_all(&change(&name, content)).unwrap();
    }
    for (name, content) in extra {
        out.start_file(*name, options).unwrap();
        out.write_all(content).unwrap();
    }
    out.finish().unwrap().into_inner()
}

fn replace(content: Vec<u8>, from: &str, to: &str) -> Vec<u8> {
    let text = String::from_utf8(content).unwrap();
    assert!(text.contains(from), "{from} is not in {text}");
    text.replacen(from, to, 1).into_bytes()
}

fn nesting(depth: usize) -> String {
    format!("{}{}", "<x>".repeat(depth), "</x>".repeat(depth))
}

const COMMENTS: &str = "<comments xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><authors><author>a</author></authors><commentList><comment ref=\"A1\" authorId=\"0\"><text><t>{}</t></text></comment></commentList></comments>";

// A copy of an XLSX file whose first sheet has one relationship of the kind given, to `target`,
// and the part `at` added.
fn related(bytes: &[u8], kind: &str, target: &str, at: &str, part: String) -> Vec<u8> {
    let rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId9\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}\" Target=\"{target}\"/></Relationships>"
    );
    repack(
        bytes,
        |_, c| c,
        &[
            ("xl/worksheets/_rels/sheet1.xml.rels", rels.into_bytes()),
            (at, part.into_bytes()),
        ],
    )
}

#[test]
fn a_book_s_tabs_read_each_other_by_name() {
    let book = [
        tab(
            "Plan",
            &[
                ("A1", "2"),
                ("A2", "=A1*3"),
                ("A3", "='Pay roll'!A1+1"),
                ("A4", "=SUM('Pay roll'!A1:A2)"),
                ("B1", "hello"),
                ("B2", "TRUE"),
                ("B3", "=1/0"),
                ("B4", "=B1&\" \"&A2"),
                ("XFD1048576", "=A1"),
            ],
        ),
        tab("Pay roll", &[("A1", "40"), ("A2", "=Plan!A2"), ("A3", "")]),
    ];
    assert_eq!(
        shown(&book),
        [
            vec![
                "2", "6", "41", "46", "hello", "TRUE", "#DIV/0!", "hello 6", "2"
            ],
            vec!["40", "6", ""],
        ]
    );
    assert_eq!(shown(&[]), Vec::<Vec<String>>::new());
    assert_eq!(shown(&[tab("Empty", &[])]), [Vec::<String>::new()]);
}

// The caller hands over the tabs one viewer can see. A formula that names another tab gets a
// bad reference, never that tab's values, however the name is reached.
#[test]
fn a_tab_that_was_not_given_is_a_bad_reference() {
    let visible = [tab(
        "Plan",
        &[
            ("A1", "=Payroll!A1"),
            ("A2", "=SUM(Payroll!A:A)"),
            ("A3", "=IFERROR(SUM(Payroll!A:A),0)"),
            ("A4", "=INDIRECT(\"Payroll!A1\")"),
            ("A5", "=A1+1"),
            ("A6", "=Plan!A7"),
            ("A7", "7"),
        ],
    )];
    assert_eq!(
        shown(&visible),
        [vec!["#REF!", "#REF!", "0", "#REF!", "#REF!", "7", "7"]]
    );
    let whole = [visible[0].clone(), tab("Payroll", &[("A1", "5000")])];
    assert_eq!(shown(&whole)[0][..3], ["5000", "5000", "5000"]);
}

#[test]
fn what_is_typed_is_read_as_a_sheet_reads_it() {
    for (input, value) in [
        ("42", "42"),
        ("-2.5", "-2.5"),
        ("hello", "hello"),
        ("true", "TRUE"),
        ("'=A1", "=A1"),
        ("=1+", "#ERROR!"),
        ("=NOSUCH(1)", "#NAME?"),
        ("=A1", "#CIRC!"),
        ("=SQRT(16)", "4"),
        ("=1/3", "0.333333333"),
        ("=1e11", "1E+11"),
        ("=TODAY()>0", "TRUE"),
        ("=LEN(\"h\u{e9}llo \u{1f600}\")", "7"),
    ] {
        assert_eq!(one(input), value, "{input}");
    }
}

// The four vector files of the client's formula fallback hold the answers of the client's
// engine (IronCalc 0.9.1 as WebAssembly). This crate, the same engine built natively, must show
// the same text in every cell. It does but for one: where the engine raises ten to a power, the
// two builds use their platform's own arithmetic, and the last digit of a number can differ.
#[test]
fn the_values_are_the_client_engine_s_on_every_recorded_formula() {
    const PLATFORM: [&str; 1] = ["=ROUND(0.3,23)&\"\" is"];
    let web = "../../apps/web/app/lib/__tests__/apps_vectors";
    let mut count = 0;
    for (file, cases, place) in [
        ("formulas.json", 2000, 0),
        ("formula_random.json", 2000, 0),
        ("formula_edges.json", 276, 1),
        ("formula_mixed.json", 318, 2),
        ("formula_bounds.json", 933, 2),
    ] {
        let v = vectors(web, file);
        assert_eq!(v["engine"], "ironcalc 0.9.1");
        let grid: Vec<Cell> = v["grid"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| Cell {
                at: format!(
                    "{}{}",
                    column(c[1].as_u64().unwrap() as usize),
                    c[0].as_u64().unwrap()
                ),
                input: c[2].as_str().unwrap().to_string(),
            })
            .filter(|c| !c.input.is_empty())
            .collect();
        let list = v["cases"].as_array().unwrap();
        assert_eq!(list.len(), cases, "{file}");
        let across = column(v["column"].as_u64().unwrap() as usize);
        let mut differ = Vec::new();
        for (i, case) in list.iter().enumerate() {
            let row = match place {
                0 => 1 + i % 30,
                1 => 11 + i,
                _ => v["row"].as_u64().unwrap() as usize,
            };
            let formula = case["formula"].as_str().unwrap();
            let mut cells = grid.clone();
            cells.push(Cell {
                at: format!("{across}{row}"),
                input: formula.to_string(),
            });
            let got = values(&[Tab {
                name: "Sheet1".to_string(),
                cells,
            }])
            .unwrap()[0]
                .pop()
                .unwrap();
            if got != case["ironcalc"].as_str().unwrap() {
                differ.push(format!("{formula} is {}, not {got}", case["ironcalc"]));
            }
            count += 1;
        }
        differ.retain(|d| !PLATFORM.iter().any(|formula| d.starts_with(formula)));
        assert_eq!(differ, Vec::<String>::new(), "{file}");
    }
    assert_eq!(count, 5527);
}

#[test]
fn the_values_are_the_client_engine_s_on_sheets_that_read_themselves() {
    let v = vectors(
        "../../apps/web/app/lib/__tests__/apps_vectors",
        "formula_cycles.json",
    );
    assert_eq!(v["engine"], "ironcalc 0.9.1");
    let mut differ = Vec::new();
    let mut count = 0;
    for sheet in v["sheets"].as_array().unwrap() {
        let cells: Vec<Cell> = sheet["grid"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| Cell {
                at: format!(
                    "{}{}",
                    column(c[1].as_u64().unwrap() as usize),
                    c[0].as_u64().unwrap()
                ),
                input: c[2].as_str().unwrap().to_string(),
            })
            .collect();
        let got = values(&[Tab {
            name: "Sheet1".to_string(),
            cells: cells.clone(),
        }])
        .unwrap()
        .remove(0);
        for ((cell, got), want) in cells
            .iter()
            .zip(got)
            .zip(sheet["shown"].as_array().unwrap())
        {
            count += 1;
            if got != want.as_str().unwrap() {
                differ.push(format!("{} {} is {want}, not {got}", cell.at, cell.input));
            }
        }
    }
    assert_eq!(differ, Vec::<String>::new());
    assert_eq!(count, 3993);
}

#[test]
fn a_book_comes_back_from_xlsx_as_it_went() {
    let book = [
        tab(
            "Plan",
            &[
                ("A1", "2"),
                ("B1", "text with <tags> & \"quotes\""),
                ("Z1", "=A1*3"),
                ("AA1", "='It''s pay'!A1+1"),
                ("A2", "TRUE"),
                ("B2", "=SUM('It''s pay'!A1:A2)"),
                ("C2", "=IF(A1>1,\"yes\",\"no\")"),
                ("D2", "=1/0"),
                ("XFD1048576", "=A1"),
            ],
        ),
        tab("It's pay", &[("A1", "40"), ("A2", "=Plan!Z1")]),
        tab("\u{dc}n\u{ef} \u{4e16}\u{754c}", &[("B7", "x")]),
    ];
    let file = to_xlsx(&book).unwrap();
    assert_eq!(&file[..4], b"PK\x03\x04");
    let back = from_xlsx(&file, ROOMY).unwrap();
    assert_eq!(back, book);
    assert_eq!(shown(&back), shown(&book));
    assert_eq!(shown(&back)[0][3..6], ["41", "TRUE", "46"]);

    let again = from_xlsx(&to_xlsx(&back).unwrap(), ROOMY).unwrap();
    assert_eq!(again, book);
}

// What a sheet takes as a number with a format (a currency, a percentage, powers of ten) comes
// back as the number: formats are not carried.
#[test]
fn typed_formats_come_back_from_xlsx_as_plain_numbers() {
    let book = [tab(
        "Plan",
        &[
            ("A1", "$5.50"),
            ("A2", "50%"),
            ("A3", "1e3"),
            ("A4", "2026-01-02"),
        ],
    )];
    assert_eq!(
        shown(&book),
        [vec!["$5.50", "50%", "1.00E+03", "2026-01-02"]]
    );
    let back = from_xlsx(&to_xlsx(&book).unwrap(), ROOMY).unwrap();
    assert_eq!(
        back,
        [tab(
            "Plan",
            &[
                ("A1", "5.5"),
                ("A2", "0.5"),
                ("A3", "1000"),
                ("A4", "2026-01-02")
            ]
        )]
    );
}

// The three files are from IronCalc 0.9.1's own tests (MIT OR Apache-2.0): basic_text.xlsx
// (Excel), libreoffice_888_example.xlsx and openpyxl_example.xlsx.
#[test]
fn files_made_by_other_programs_are_read() {
    let excel = from_xlsx(&fixture("excel.xlsx"), ROOMY).unwrap();
    assert_eq!(
        excel
            .iter()
            .map(|t| (t.name.as_str(), t.cells.len()))
            .collect::<Vec<_>>(),
        [("Sheet1", 10), ("alignment", 15)]
    );
    assert_eq!(excel[0].cells[0], tab("", &[("A1", "Bold")]).cells[0]);
    assert_eq!(excel[1].cells[14], tab("", &[("A8", "Justify")]).cells[0]);

    let libreoffice = from_xlsx(&fixture("libreoffice.xlsx"), ROOMY).unwrap();
    assert_eq!(
        libreoffice
            .iter()
            .map(|t| (t.name.as_str(), t.cells.len()))
            .collect::<Vec<_>>(),
        [("Sheet1", 79), ("Charts", 0)]
    );
    let sums: Vec<&Cell> = libreoffice[0]
        .cells
        .iter()
        .filter(|c| c.input.starts_with('='))
        .collect();
    assert_eq!(sums.len(), 16);
    assert_eq!(*sums[0], tab("", &[("F5", "=SUM(B5:E5)")]).cells[0]);
    let at = libreoffice[0]
        .cells
        .iter()
        .position(|c| c.at == "F5")
        .unwrap();
    assert_eq!(shown(&libreoffice)[0][at], "58000");

    let openpyxl = from_xlsx(&fixture("openpyxl.xlsx"), ROOMY).unwrap();
    assert_eq!(
        openpyxl,
        [tab(
            "Sheet",
            &[
                ("A1", "Hello, World!"),
                ("B1", "=CONCAT(\"It is\",\" what it is\")"),
                ("A2", "=1+1"),
            ]
        )]
    );
    assert_eq!(
        shown(&openpyxl),
        [vec!["Hello, World!", "It is what it is", "2"]]
    );
    for tabs in [excel, libreoffice, openpyxl] {
        assert_eq!(from_xlsx(&to_xlsx(&tabs).unwrap(), ROOMY).unwrap(), tabs);
    }
}

// The size limit of a tab (APP_SHEET_CELLS, 200,000 by default): the spike's sheet of 20,000
// rows by 10, a formula a row and three over all of them.
#[test]
fn a_tab_of_200_000_cells_computes_and_comes_back_from_xlsx() {
    let rows = 20_000u64;
    let mut cells = Vec::with_capacity(200_003);
    let mut sum = 0;
    let mut items = 0;
    for r in 1..=rows {
        cells.push((format!("A{r}"), r.to_string()));
        cells.push((format!("B{r}"), (r % 97).to_string()));
        cells.push((format!("C{r}"), format!("item {}", r % 13)));
        for c in 4..=9 {
            cells.push((
                format!("{}{r}", column(c)),
                ((r * c as u64) % 1000).to_string(),
            ));
        }
        cells.push((format!("J{r}"), format!("=A{r}*B{r}+D{r}")));
        sum += r * (r % 97) + (r * 4) % 1000;
        if r % 13 == 3 {
            items += (r * 4) % 1000;
        }
    }
    cells.push((format!("J{}", rows + 1), format!("=SUM(J1:J{rows})")));
    cells.push((
        format!("J{}", rows + 2),
        format!("=SUMIF(C1:C{rows},\"item 3\",D1:D{rows})"),
    ));
    cells.push((
        format!("J{}", rows + 3),
        format!("=VLOOKUP({},A1:J{rows},10,FALSE)", rows / 2),
    ));
    let book = [Tab {
        name: "Big".to_string(),
        cells: cells
            .into_iter()
            .map(|(at, input)| Cell { at, input })
            .collect(),
    }];
    assert_eq!(book[0].cells.len(), 200_003);

    let started = std::time::Instant::now();
    let shown = values(&book).unwrap();
    let computed = started.elapsed();
    assert_eq!(shown[0].len(), 200_003);
    assert_eq!(shown[0][200_000], sum.to_string());
    assert_eq!(shown[0][200_001], items.to_string());
    let half = rows / 2;
    assert_eq!(
        shown[0][200_002],
        (half * (half % 97) + (half * 4) % 1000).to_string()
    );

    let started = std::time::Instant::now();
    let file = to_xlsx(&book).unwrap();
    let written = started.elapsed();
    let started = std::time::Instant::now();
    let back = from_xlsx(&file, ROOMY).unwrap();
    let read = started.elapsed();
    assert_eq!(back, book);
    println!(
        "200,003 cells: values {computed:?}, XLSX of {} bytes written in {written:?}, read in {read:?}",
        file.len()
    );

    let tight = Limits {
        unpacked: 64 << 20,
        cells: 200_002,
    };
    assert_eq!(from_xlsx(&file, tight), Err(Error::TooLarge));
    let small = Limits {
        unpacked: 1 << 20,
        cells: 1_000_000,
    };
    assert_eq!(from_xlsx(&file, small), Err(Error::TooLarge));
}

#[test]
fn tab_names_a_sheet_cannot_have_are_refused() {
    let long = "n".repeat(32);
    for name in ["", "a/b", "a\\b", "a:b", "a*b", "a?b", "[x]", long.as_str()] {
        let book = [tab(name, &[("A1", "1")])];
        assert_eq!(values(&book), Err(Error::Tab), "{name}");
        assert_eq!(to_xlsx(&book), Err(Error::Tab), "{name}");
        let second = [tab("Plan", &[]), tab(name, &[])];
        assert_eq!(values(&second), Err(Error::Tab), "{name}");
    }
    for (a, b) in [("Plan", "Plan"), ("Plan", "plan"), ("Sheet1", "sheet1")] {
        assert_eq!(values(&[tab(a, &[]), tab(b, &[])]), Err(Error::Tab));
    }
    assert_eq!(to_xlsx(&[]), Err(Error::Tab));
    for name in ["Sheet1", "Sheet2", "A1", "1", "TRUE", &"n".repeat(31)] {
        let book = [tab(name, &[("A1", "1")]), tab("Other", &[("A1", "2")])];
        assert_eq!(shown(&book), [["1"], ["2"]], "{name}");
        assert_eq!(from_xlsx(&to_xlsx(&book).unwrap(), ROOMY).unwrap(), book);
    }
}

#[test]
fn addresses_off_the_sheet_are_refused() {
    for at in [
        "", "A", "1", "A0", "A01", "a1", "$A$1", "A1:B2", "XFE1", "AAAA1", "A1048577", "A-1",
        "A1 ", " A1", "Plan!A1", "\u{c9}1",
    ] {
        assert_eq!(
            values(&[tab("Plan", &[(at, "1")])]),
            Err(Error::Cell),
            "{at}"
        );
        assert_eq!(
            to_xlsx(&[tab("Plan", &[(at, "1")])]),
            Err(Error::Cell),
            "{at}"
        );
    }
    for at in ["A1", "Z9", "AA10", "XFD1048576"] {
        assert_eq!(shown(&[tab("Plan", &[(at, "1")])]), [["1"]], "{at}");
    }
    let twice = [tab("Plan", &[("A1", "1"), ("A1", "2"), ("B1", "=A1")])];
    assert_eq!(shown(&twice), [["2", "2", "2"]]);
}

// The engine follows a formula by recursion and overflows a 2 MiB stack near 500 levels, which
// stops the process. These are the deepest formulas the length limit allows, of five shapes;
// the test thread itself has a 2 MiB stack.
#[test]
fn the_deepest_formulas_the_limit_allows_are_followed() {
    let fill = |open: &str, close: &str| {
        let levels = (MAX_FORMULA - 2) / (open.len() + close.len());
        let formula = format!("={}1{}", open.repeat(levels), close.repeat(levels));
        assert!(
            formula.len() <= MAX_FORMULA && formula.len() + open.len() + close.len() > MAX_FORMULA
        );
        (levels, formula)
    };
    for (open, close, value) in [
        ("(", ")", "1"),
        ("-", "", "1"),
        ("IF(TRUE,", ",0)", "1"),
        ("SUM(", ")", "1"),
        ("1+", "", "4096"),
        ("ABS(-", ")", "1"),
    ] {
        let (levels, formula) = fill(open, close);
        assert!(levels >= 700, "{open}");
        assert_eq!(one(&formula), value, "{open} at {levels} levels");
        // the file holds the formula as the engine writes it (brackets that change nothing go)
        let book = [tab("Plan", &[("A1", formula.as_str())])];
        let back = from_xlsx(&to_xlsx(&book).unwrap(), ROOMY).unwrap();
        assert_eq!(shown(&back), [[value]], "{open}");
    }
    let over = format!("={}1{}", "(".repeat(4096), ")".repeat(4096));
    assert_eq!(over.len(), MAX_FORMULA + 2);
    assert_eq!(
        values(&[tab("Plan", &[("A1", over.as_str())])]),
        Err(Error::Formula)
    );
    assert_eq!(
        to_xlsx(&[tab("Plan", &[("A1", over.as_str())])]),
        Err(Error::Formula)
    );
    let words = "w".repeat(40_000);
    assert_eq!(one(&words), words);
    // an input that starts with a sign is a formula to the engine too
    assert_eq!(
        one(&format!("-{}1{}", "(".repeat(4000), ")".repeat(4000))),
        "-1"
    );
    for sign in ["+", "-"] {
        let signed = format!("{sign}{}1{}", "(".repeat(100_000), ")".repeat(100_000));
        assert_eq!(
            values(&[tab("Plan", &[("A1", signed.as_str())])]),
            Err(Error::Formula),
            "{sign}"
        );
    }
}

// A cell of text keeps being text, whatever it would be read as if it were typed again: other
// programs mark such a cell by its type alone, with no mark in front of the text.
#[test]
fn text_that_reads_as_something_else_comes_back_as_text() {
    const MARK: &str = " quotePrefix=\"1\"";
    let book = [tab(
        "Plan",
        &[
            ("A1", "'5"),
            ("B1", "=COUNT(A1:A9)"),
            ("A2", "'=1+1"),
            ("B2", "=COUNTA(A1:A9)"),
            ("A3", "'+1 555 0100"),
            ("A4", "'TRUE"),
            ("A5", "'#N/A"),
            ("A6", "'1/2/2023"),
            ("A7", "'50%"),
            ("A8", "''quoted"),
            ("A9", "plain"),
        ],
    )];
    let want = [vec![
        "5",
        "0",
        "=1+1",
        "9",
        "+1 555 0100",
        "TRUE",
        "#N/A",
        "1/2/2023",
        "50%",
        "'quoted",
        "plain",
    ]];
    assert_eq!(shown(&book), want);
    let file = to_xlsx(&book).unwrap();
    assert_eq!(from_xlsx(&file, ROOMY).unwrap(), book);
    let unmark = |file: &[u8]| {
        repack(
            file,
            |name, content| match name {
                "xl/styles.xml" => {
                    let styles = String::from_utf8(content).unwrap();
                    assert!(styles.contains(MARK), "{styles}");
                    styles.replace(MARK, "").into_bytes()
                }
                _ => content,
            },
            &[],
        )
    };
    assert_eq!(from_xlsx(&unmark(&file), ROOMY).unwrap(), book);
    let mut cells = book[0].cells.clone();
    cells.last_mut().unwrap().input = format!("'={}", "(".repeat(100_000));
    let long = [Tab {
        name: "Plan".to_string(),
        cells,
    }];
    let file = to_xlsx(&long).unwrap();
    assert_eq!(from_xlsx(&file, ROOMY).unwrap(), long);
    assert_eq!(from_xlsx(&unmark(&file), ROOMY).unwrap(), long);
}

#[test]
fn what_is_not_an_xlsx_file_is_refused() {
    let file = to_xlsx(&[tab("Plan", &[("A1", "1"), ("A2", "=A1+1")])]).unwrap();
    assert_eq!(from_xlsx(&[], ROOMY), Err(Error::Xlsx));
    assert_eq!(from_xlsx(b"not a zip", ROOMY), Err(Error::Xlsx));
    assert_eq!(from_xlsx(&file[..file.len() / 2], ROOMY), Err(Error::Xlsx));
    let without = repack(&file, |_, c| c, &[]);
    assert_eq!(from_xlsx(&without, ROOMY).unwrap().len(), 1);
    let empty = zip::ZipWriter::new(Cursor::new(Vec::new()))
        .finish()
        .unwrap()
        .into_inner();
    assert_eq!(from_xlsx(&empty, ROOMY), Err(Error::Xlsx));
    let broken = repack(
        &file,
        |name, c| match name {
            "xl/worksheets/sheet1.xml" => b"<worksheet><sheetData><row".to_vec(),
            _ => c,
        },
        &[],
    );
    assert_eq!(from_xlsx(&broken, ROOMY), Err(Error::Xlsx));
    for (error, words) in [
        (Error::Tab, "a tab name is not usable"),
        (Error::Cell, "not a cell address"),
        (Error::Formula, "a formula is too long"),
        (Error::Xlsx, "not an XLSX file"),
        (Error::TooLarge, "the file holds too much"),
        (Error::Engine, "the sheet engine gave up"),
    ] {
        assert_eq!(error.to_string(), words);
        assert!(words.is_ascii());
    }
}

#[test]
fn a_file_that_unpacks_to_more_than_the_limit_is_refused_before_it_is_read() {
    let file = to_xlsx(&[tab("Plan", &[("A1", "1")])]).unwrap();
    let mut unpacked = 0;
    let mut archive = zip::ZipArchive::new(Cursor::new(&file)).unwrap();
    for index in 0..archive.len() {
        unpacked += archive.by_index(index).unwrap().size();
    }
    let limits = |unpacked| Limits {
        unpacked,
        cells: 10,
    };
    assert!(from_xlsx(&file, limits(unpacked)).is_ok());
    assert_eq!(from_xlsx(&file, limits(unpacked - 1)), Err(Error::TooLarge));
    assert_eq!(from_xlsx(&file, limits(0)), Err(Error::TooLarge));

    // 64 MiB of zeros in 64 KiB of file: the part is not one the engine reads, and still counts
    let bomb = repack(
        &file,
        |_, c| c,
        &[("xl/media/zeros.bin", vec![0; 64 << 20])],
    );
    assert!(bomb.len() < 200_000);
    let started = std::time::Instant::now();
    assert_eq!(from_xlsx(&bomb, limits(16 << 20)), Err(Error::TooLarge));
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
    assert!(from_xlsx(&bomb, limits(65 << 20)).is_ok());

    let many: Vec<(String, Vec<u8>)> = (0..10_001)
        .map(|i| (format!("x/{i}"), Vec::new()))
        .collect();
    let many: Vec<(&str, Vec<u8>)> = many.iter().map(|(n, c)| (n.as_str(), c.clone())).collect();
    assert_eq!(
        from_xlsx(&repack(&file, |_, c| c, &many), ROOMY),
        Err(Error::TooLarge)
    );
}

// A formula inside a file is read by the same recursion. One too long to have come from a
// sheet is refused before the engine reads the file, wherever in the file it is.
#[test]
fn a_file_with_a_formula_past_the_limit_is_refused_before_it_is_read() {
    let file = to_xlsx(&[tab("Plan", &[("A1", "1"), ("A2", "=A1+1")])]).unwrap();
    let deep = format!("{}1{}", "(".repeat(200_000), ")".repeat(200_000));
    let sheet = |formula: &str| {
        let formula = formula.to_string();
        repack(
            &file,
            move |name, c| match name {
                "xl/worksheets/sheet1.xml" => {
                    replace(c, "<f>A1+1</f>", &format!("<f>{formula}</f>"))
                }
                _ => c,
            },
            &[],
        )
    };
    assert_eq!(
        from_xlsx(&sheet("A1+2"), ROOMY).unwrap()[0].cells[1].input,
        "=A1+2"
    );
    assert_eq!(from_xlsx(&sheet(&deep), ROOMY), Err(Error::Formula));
    let cdata = format!("<![CDATA[{}]]>", "(1<2)+".repeat(9));
    assert_eq!(from_xlsx(&sheet(&cdata), ROOMY), Err(Error::Xlsx));

    let longest = format!("{}1{}", "(".repeat(4095), ")".repeat(4095));
    assert_eq!(longest.len(), MAX_FORMULA - 1);
    let kept = from_xlsx(&sheet(&longest), ROOMY).unwrap();
    assert_eq!(shown(&kept), [["1", "1"]]);
    let escaped = format!(
        "IF(1&lt;2,{},0)",
        "&quot;a&quot;&amp;".repeat(800) + "&quot;b&quot;"
    );
    assert!(escaped.len() > MAX_FORMULA + 6_000);
    let kept = from_xlsx(&sheet(&escaped), ROOMY).unwrap();
    assert_eq!(shown(&kept)[0][1], "a".repeat(800) + "b");
    // a bare `&` is not XML: the reader the engine uses refuses it
    for (open, refused) in [
        ("&(", Error::Xlsx),
        ("&lt;((((((((", Error::Formula),
        ("&;((((((((", Error::Formula),
        ("&#40;((((((((", Error::Formula),
    ] {
        let unending = format!("{}1{}", open.repeat(20_000), ")".repeat(20_000));
        assert_eq!(from_xlsx(&sheet(&unending), ROOMY), Err(refused), "{open}");
    }

    let named = repack(
        &file,
        |name, c| match name {
            "xl/workbook.xml" => replace(
                c,
                "</sheets>",
                &format!(
                    "</sheets><definedNames><definedName name=\"deep\">{deep}</definedName></definedNames>"
                ),
            ),
            _ => c,
        },
        &[],
    );
    assert_eq!(from_xlsx(&named, ROOMY), Err(Error::Formula));

    // the engine joins the text of an element across comments, instructions and child elements
    let split = |depth: usize, between: &str| {
        let formula = format!("{}1{}", "(".repeat(depth), ")".repeat(depth));
        let pieces: Vec<String> = formula
            .as_bytes()
            .chunks(4_000)
            .map(|c| String::from_utf8(c.to_vec()).unwrap())
            .collect();
        pieces.join(between)
    };
    for between in ["<!---->", "<?x?>", "<x/>", "<x></x>", "<x>1</x>"] {
        for depth in [10_000, 100_000] {
            let formula = split(depth, between);
            assert_eq!(
                from_xlsx(&sheet(&formula), ROOMY),
                Err(Error::Formula),
                "{between} {depth}"
            );
            let named = repack(
                &file,
                |name, c| match name {
                    "xl/workbook.xml" => replace(
                        c,
                        "</sheets>",
                        &format!(
                            "</sheets><definedNames><definedName name=\"deep\">{formula}</definedName></definedNames>"
                        ),
                    ),
                    _ => c,
                },
                &[],
            );
            assert_eq!(
                from_xlsx(&named, ROOMY),
                Err(Error::Formula),
                "{between} {depth}"
            );
        }
    }
    let short = split(1_000, "<!---->");
    assert_eq!(
        shown(&from_xlsx(&sheet(&short), ROOMY).unwrap()),
        [["1", "1"]]
    );

    let attribute = repack(
        &file,
        |name, c| match name {
            "xl/worksheets/sheet1.xml" => {
                replace(c, "<sheetData>", &format!("<sheetData x=\"{deep}\">"))
            }
            _ => c,
        },
        &[],
    );
    assert_eq!(from_xlsx(&attribute, ROOMY), Err(Error::Formula));

    // long text is a cell's content, not a formula: the shared strings may hold it
    let words = "w".repeat(30_000);
    let book = [tab("Plan", &[("A1", words.as_str())])];
    assert_eq!(from_xlsx(&to_xlsx(&book).unwrap(), ROOMY).unwrap(), book);

    // and so may a formula's value, a cell written as a string of its own, and a comment
    let long = [tab(
        "Plan",
        &[("A1", "=REPT(\"a\",10000)"), ("A2", "=LEN(A1)")],
    )];
    let back = from_xlsx(&to_xlsx(&long).unwrap(), ROOMY).unwrap();
    assert_eq!(back, long);
    assert_eq!(shown(&back), [["a".repeat(10_000), "10000".to_string()]]);
    let inline = repack(
        &file,
        |name, c| match name {
            "xl/worksheets/sheet1.xml" => {
                let text = String::from_utf8(c).unwrap();
                let start = text.find("<c r=\"A1\"").unwrap();
                let end = start + text[start..].find("</c>").unwrap() + 4;
                let cell = format!("<c r=\"A1\" t=\"inlineStr\"><is><t>{words}</t></is></c>");
                format!("{}{cell}{}", &text[..start], &text[end..]).into_bytes()
            }
            _ => c,
        },
        &[],
    );
    assert_eq!(from_xlsx(&inline, ROOMY).unwrap()[0].cells[0].input, words);
    let noted = related(
        &file,
        "comments",
        "../comments1.xml",
        "xl/comments1.xml",
        COMMENTS.replace("{}", &words),
    );
    assert_eq!(shown(&from_xlsx(&noted, ROOMY).unwrap()), [["1", "2"]]);
}

// The engine reads a worksheet, a theme, comments or a table under whatever name a
// relationship gives it, the shared strings among them.
#[test]
fn a_part_read_under_another_name_is_looked_at_too() {
    let file = to_xlsx(&[tab("Plan", &[("A1", "1"), ("A2", "=A1+1")])]).unwrap();
    let deep = format!("{}1{}", "(".repeat(10_000), ")".repeat(10_000));
    let renamed = |target: &str, to: &str, formula: &str| {
        let mut sheet = Vec::new();
        zip::ZipArchive::new(Cursor::new(&file))
            .unwrap()
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_end(&mut sheet)
            .unwrap();
        let sheet = replace(sheet, "<f>A1+1</f>", &format!("<f>{formula}</f>"));
        let target = target.to_string();
        let to = to.to_string();
        let held = zip::ZipArchive::new(Cursor::new(&file))
            .unwrap()
            .file_names()
            .any(|n| n.is_ok_and(|n| n == to));
        let extra = match held {
            true => Vec::new(),
            false => vec![(to.as_str(), sheet.clone())],
        };
        repack(
            &file,
            |name, c| match name {
                "xl/_rels/workbook.xml.rels" => replace(
                    c,
                    "Target=\"worksheets/sheet1.xml\"",
                    &format!("Target=\"{target}\""),
                ),
                "xl/worksheets/sheet1.xml" => Vec::new(),
                _ if name == to => sheet.clone(),
                _ => c,
            },
            &extra,
        )
    };
    let kept = from_xlsx(
        &renamed("worksheets/sheet1.bin", "xl/worksheets/sheet1.bin", "A1+2"),
        ROOMY,
    )
    .unwrap();
    assert_eq!(shown(&kept), [["1", "3"]]);
    for (target, to) in [
        ("worksheets/sheet1.bin", "xl/worksheets/sheet1.bin"),
        ("media/plan", "xl/media/plan"),
        ("sharedStrings.xml", "xl/sharedStrings.xml"),
        ("/xl/worksheets/plan", "xl/worksheets/plan"),
        ("../xl/worksheets/plan", "xl/../xl/worksheets/plan"),
    ] {
        assert_eq!(
            from_xlsx(&renamed(target, to, &deep), ROOMY),
            Err(Error::Formula),
            "{to}"
        );
    }

    // the path is the one the engine opens, not a part that only ends the same way
    let mut noise = Vec::with_capacity(1 << 20);
    let mut seed: u32 = 7;
    for _ in 0..1 << 20 {
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        noise.push((seed >> 16) as u8);
    }
    let beside = repack(
        &renamed("worksheets/sheet1.bin", "xl/worksheets/sheet1.bin", "A1+2"),
        |_, c| c,
        &[("xl/media/sheet1.bin", noise.clone())],
    );
    assert_eq!(shown(&from_xlsx(&beside, ROOMY).unwrap()), [["1", "3"]]);

    // a picture is not markup, and is not looked at as markup
    let picture = repack(&file, |_, c| c, &[("xl/media/image1.png", noise)]);
    assert!(from_xlsx(&picture, ROOMY).is_ok());
}

// The engine drops the tree of a part by recursion: elements nested millions deep stop the
// process, on the engine's thread too.
#[test]
fn a_file_whose_elements_nest_too_deep_is_refused_before_it_is_read() {
    let file = to_xlsx(&[tab("Plan", &[("A1", "1")])]).unwrap();
    let nested = |depth: usize| {
        let inside = format!("{}{}", "<x>".repeat(depth), "</x>".repeat(depth));
        repack(
            &file,
            move |name, c| match name {
                "xl/workbook.xml" => replace(c, "</sheets>", &format!("</sheets>{inside}")),
                _ => c,
            },
            &[],
        )
    };
    assert_eq!(shown(&from_xlsx(&nested(200), ROOMY).unwrap()), [["1"]]);
    assert_eq!(from_xlsx(&nested(300), ROOMY), Err(Error::Xlsx));
    assert_eq!(from_xlsx(&nested(4_000_000), ROOMY), Err(Error::Xlsx));

    // the shared strings are a tree to the engine too
    let words = to_xlsx(&[tab("Plan", &[("A1", "words")])]).unwrap();
    let strings = |depth: usize| {
        let inside = nesting(depth);
        repack(
            &words,
            move |name, c| match name {
                "xl/sharedStrings.xml" => replace(c, "</si>", &format!("{inside}</si>")),
                _ => c,
            },
            &[],
        )
    };
    assert_eq!(
        from_xlsx(&strings(200), ROOMY).unwrap()[0].cells[0].input,
        "words"
    );
    assert_eq!(from_xlsx(&strings(300), ROOMY), Err(Error::Xlsx));
    assert_eq!(from_xlsx(&strings(4_000_000), ROOMY), Err(Error::Xlsx));

    // and so are comments and tables, at the path the engine joins from the worksheet's folder
    // and the target: `..c.bin` is `xlc.bin`
    let comments = |depth: usize| {
        let part = COMMENTS.replace("{}", &format!("hi{}", nesting(depth)));
        related(&file, "comments", "..c.bin", "xlc.bin", part)
    };
    assert_eq!(shown(&from_xlsx(&comments(200), ROOMY).unwrap()), [["1"]]);
    assert_eq!(from_xlsx(&comments(300), ROOMY), Err(Error::Xlsx));
    assert_eq!(from_xlsx(&comments(4_000_000), ROOMY), Err(Error::Xlsx));
    for (target, at) in [
        ("..t.bin", "xlt.bin"),
        ("/xl/tables/t.bin", "xl/tables/t.bin"),
    ] {
        let part = format!("<table>{}</table>", nesting(4_000_000));
        let table = related(&file, "table", target, at, part);
        assert_eq!(from_xlsx(&table, ROOMY), Err(Error::Xlsx), "{target}");
    }
}

// Formulas made of random pieces, each alone and then all in one book. The engine panics on
// some; none may leave the crate. APP_SHEET_PIECES sets how many are tried.
#[test]
fn formulas_of_random_pieces_never_stop_the_process() {
    let rounds: usize = std::env::var("APP_SHEET_PIECES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(1_500);
    let pieces = [
        "A1",
        "B2",
        "$C$3",
        "A1:C9",
        "A:A",
        "1:1",
        "Other!A1",
        "'O t'!A1:B2",
        "Gone!A1",
        "1",
        "0",
        "-1",
        "1e308",
        "0.5",
        "\"x\"",
        "\"\"",
        "TRUE",
        "(",
        ")",
        ",",
        "+",
        "-",
        "*",
        "/",
        "^",
        "&",
        "=",
        "<",
        ">",
        "<>",
        "%",
        ":",
        "!",
        "{",
        "}",
        ";",
        "#REF!",
        "#N/A",
        "@",
        " ",
        "SUM(",
        "IF(",
        "INDIRECT(",
        "OFFSET(",
        "VLOOKUP(",
        "INDEX(",
        "TEXT(",
        "DATE(",
        "REPT(",
        "SEQUENCE(",
        "LAMBDA(",
        "LET(",
        "TEXTJOIN(",
        "ROW(",
        "COLUMN(",
        "RAND(",
        "NOW(",
        "XLOOKUP(",
        "FILTER(",
        "SORT(",
        "UNIQUE(",
        "TRANSPOSE(",
        "MMULT(",
        "FACT(",
        "POWER(",
        "MOD(",
        "SUBSTITUTE(",
    ];
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let grid = [
        ("A1", "1"),
        ("B2", "two"),
        ("C3", "=A1/0"),
        ("A2", "=A1+1"),
        ("A9", "TRUE"),
    ];
    let other = tab("Other", &[("A1", "5"), ("B2", "=Plan!A1")]);
    let spaced = tab("O t", &[("A1", "6")]);
    let mut all: Vec<(String, String)> = Vec::new();
    let (mut shown, mut gave_up) = (0, 0);
    for round in 0..rounds {
        let formula: String = std::iter::once("=")
            .chain((0..1 + next() % 12).map(|_| pieces[(next() % pieces.len() as u64) as usize]))
            .collect();
        let mut cells: Vec<(&str, &str)> = grid.to_vec();
        cells.push(("E5", formula.as_str()));
        match values(&[tab("Plan", &cells), other.clone(), spaced.clone()]) {
            Ok(v) => {
                assert_eq!(v[0].len(), 6, "{formula}");
                shown += 1;
            }
            Err(e) => {
                assert_eq!(e, Error::Engine, "{formula}");
                gave_up += 1;
            }
        }
        all.push((format!("G{}", round + 1), formula));
    }
    let mut cells: Vec<(&str, &str)> = grid.to_vec();
    cells.extend(all.iter().map(|(at, f)| (at.as_str(), f.as_str())));
    let book = [tab("Plan", &cells), other, spaced];
    if let Ok(v) = values(&book) {
        assert_eq!(v[0].len(), cells.len());
    }
    if let Ok(file) = to_xlsx(&book) {
        let _ = from_xlsx(&file, ROOMY);
    }
    println!("{rounds} formulas of random pieces: {shown} shown, {gave_up} the engine gave up on");
    assert!(shown > rounds / 2);
}

// Files bent at random. The engine panics on some; none may leave the crate.
// APP_SHEET_BENT sets how many are tried.
#[test]
fn files_bent_at_random_never_stop_the_process() {
    let rounds: usize = std::env::var("APP_SHEET_BENT")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(300);
    let book = [
        tab(
            "Plan",
            &[
                ("A1", "2"),
                ("B1", "text"),
                ("A2", "=A1*3"),
                ("B2", "=SUM(Pay!A1:A2)"),
                ("C3", "TRUE"),
            ],
        ),
        tab("Pay", &[("A1", "40"), ("A2", "=Plan!A2")]),
    ];
    let files = [
        to_xlsx(&book).unwrap(),
        fixture("excel.xlsx"),
        fixture("libreoffice.xlsx"),
        fixture("openpyxl.xlsx"),
    ];
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let limits = Limits {
        unpacked: 4 << 20,
        cells: 10_000,
    };
    let (mut read, mut refused) = (0, 0);
    for round in 0..rounds {
        let file = &files[round % files.len()];
        // half the time the packed bytes are bent, half the time the text of one part
        let bent = match next() % 2 {
            0 => {
                let mut bytes = file.clone();
                for _ in 0..1 + next() % 4 {
                    let at = (next() % bytes.len() as u64) as usize;
                    bytes[at] = next() as u8;
                }
                bytes
            }
            _ => {
                let pick = next();
                let cut = next();
                let byte = next() as u8;
                let kind = next() % 3;
                let mut archive = zip::ZipArchive::new(Cursor::new(file)).unwrap();
                let target = archive
                    .by_index((pick % archive.len() as u64) as usize)
                    .unwrap()
                    .name()
                    .unwrap()
                    .to_string();
                repack(
                    file,
                    |name, mut content| {
                        if name == target && !content.is_empty() {
                            let at = (cut % content.len() as u64) as usize;
                            match kind {
                                0 => content[at] = byte,
                                1 => content.truncate(at),
                                _ => {
                                    let end = (at + 1 + (byte % 40) as usize).min(content.len());
                                    content.drain(at..end);
                                }
                            }
                        }
                        content
                    },
                    &[],
                )
            }
        };
        match from_xlsx(&bent, limits) {
            Ok(tabs) => {
                read += 1;
                if let Ok(shown) = values(&tabs) {
                    assert_eq!(shown.len(), tabs.len());
                }
                let _ = to_xlsx(&tabs);
            }
            Err(_) => refused += 1,
        }
    }
    println!("{rounds} bent files: {read} read, {refused} refused");
    assert!(read > rounds / 20 && refused > rounds / 20);
}
