import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

// Tracked files stand on their own: they describe the code as it is and never refer to how the
// project is planned, reviewed or built. Each rule is a kind of reference and the text that
// gives it away; `PLANTED` holds a sample for each. A rule reads every line (`line`), only
// comments, docs and test names (`prose`), only test names (`name`), or the file's path (`path`).
type Where = 'line' | 'prose' | 'name' | 'path'

// An id in parentheses: one or two letters and a number. Letters that also name rules, devices or
// handshake messages here (W3, S2, P1, T1, V8) count only with two digits.
const ID = String.raw`(?:(?:D|N|K|BA|B-D)\d{1,3}|[BCFHIJLMOQRUYZ]\d{1,2}|[AEGPSTVWX]\d{2})`
// A project version, not a number with a unit.
const VERSION = String.raw`0\.\d(?:\.\d+)?(?!\.?\d)(?! ?(?:s|ms|rem|em|px|%|x|×|seconds?|MB|GB|dB|deg)\b)`

// Words match in any case (`i`); ids, tags and paths keep theirs (`(?-i:...)`).
const RULES: [kind: string, where: Where, pattern: RegExp][] = [
  ['section sign', 'line', /§/],
  ['spec citation', 'line', /\bspec (§|r?\d|(?-i:[A-E])\b)/i],
  ['spec citation', 'line', /\b(of|in|by|per|see) the spec\b|\bthe spec('s| says| wording)\b/i],
  ['review', 'line', /\b(re-)?review (n|ba|w\d)-[a-z0-9]/i],
  ['review', 'line', /\br\d+[a-f]? (attack |completeness |production )?(re-)?review\b/i],
  ['review', 'line', /\b(attack|completeness|production) (re-)?review\b/i],
  ['review', 'line', /\b(re-)?review(er)?('s)? [CIM]\d+\b/i],
  ['review', 'line', /\bthe (re-)?(review|reviewer)'s\b/i],
  ['round', 'line', /\bfix[- ]rounds? \d/i],
  ['round', 'line', /\bround \d/i],
  ['round', 'line', /(?<![a-z0-9])r([2-9]|[1-9]\d)[a-f](?![a-z0-9])|\br[2-9]\.\d\b|\bR8-[a-z]/],
  ['round', 'line', /(?<![A-Za-z0-9])r\d+_[a-z]/],
  ['round', 'line', /\br\d+[a-f]? (vectors?|work|range|fuzz|findings?)\b/i],
  ['round', 'path', /(^|[/_.-])r\d+[a-f](?=[/_.-])|[_-]r\d+(?=[/_.-])|(^|\/)r\d+[_-]/],
  ['revision', 'line', /\brevisions?[- ]\d/i],
  ['ruling', 'line', /\brulings?\b/i],
  ['ruling', 'line', /\bowner (question|ruling)\b|\bcontroller('s)? (ruling|proposal)\b/i],
  ['dispatch', 'line', /\bdispatch \d/i],
  ['task', 'line', /\btask \d+\b/i],
  ['plan', 'line', /\bplan (?-i:[A-Z])\d*\b/i],
  ['plan', 'line', /(?<![a-z0-9])plan[_-][a-z](?![a-z0-9])|[Pp]lan[A-Z](?![a-z])/],
  ['plan', 'path', /(^|[/_.-])plan[_-]?[a-z](?=[/_.-])/],
  ['design', 'line', /\bdesign (?-i:[A-E])\b|(?<![a-z0-9])design[_-][a-e](?![a-z0-9])/i],
  ['amendment', 'line', /\bamendments? \d|\bthe amendments?\b/i],
  ['finding id', 'line', /\[(H\d+|R\d?V\d? [CIM]\d+)\]/],
  ['finding id', 'line', /\bN\d{2} \([a-z]\)/],
  ['finding id', 'prose', new RegExp(String.raw`(?<![\w)])\(${ID}(?:, ${ID})*[,;:) ]`)],
  ['lane', 'line', /\b(lane|branch) (n|ba|w\d)-[a-z0-9]|\b(n|ba)-[a-z0-9]+(-[a-z0-9]+)* r\d\b/i],
  ['lane', 'line', /\blane (?-i:[A-Z])\b/i],
  ['work folder', 'line', /\.superpowers\b|(^|[^\w-])notes\/[a-z]/i],
  ['version as a name', 'line', /\b0\.\d+\.\d+['’]s\b/],
  [
    'version as a name',
    'line',
    /\b0\.\d+\.\d+ (verifies|reads|does|did)\b|\bas 0\.\d+\.\d+\b(?!\.\d)/i,
  ],
  ['commit hash', 'line', /\bsince (?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i],
  [
    'version as history',
    'prose',
    new RegExp(String.raw`\b(?:after|since|before|until|in|as of) ${VERSION}`, 'i'),
  ],
  [
    'version as history',
    'prose',
    new RegExp(
      String.raw`\b(?:the|an?) 0\.\d\.\d+(?!\.?\d) [a-z]|\b(?:their|its) ${VERSION} [a-z]`,
      'i'
    ),
  ],
  [
    'version as history',
    'line',
    /(?:SINCE|AFTER|BEFORE|UNTIL)_0_?\d(?![A-Za-z0-9_])|(?:[Ss]ince|[Aa]fter|[Bb]efore|[Uu]ntil)_?0_?\d(?![A-Za-z0-9_.])/,
  ],
  ['work context', 'line', /\bstopped agent\b|\bthe brief\b/i],
  ['history in a test name', 'name', /\bstill\b|\bno longer\b|_still_|_no_longer_/i],
]

const PLANTED: [kind: string, file: string, sample: string][] = [
  ['section sign', 'a.ts', '// the views of §3.1'],
  ['spec citation', 'a.ts', '// A dropped header (spec 2.3)'],
  ['spec citation', 'a.ts', '// the exact wording of the spec'],
  ['review', 'a.ts', '// (review n-zz r2 M1, M2)'],
  ['review', 'a.ts', '// r5 review I3 (b)'],
  ['review', 'a.ts', '// the completeness review asked for it'],
  ['review', 'a.ts', '// review M4: bounded per claim'],
  ['review', 'a.ts', "// the reviewer's case"],
  ['round', 'a.ts', '// fix round 4: the head it was issued for'],
  ['round', 'a.ts', "// round 5's fix"],
  ['round', 'a.ts', '// Round 5: the head it was issued for'],
  ['round', 'a.ts', "import { World } from './acl_model_r8f/world'"],
  ['round', 'a.rs', '#[test]\nfn r8_chain() {'],
  ['round', 'a.rs', '    each_db("r8_backup_size", |state| async move {'],
  ['round', 'a.ts', '// the r8 vectors of the model'],
  ['round', 'a.ts', '// the r10b fuzz seeds'],
  ['round', 'tests/acl_model_r8f/vectors-r2.test.ts', ''],
  ['revision', 'a.ts', '// revision 5 counts them across epochs'],
  ['ruling', 'a.ts', '// kept by ruling'],
  ['ruling', 'a.ts', "// the controller's ruling on growth"],
  ['dispatch', 'a.ts', '// dispatch 5b-ii'],
  ['dispatch', 'a.ts', '// Dispatch 5b keeps it'],
  ['task', 'a.ts', "// Task 35's rule"],
  ['plan', 'a.ts', '// what plan C8 imports'],
  ['plan', 'a.ts', '// Plan C8 imports it'],
  ['plan', 'a.rs', '    each_db("reports_plan_h", |state| async move {'],
  ['plan', 'tests/plan_h/bodies.rs', ''],
  ['design', 'a.rs', 'fn temporary_passwords_follow_design_c() {'],
  ['amendment', 'a.ts', '// amendment 6'],
  ['amendment', 'a.ts', '// Amendment 6 pins it'],
  ['finding id', 'a.ts', '// [H17] a rotation drops only these'],
  ['finding id', 'a.ts', '// what N26 (f) leaves'],
  ['finding id', 'a.rs', '/// At most 50 per page (D3, D45).'],
  ['finding id', 'a.test.ts', "describe('growth bound (H17, H18)', () => {"],
  ['finding id', 'a.test.ts', "  test('thief acts after it are cut (H2 path)', () => {"],
  ['finding id', 'a.ts', '// bounded per claim (M1, M2)'],
  ['finding id', 'a.ts', '// one view per identity (W12)'],
  ['finding id', 'a.ts', '// a capped fan-out (U4)'],
  ['lane', 'a.ts', '// from lane n-zz'],
  ['lane', 'a.ts', '// Lane n-zz owns it'],
  ['lane', 'a.ts', '// a key of lane S'],
  ['work folder', 'a.ts', '// see .superpowers/sdd/report.md'],
  ['version as a name', 'a.ts', "// 0.3.0's rule"],
  ['version as a name', 'a.ts', '// 0.3.0’s rule'],
  ['version as a name', 'a.ts', '// verifies as 0.3.0 verifies it'],
  ['version as history', 'a.ts', '// Rows added after 0.3 sort last.'],
  ['version as history', 'a.test.ts', "  test('ids are stable since 0.3', () => {"],
  ['version as history', 'a.test.ts', "  test('each row does what it did in 0.3', () => {"],
  ['version as history', 'a.test.ts', "  test('rows keep their 0.3 order in each state', () => {"],
  ['version as history', 'a.ts', '// the 0.4.0 path'],
  ['version as history', 'a.ts', 'const SINCE_03 = new Set(ids)'],
  ['commit hash', 'a.ts', '// the type check, since 5773a6b'],
  ['work context', 'a.ts', '// the stopped agent left this'],
  ['work context', 'a.ts', '// The brief asks for this'],
  ['history in a test name', 'a.test.ts', "  test('old bodies still work', () => {"],
  ['history in a test name', 'a.rs', '#[test]\nfn plain_bodies_no_longer_fail() {'],
]

// Domain words that read like a reference: the file, the exact phrase, and what it is.
const ALLOWED: [file: string, phrase: string, why: string][] = [
  ['apps/server/src/api/polls.rs', 'round 1', 'a counting round of a ranked-choice poll'],
  ['apps/server/src/api/polls.rs', 'round 2', 'a counting round of a ranked-choice poll'],
  ['apps/web/app/globals.css', 'round 0.75rem', 'the CSS inset() corner radius'],
  ['crates/app-sheet/tests/sheet.rs', "IronCalc 0.9.1's", "a library's version"],
  [
    'apps/web/app/lib/__tests__/fx_gate.test.ts',
    'still pictures by choice',
    'the effects mode named still',
  ],
]

// Lock files hold other projects' text; this file holds the samples above.
const SKIPPED = /(^|\/)(bun\.lock|Cargo\.lock)$|^scripts\/internal_refs\.test\.ts$/

const TEST_CALL = /^\s*(test|describe|it)(\.[a-z]+)?\(/
const COMMENT = /^\s*(\/\/|\/\*|\*|#|--|<!--)|\s\/\/\/? /
const DOC = /\.(md|proto|txt)$/

// What a line is besides a line. A test name is prose too: the string of a test call, also on
// the line after it, and a Rust function under a test attribute.
const kinds = (file: string, lines: string[], i: number): Where[] => {
  const line = lines[i]
  const tsName =
    (TEST_CALL.test(line) && /\(\s*['"`]/.test(line)) ||
    (/^\s*['"`]/.test(line) && /^\s*(test|describe|it)(\.[a-z]+)?\($/.test(lines[i - 1] ?? ''))
  const rustName =
    file.endsWith('.rs') &&
    /^\s*(pub )?(async )?fn \w+\(/.test(line) &&
    /#\[.*test/.test(`${lines[i - 1] ?? ''}${lines[i - 2] ?? ''}`)
  const name = tsName || rustName
  const prose = name || COMMENT.test(line) || DOC.test(file)
  return ['line', ...(prose ? (['prose'] as const) : []), ...(name ? (['name'] as const) : [])]
}

const allowed = (file: string, line: string) =>
  ALLOWED.some(([f, phrase]) => f === file && line.includes(phrase))

const hits = (file: string, text: string): string[] => {
  const lines = text.split('\n')
  const inPath = RULES.flatMap(([kind, where, pattern]) => {
    const found = where === 'path' ? pattern.exec(file) : null
    return found ? [`${file}: ${kind}: ${found[0]}`] : []
  })
  return [
    ...inPath,
    ...lines.flatMap((line, i) => {
      let is: Where[] | null = null
      return RULES.flatMap(([kind, where, pattern]) => {
        const found = where === 'path' ? null : pattern.exec(line)
        if (!found || allowed(file, line)) return []
        is ??= kinds(file, lines, i)
        return is.includes(where) ? [`${file}:${i + 1}: ${kind}: ${found[0].trim()}`] : []
      })
    }),
  ]
}

const tracked = (): string[] => {
  const run = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root, stdout: 'pipe' })
  if (run.exitCode !== 0) throw new Error('git ls-files failed')
  return run.stdout.toString().split('\0').filter(Boolean)
}

const text = (file: string): string | null => {
  const bytes = readFileSync(join(root, file))
  return bytes.subarray(0, 8192).includes(0) ? null : bytes.toString('utf8')
}

const kindOf = (hit: string) => hit.split(': ').at(-2)

describe('tracked files', () => {
  const files = tracked()

  test('none refers to how the project is planned, reviewed or built', () => {
    expect(files.length).toBeGreaterThan(1000)
    const found = files
      .filter(file => !SKIPPED.test(file))
      .flatMap(file => hits(file, text(file) ?? ''))
    expect(found).toEqual([])
  }, 120_000)

  test('binary and lock files are left out, every other file is read', () => {
    expect(text('apps/web/public/favicon.ico')).toBeNull()
    expect(SKIPPED.test('bun.lock') && SKIPPED.test('Cargo.lock')).toBe(true)
    expect(SKIPPED.test('apps/server/Cargo.toml') || SKIPPED.test('README.md')).toBe(false)
    expect(text('README.md')?.length).toBeGreaterThan(100)
  })
})

describe('the rules', () => {
  for (const [kind, file, sample] of PLANTED)
    test(`${kind}: ${sample || file}`, () => {
      expect(hits(file, sample).map(kindOf)).toContain(kind)
    })

  test('every rule has a planted sample', () => {
    for (const [kind, where, pattern] of RULES)
      expect([
        kind,
        where,
        PLANTED.some(
          ([k, file, sample]) => k === kind && pattern.test(where === 'path' ? file : sample)
        ),
      ]).toEqual([kind, where, true])
  })

  test('words match in any case', () => {
    for (const [kind, where, pattern] of RULES) {
      if (where === 'path' || !pattern.flags.includes('i')) continue
      const loud = PLANTED.flatMap(([k, file, sample]) => {
        const found = k === kind && pattern.exec(sample)
        return found ? [[file, sample.replace(found[0], found[0].toUpperCase())]] : []
      })
      expect([pattern.source, loud.length > 0]).toEqual([pattern.source, true])
      for (const [file, line] of loud)
        expect([line, pattern.test(line), hits(file, line).map(kindOf).includes(kind)]).toEqual([
          line,
          true,
          true,
        ])
    }
  })

  test('plain code and prose pass', () => {
    const fine: [file: string, line: string][] = [
      ['a.ts', 'const spec: EffectSpec = { shape: "rain" }'],
      ['a.ts', '// A role (rules 2): a counting upgrade, "rules: 3" on the wire.'],
      ['a.ts', '// The owner is no longer a member, and the copy still shows.'],
      ['a.ts', '// Server version, for example "0.9.0".'],
      ['a.ts', '// W3(e): a join needs a third identity; S2 and S3 (S4) of a redaction; E1 or E2.'],
      ['a.ts', 'expect(text).toBe("release-notes/0.3.0.md")'],
      ['a.test.ts', "  test('within 5 rounds, at most 8 links each', () => {"],
      ['a.ts', 'const r1a = { n: 1 }, r2 = role(w, 2), id = r2.id'],
      ['a.json', '      "formula": "=ABS(D29)",'],
      ['a.rs', 'fn group_plan_sql(gate: &Gate) -> String {'],
      ['a.rs', 'fn is_still_valid(now: i64) -> bool {'],
      ['apps/web/app/lib/r2/store.ts', '// Reads the bucket.'],
      [
        'a.ts',
        '// T1 = SHA-256(H1 || e_r || n_r); a role cap (W5), Chromium (V8), the device (P1) of P.',
      ],
      ['a.ts', '// The formula =ABS(D29) reads one cell.'],
      ['a.test.ts', "  test('dialogs scale from 0.96 and settle in 0.2 s', () => {"],
      ['a.ts', '// The sheet fades after 0.3 s to a 0.5 opacity; the 0.75rem corner stays.'],
      ['a.ts', 'const since = 3, r1b = rows.after_0, version = "0.3.0"'],
      ['a.sh', 'echo "Volumes made by images before 0.3.0 belong to root"'],
      ['a.rs', 'const SINCE_0_8_0: [Service; 4] = [Service::Core, Service::Letters];'],
      ['a.ts', '// Plan a rollout, design a page, keep a lane a car fits.'],
    ]
    expect(fine.flatMap(([file, line]) => hits(file, line))).toEqual([])
  })
})

describe('the allowlist', () => {
  for (const [file, phrase, why] of ALLOWED)
    test(`${file}: "${phrase}" is ${why}`, () => {
      const line = file.endsWith('.test.ts') ? `  test('${phrase}', () => {` : `// ${phrase}`
      const other = file.replace(/[^/.]+(\.test)?\.([a-z]+)$/, 'x$1.$2')
      expect(hits(file, line)).toEqual([])
      expect(hits(other, line).length).toBeGreaterThan(0)
      expect(readFileSync(join(root, file), 'utf8')).toContain(phrase)
    })
})
