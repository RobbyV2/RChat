import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Hosted permission masks reach 2^34, and the bitwise operators cut numbers to 32 bits: the web
// client combines them with the helpers of `lib/perms.ts`. P2P wire masks stay below 2^31 and
// keep the operators.
const app = join(import.meta.dir, '..', 'apps/web/app')
const bitwise =
  /\b(?:[a-z]\w*)?[pP]erms(\([^()]*\))?\s*[&|^]\s|[&|^]\s*~?\s*(Perm|ChannelPermBit|ALL_PERMS|TIMED_OUT_PERMS)\b|\b(ALL_PERMS|TIMED_OUT_PERMS)\s*[&|^]\s|[&|^]\s*~?\s*(?:\w+\.)?bit\b|\bbit\s*[&|^]\s/
const skipped = (path: string) =>
  path === 'lib/perms.ts' ||
  path.startsWith('lib/p2p/') ||
  path.startsWith('components/p2p/') ||
  path === 'lib/actions/p2p_server.ts' ||
  path.includes('__tests__/')

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })

const offending = (text: string) =>
  text
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .filter(line => bitwise.test(line.replace(/&&|\|\|/g, '')))

describe('hosted permission masks', () => {
  test('the web client never combines them with bitwise operators', () => {
    const found = files(app)
      .map(path => [relative(app, path), path] as const)
      .filter(([name]) => !skipped(name))
      .flatMap(([name, path]) =>
        offending(readFileSync(path, 'utf8')).map(line => `${name}: ${line.trim()}`)
      )
    expect(found).toEqual([])
  })

  test('the scan sees each form', () => {
    const forms = [
      'const x = (perms & Perm.Kick) !== 0',
      'return member.perms & ALL_PERMS',
      'siteAdmin || (granted & ALL_PERMS & ~perms) === 0',
      'myPerms(get(), ev.server) & (Perm.ManageAdmins | Perm.ManageRoles)',
      'const y = stored | Perm.Kick',
      'const z = my_perms & ChannelPermBit.SendMessages',
      'x = ALL_PERMS & ~mask',
      'checked={(value & bit) !== 0}',
      'onChange={() => onChange(value ^ bit)}',
      'PERM_ITEMS.filter(p => (bits & p.bit) !== 0)',
      'const w = perms ^ Perm.Kick',
    ]
    for (const form of forms) expect([form, offending(form).length]).toEqual([form, 1])
    const fine = [
      'hasPerm(perms, Perm.Kick)',
      'maskAnd(member.perms, ALL_PERMS)',
      'if (perms && other) return',
      'const both = hasPerm(perms, Perm.Kick) || siteAdmin',
      '// perms & Perm.Kick',
      'as PermsModule & { default: () => void }',
      'onChange(maskXor(value, bit))',
      'return { w: (bits & 0x3fff) + 1 }',
    ]
    for (const form of fine) expect([form, offending(form).length]).toEqual([form, 0])
  })
})
