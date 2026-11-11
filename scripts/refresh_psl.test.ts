import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OUT, snapshot } from './refresh_psl'

const UPSTREAM = `// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// VERSION: 2026-11-11_13-52-29_UTC
// COMMIT: 7786aac8931b7069d6fe2174a7471a54d273d3e6

// ===BEGIN ICANN DOMAINS===

// ac : http://nic.ac/rules.htm
ac
com.ac

// ck : https://www.iana.org/domains/root/db/ck.html
*.ck
!www.ck

// cn
公司.cn
CO.UK   // trailing words are dropped
co.uk

// ===END ICANN DOMAINS===

// ===BEGIN PRIVATE DOMAINS===
// Tailscale Inc. : https://www.tailscale.com
ts.net
*.c.ts.net
duckdns.org
// ===END PRIVATE DOMAINS===
`

const EXPECTED = `// Public Suffix List snapshot: the rules only, in ASCII, sorted. Made by scripts/refresh_psl.ts.
// Source: https://publicsuffix.org/list/public_suffix_list.dat
// VERSION: 2026-11-11_13-52-29_UTC
// COMMIT: 7786aac8931b7069d6fe2174a7471a54d273d3e6
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// ===BEGIN ICANN DOMAINS===
!www.ck
*.ck
ac
co.uk
com.ac
xn--55qx5d.cn
// ===END ICANN DOMAINS===
// ===BEGIN PRIVATE DOMAINS===
*.c.ts.net
duckdns.org
ts.net
// ===END PRIVATE DOMAINS===
`

describe('the Public Suffix List snapshot', () => {
  test('keeps the rules of both sections in ASCII, sorted, with the notice and the version', () => {
    expect(snapshot(UPSTREAM)).toBe(EXPECTED)
  })

  test('making a snapshot of a snapshot changes nothing', () => {
    expect(snapshot(EXPECTED)).toBe(EXPECTED)
  })

  test('a list without both sections, a version or rules is refused', () => {
    expect(() => snapshot(UPSTREAM.replace('// ===BEGIN PRIVATE DOMAINS===', ''))).toThrow(
      'PRIVATE'
    )
    expect(() => snapshot(UPSTREAM.replace('// VERSION:', '// version'))).toThrow('VERSION')
    expect(() => snapshot(UPSTREAM.replace(/ts\.net\n\*\.c\.ts\.net\nduckdns\.org\n/, ''))).toThrow(
      'PRIVATE'
    )
  })

  test('a rule that is not a host name is refused', () => {
    expect(() => snapshot(UPSTREAM.replace('com.ac', 'com..ac'))).toThrow('com..ac')
    expect(() => snapshot(UPSTREAM.replace('com.ac', 'a*.ac'))).toThrow('a*.ac')
  })

  test('the bundled snapshot is the script output and holds both kinds of rules', () => {
    const bundled = readFileSync(OUT, 'utf8')
    expect(OUT).toBe(join(import.meta.dir, '..', 'crates/fed/data/public_suffix_list.dat'))
    expect(snapshot(bundled)).toBe(bundled)
    expect(bundled.split('\n').every(line => /^[\x20-\x7e]*$/.test(line))).toBe(true)
    const icann = bundled.slice(0, bundled.indexOf('// ===END ICANN DOMAINS==='))
    const priv = bundled.slice(bundled.indexOf('// ===BEGIN PRIVATE DOMAINS==='))
    for (const rule of ['com', 'co.uk', '*.ck', '!www.ck', 'xn--55qx5d.cn'])
      expect({ rule, found: icann.includes(`\n${rule}\n`) }).toEqual({ rule, found: true })
    for (const rule of ['ts.net', 'duckdns.org', 'trycloudflare.com', 'github.io', 'fly.dev'])
      expect({ rule, found: priv.includes(`\n${rule}\n`) }).toEqual({ rule, found: true })
    expect(icann.includes('\nts.net\n')).toBe(false)
  })
})
