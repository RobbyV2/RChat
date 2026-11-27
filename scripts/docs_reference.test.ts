import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inlineScripts, scriptHash } from '../docs/scripts/finish'
import {
  parseEnv,
  renderCli,
  renderPermissions,
  renderSettings,
  type CliCommand,
} from '../docs/scripts/reference'
import type { Bit } from '../apps/web/app/lib/perms'

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')

const SAMPLE = `# Copy to .env.local.
# Names listed here follow this file.
# SETTINGS_PINNED=AUTH_REGISTRATION

# Uploads
# Largest upload in MiB, 1 to 512.
# UPLOAD_MAX_MIB=25
# Admin page: file uploads, on or off.
# FEATURE_FILE_UPLOADS=on

# Storage
# Set the first two to store uploads in a bucket.
# S3_ENDPOINT=http://127.0.0.1:9000
# S3_BUCKET=rchat
# The rate limits count per client address.

# Okta Web app: use https://<org>.okta.com/oauth2/default and set OIDC_OKTA_SCOPES='openid profile'.

APP_MODE=full
`

describe('settings reference', () => {
  test('sections, descriptions, shared blocks, notes and markers come from the file', () => {
    const ref = parseEnv(SAMPLE)
    expect(ref.intro).toEqual(['Copy to .env.local.'])
    expect(ref.sections.map(s => s.title)).toEqual(['General', 'Uploads', 'Storage'])
    const [general, uploads, storage] = ref.sections
    expect(general.items).toEqual([
      {
        kind: 'settings',
        settings: [{ name: 'SETTINGS_PINNED', value: 'AUTH_REGISTRATION', commented: true }],
        text: ['Names listed here follow this file.'],
        admin: false,
        range: null,
      },
    ])
    expect(uploads.items).toEqual([
      {
        kind: 'settings',
        settings: [{ name: 'UPLOAD_MAX_MIB', value: '25', commented: true }],
        text: ['Largest upload in MiB, 1 to 512.'],
        admin: false,
        range: '1 to 512',
      },
      {
        kind: 'settings',
        settings: [{ name: 'FEATURE_FILE_UPLOADS', value: 'on', commented: true }],
        text: ['File uploads, on or off.'],
        admin: true,
        range: null,
      },
    ])
    const [bucket, note, okta, mode] = storage.items
    expect(bucket.kind === 'settings' && bucket.settings.map(s => s.name)).toEqual([
      'S3_ENDPOINT',
      'S3_BUCKET',
    ])
    expect(note).toEqual({ kind: 'note', text: ['The rate limits count per client address.'] })
    expect(okta.kind).toBe('note')
    expect(mode).toMatchObject({
      kind: 'settings',
      settings: [{ name: 'APP_MODE', value: 'full', commented: false }],
    })
    const page = renderSettings(ref)
    expect(page).toContain('### S3_ENDPOINT, S3_BUCKET')
    expect(page).toContain('Default or example: `25` · Range: 1 to 512')
    expect(page).toContain('Default or example: `on` · Also on the admin page')
    expect(page).toContain('Set in the example: `full`')
    expect(page).toContain(
      "use `https://<org>.okta.com/oauth2/default` and set `OIDC_OKTA_SCOPES='openid profile'`."
    )
    expect(page).not.toContain('<org>.okta.com/oauth2/default and')
  })

  test('the page lists every setting of .env.local.example once', () => {
    const source = read('.env.local.example')
    const names = source
      .split('\n')
      .map(l => /^(?:# )?([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
    const ref = parseEnv(source)
    const listed = ref.sections.flatMap(s =>
      s.items.flatMap(i => (i.kind === 'settings' ? i.settings.map(x => x.name) : []))
    )
    expect(listed.sort()).toEqual([...names].sort())
    expect(new Set(listed).size).toBe(listed.length)
    const page = renderSettings(ref)
    for (const name of names) expect(page).toMatch(new RegExp(`^### (.*, )?${name}(,|$)`, 'm'))
    expect(ref.sections.length).toBeGreaterThan(30)
    const docs = ref.sections
      .flatMap(s => s.items)
      .find(i => i.kind === 'settings' && i.settings.some(x => x.name === 'FEATURE_DOCS'))
    expect(docs).toMatchObject({ admin: true })
  })
})

describe('permissions reference', () => {
  test('every bit of the shared registry has a row', () => {
    const bits = JSON.parse(read('assets/perm_bits.json')) as Bit[]
    const page = renderPermissions(bits)
    const rows = page
      .split('\n')
      .filter(l => l.startsWith('| ') && !l.startsWith('| Permission') && !l.startsWith('| ---'))
    expect(rows.length).toBe(bits.length)
    for (const b of bits) expect(page).toContain(`| ${b.label} | \`${b.name}\` | ${b.value} |`)
    expect(page).toContain(
      '| Mention everyone | `MentionEveryone` | 32 | Channel | No | Yes | Yes, bit 128 |'
    )
    expect(page).toContain('| Delete server | `DeleteServer` | 8 | Server | No | Yes | No |')
  })
})

describe('command line reference', () => {
  test('commands, usage and flags come from the committed description', () => {
    const cli = JSON.parse(read('docs/generated/cli.json')) as CliCommand
    const page = renderCli(cli)
    expect(page).toContain('## server\n')
    expect(page).toContain('### server user\n')
    expect(page).toContain('#### server user create\n')
    expect(page).toContain('#### server user reset-password\n')
    expect(page).toContain('- `-p, --port <PORT>`: Server port.')
    expect(page).toContain('- `<NAME>` (required): The username.')
    expect(page).toContain('server user create [OPTIONS] <NAME>')
  })

  test('the committed descriptions parse', () => {
    const api = JSON.parse(read('docs/generated/openapi.json'))
    expect(String(api.openapi)).toStartWith('3.')
    expect(Object.keys(api.paths).length).toBeGreaterThan(100)
    expect(api.paths['/api/v1/settings']).toBeDefined()
  })
})

describe('inline script hashes', () => {
  test('only scripts a browser runs inline are hashed', () => {
    const html = [
      '<script>let a = 1</script>',
      '<script type="module">import "./x.js"</script>',
      '<script type="module" src="/docs/_astro/page.js"></script>',
      '<script src=/a.js></script>',
      '<script type="application/ld+json">{"a":1}</script>',
      '<SCRIPT aria-hidden="true">b()</SCRIPT >',
      '<script data-type="x" data-src="y">c()</script>',
    ].join('\n')
    expect(inlineScripts(html)).toEqual(['let a = 1', 'import "./x.js"', 'b()', 'c()'])
  })

  test('hashes are the CSP form of SHA-256', () => {
    expect(scriptHash('')).toBe('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=')
    expect(scriptHash('let a = 1')).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/)
  })
})
