// Rebuilds crates/fed/data/public_suffix_list.dat from the Public Suffix List: the rules of the
// ICANN and private sections, in ASCII (punycode), sorted, with the list's version and its
// license notice. Run with `just src refresh-psl` and commit the result. Nothing fetches the
// list at build time or at runtime.
import { writeFileSync } from 'node:fs'
import { domainToASCII, fileURLToPath } from 'node:url'

const SOURCE = 'https://publicsuffix.org/list/public_suffix_list.dat'
const USER_AGENT = 'rchat-dev-check'
export const OUT = fileURLToPath(
  new URL('../crates/fed/data/public_suffix_list.dat', import.meta.url)
)

const SECTIONS = ['ICANN', 'PRIVATE'] as const
const NOTICE = [
  '// This Source Code Form is subject to the terms of the Mozilla Public',
  '// License, v. 2.0. If a copy of the MPL was not distributed with this',
  '// file, You can obtain one at https://mozilla.org/MPL/2.0/.',
]
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

const ascii = (rule: string) => {
  const mark = rule.startsWith('!') ? '!' : rule.startsWith('*.') ? '*.' : ''
  const name = domainToASCII(rule.slice(mark.length).toLowerCase())
  if (!name || !name.split('.').every(label => LABEL.test(label)))
    throw new Error(`not a host name: ${rule}`)
  return `${mark}${name}`
}

const rules = (text: string, section: string) => {
  const begin = text.indexOf(`// ===BEGIN ${section} DOMAINS===`)
  const end = text.indexOf(`// ===END ${section} DOMAINS===`)
  if (begin < 0 || end < begin) throw new Error(`no ${section} section`)
  const found = text
    .slice(begin, end)
    .split('\n')
    .map(line => line.trim().split(/\s+/)[0])
    .filter(rule => rule && !rule.startsWith('//'))
    .map(ascii)
  if (found.length === 0) throw new Error(`no rules in the ${section} section`)
  return [...new Set(found)].sort()
}

const line = (text: string, name: string) => {
  const found = text.match(new RegExp(`^// ${name}: (\\S+)$`, 'm'))
  if (!found) throw new Error(`no ${name} line`)
  return `// ${name}: ${found[1]}`
}

export const snapshot = (text: string) =>
  [
    '// Public Suffix List snapshot: the rules only, in ASCII, sorted. Made by scripts/refresh_psl.ts.',
    `// Source: ${SOURCE}`,
    line(text, 'VERSION'),
    line(text, 'COMMIT'),
    ...NOTICE,
    ...SECTIONS.flatMap(section => [
      `// ===BEGIN ${section} DOMAINS===`,
      ...rules(text, section),
      `// ===END ${section} DOMAINS===`,
    ]),
    '',
  ].join('\n')

const main = async () => {
  const res = await fetch(SOURCE, { headers: { 'user-agent': USER_AGENT } })
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
  const out = snapshot(await res.text())
  writeFileSync(OUT, out)
  console.log(`${out.split('\n').filter(l => l && !l.startsWith('//')).length} rules; wrote ${OUT}`)
}

if (import.meta.main)
  main().catch(e => {
    console.error(e)
    process.exit(1)
  })
