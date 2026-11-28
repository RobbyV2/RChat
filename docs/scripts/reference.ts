// Writes the reference pages of the docs site from the files they describe: every setting from
// the settings registry (assets/settings.json), the permission bits from assets/perm_bits.json and the server's command
// line from docs/generated/cli.json. The pages are build output (src/content/docs/reference).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Bit } from '../../apps/web/app/lib/perms'

export interface Setting {
  name: string
  value: string
  commented: boolean
}

export type Item =
  | { kind: 'settings'; settings: Setting[]; text: string[]; admin: boolean; range: string | null }
  | { kind: 'note'; text: string[] }

export interface Section {
  title: string
  items: Item[]
}

export interface EnvReference {
  intro: string[]
  sections: Section[]
}

const SETTING = /^(# )?([A-Z][A-Z0-9_]*)=(.*)$/
const RANGE = /(-?\d+) to (-?\d+)(?: (characters|days|hours|seconds|milliseconds|MiB|KiB|entries))?/
const ADMIN = 'Admin page: '

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const comment = (line: string) => (line.startsWith('#') ? line.replace(/^# ?/, '') : null)

// A block that opens a section: one short comment line without a sentence in it.
const isHeading = (text: string) =>
  text.length > 0 && text.length <= 40 && !/[:.=]$/.test(text) && !text.includes(': ')

const settingOf = (line: string): Setting | null => {
  const m = SETTING.exec(line)
  return m ? { name: m[2], value: m[3], commented: m[1] !== undefined } : null
}

const unquoted = (value: string) =>
  /^'.*'$/.test(value) || /^".*"$/.test(value) ? value.slice(1, -1) : value

// The comment lines before a setting describe it, and settings with no comment between them
// share that description. Comment lines after the last setting of a block are a note.
const items = (lines: string[]): Item[] => {
  const out: Item[] = []
  let text: string[] = []
  let open: Extract<Item, { kind: 'settings' }> | null = null
  for (const line of lines) {
    const setting = settingOf(line)
    if (setting && open && text.length === 0) {
      open.settings.push(setting)
    } else if (setting) {
      const admin = text[0]?.startsWith(ADMIN) ?? false
      const said = text.map((t, i) => (i === 0 && admin ? capital(t.slice(ADMIN.length)) : t))
      const range = RANGE.exec(said.join(' '))?.[0] ?? null
      open = { kind: 'settings', settings: [setting], text: said, admin, range }
      out.push(open)
      text = []
    } else {
      const said = comment(line)
      if (said !== null) text.push(said)
      open = null
    }
  }
  if (text.length > 0) out.push({ kind: 'note', text })
  return out
}

const blocks = (source: string) => {
  const found: string[][] = []
  let block: string[] = []
  for (const line of source.split('\n')) {
    if (line.trim() === '') {
      if (block.length > 0) found.push(block)
      block = []
    } else block.push(line)
  }
  if (block.length > 0) found.push(block)
  return found
}

// The file's first block opens with notes about the whole file; the comment line right before
// its first setting describes that setting.
export function parseEnv(source: string): EnvReference {
  const [first = [], ...rest] = blocks(source)
  const firstSetting = first.findIndex(l => settingOf(l) !== null)
  const introEnd = firstSetting > 0 ? firstSetting - 1 : first.length
  const intro = first.slice(0, introEnd).map(l => comment(l) ?? l)
  const sections: Section[] = []
  const general = first.slice(introEnd)
  if (general.length > 0) sections.push({ title: 'General', items: items(general) })
  for (const block of rest) {
    const head = comment(block[0])
    if (head !== null && isHeading(head)) {
      sections.push({ title: head, items: items(block.slice(1)) })
    } else if (sections.length > 0) {
      sections[sections.length - 1].items.push(...items(block))
    } else {
      sections.push({ title: 'General', items: items(block) })
    }
  }
  return { intro, sections }
}

const code = (text: string) => {
  const ticks = text.includes('`') ? '``' : '`'
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${text}${pad}${ticks}`
}

// Markdown from a line of the env file: plain text, with setting names (and the value or path
// written right after one) as code.
const NAME =
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b(?:='[^']*'|=\S+|\/[\w/.<>-]*)?|'[[{][^']*'|"#[^"]*"|https?:\/\/\S+/g
const escape = (text: string) => text.replace(/[<>&]/g, c => `&#${c.charCodeAt(0)};`)
const prose = (text: string) => {
  let out = ''
  let at = 0
  for (const m of text.matchAll(NAME)) {
    out += escape(text.slice(at, m.index)) + code(m[0].replace(/[.,]$/, ''))
    at = m.index + m[0].length - (/[.,]$/.test(m[0]) ? 1 : 0)
  }
  return out + escape(text.slice(at))
}

// The settings registry as assets/settings.json holds it: each setting, and the lines of the env
// file it writes.
export interface Registry {
  settings: { env: string; kind: string; scope: string; min?: number; max?: number }[]
  file: ({ note: string } | { env: string; name: string; value: string; set: boolean })[][]
}

// The reference of the registry: the env file's sections and notes, with whether the admin page
// changes a setting taken from its item, and a number's range from its item where its comment
// gives none.
export function parseRegistry(registry: Registry): EnvReference {
  const source = registry.file
    .map(block =>
      block.map(l => ('note' in l ? l.note : `${l.set ? '' : '# '}${l.name}=${l.value}`)).join('\n')
    )
    .join('\n\n')
  const ref = parseEnv(`${source}\n`)
  const envOf = new Map(registry.file.flat().flatMap(l => ('note' in l ? [] : [[l.name, l.env]])))
  const byEnv = new Map(registry.settings.map(s => [s.env, s]))
  for (const item of ref.sections.flatMap(s => s.items)) {
    if (item.kind !== 'settings') continue
    const setting = byEnv.get(envOf.get(item.settings[0].name) ?? '')
    if (!setting) continue
    item.admin = setting.scope === 'live'
    if (setting.kind === 'number' && setting.min !== undefined && setting.max !== undefined) {
      item.range = item.range ?? `${setting.min} to ${setting.max}`
    }
  }
  return ref
}

export function renderSettings(ref: EnvReference): string {
  const out = [
    '---',
    'title: Settings',
    'description: Every server setting with its default or example value, its range and whether the admin page changes it.',
    'tableOfContents:',
    '  maxHeadingLevel: 2',
    '---',
    '',
    'This page is generated from the settings registry, which also writes `.env.local.example`. It lists every setting of the server and of its builds. Put settings in `.env.local` in the folder the server starts in, or in its environment.',
    '',
    ...ref.intro.map(l => `- ${prose(l)}`),
    '',
  ]
  for (const section of ref.sections) {
    out.push(`## ${section.title}`, '')
    for (const item of section.items) {
      if (item.kind === 'note') {
        out.push(item.text.map(prose).join(' '), '')
        continue
      }
      out.push(`### ${item.settings.map(s => s.name).join(', ')}`, '')
      if (item.text.length > 0) out.push(item.text.map(prose).join(' '), '')
      const shown = (s: Setting) => {
        const value = unquoted(s.value)
        return value === '' ? 'empty' : code(value)
      }
      const label = item.settings.some(s => !s.commented)
        ? 'Set in the example'
        : 'Default or example'
      const facts = [
        item.range ? `Range: ${item.range}` : null,
        item.admin ? 'Also on the admin page' : null,
      ].filter(Boolean)
      if (item.settings.length === 1) {
        out.push([`${label}: ${shown(item.settings[0])}`, ...facts].join(' · '), '')
      } else {
        if (facts.length > 0) out.push(facts.join(' · '), '')
        out.push(`${label}:`, '', ...item.settings.map(s => `- ${code(s.name)}: ${shown(s)}`), '')
      }
    }
  }
  return `${out.join('\n').trimEnd()}\n`
}

const state = (s: 'live' | 'reserved') => (s === 'live' ? 'Yes' : 'Reserved')

export function renderPermissions(bits: Bit[]): string {
  const rows = bits.map(b =>
    [
      b.label,
      code(b.name),
      String(b.value),
      b.scope === 'server' ? 'Server' : 'Channel',
      b.everyone ? 'Yes' : 'No',
      state(b.hosted),
      b.p2p ? `${state(b.p2p.state)}, bit ${b.p2p.value}` : 'No',
    ].join(' | ')
  )
  return [
    '---',
    'title: Permissions',
    'description: The permission bits of server roles, hosted and P2P.',
    '---',
    '',
    'This page is generated from `assets/perm_bits.json`, the registry the server, the web app and P2P rooms share. A role holds the sum of its bits. Channel permissions can also be set per role or member on a channel; server permissions apply to the whole server.',
    '',
    '- **Everyone** says whether the @everyone role holds the bit unless the server changes it.',
    '- **Hosted** says whether hosted servers use the bit. A reserved bit is kept in stored masks and has no effect.',
    '- **P2P** names the bit P2P rooms use for the same permission, which can differ from the hosted bit.',
    '',
    '| Permission | Name | Bit | Applies to | Everyone | Hosted | P2P |',
    '| --- | --- | --: | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r} |`),
    '',
  ].join('\n')
}

export interface CliArg {
  id: string
  long: string | null
  short: string | null
  value: string | null
  positional: boolean
  required: boolean
  help: string | null
}

export interface CliCommand {
  name: string
  about: string | null
  usage: string
  args: CliArg[]
  commands: CliCommand[]
}

// Clap drops the closing period of a help text.
const sentence = (text: string) => (/[.?!]$/.test(text) ? text : `${text}.`)

const flag = (a: CliArg) => {
  if (a.positional) return `<${a.value ?? a.id.toUpperCase()}>`
  const names = [a.short ? `-${a.short}` : null, a.long ? `--${a.long}` : null].filter(Boolean)
  return a.value ? `${names.join(', ')} <${a.value}>` : names.join(', ')
}

const commandLines = (cmd: CliCommand, path: string[], depth: number): string[] => {
  const name = [...path, cmd.name].join(' ')
  const out = [
    `${'#'.repeat(depth)} ${name}`,
    '',
    ...(cmd.about ? [sentence(cmd.about), ''] : []),
    '```sh',
    cmd.usage,
    '```',
    '',
  ]
  if (cmd.args.length > 0) {
    for (const a of cmd.args)
      out.push(
        `- ${code(flag(a))}${a.required ? ' (required)' : ''}${a.help ? `: ${sentence(a.help)}` : ''}`
      )
    out.push('')
  }
  for (const sub of cmd.commands)
    out.push(...commandLines(sub, [...path, cmd.name], Math.min(depth + 1, 4)))
  return out
}

export function renderCli(cli: CliCommand): string {
  return [
    '---',
    'title: Command line',
    "description: The server binary's commands and flags.",
    '---',
    '',
    "This page is generated from the server's command line definition. Flags override the settings of the same meaning in the environment. From source, run the binary with `cargo run --bin server --` followed by its arguments; in the Docker image it is `/app/server`.",
    '',
    ...commandLines(cli, [], 2),
  ]
    .join('\n')
    .trimEnd()
    .concat('\n')
}

const root = join(import.meta.dir, '..', '..')

export function writeReference(out = join(import.meta.dir, '..', 'src/content/docs/reference')) {
  const read = (path: string) => readFileSync(join(root, path), 'utf8')
  const pages: [string, string][] = [
    ['settings.md', renderSettings(parseRegistry(JSON.parse(read('assets/settings.json'))))],
    ['permissions.md', renderPermissions(JSON.parse(read('assets/perm_bits.json')) as Bit[])],
    ['command-line.md', renderCli(JSON.parse(read('docs/generated/cli.json')) as CliCommand)],
  ]
  for (const [file, text] of pages) {
    const path = join(out, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  return pages.map(([file]) => file)
}

if (import.meta.main) writeReference()
