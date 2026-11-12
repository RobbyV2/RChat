import { describe, expect, test } from 'bun:test'
import {
  CSS_NOTE,
  FULL,
  FULL_ACCESS_NOTE,
  PERMS,
  RESERVED,
  RESERVED_REFUSAL,
  RISK_LABEL,
  SANDBOX_NOTE,
  egress,
  known,
  line,
  lines,
  netHost,
  netPattern,
  publicSuffixes,
  reads,
  reserved,
  risk,
  type PermText,
} from '../plugins/perm_text'
import { summary, summaryLine, type Summary } from '../plugins/summary'
import catalog from './fixtures/plugins_catalog.json'
import net from './fixtures/plugins_net_vectors.json'
import suffixes from './fixtures/plugins_public_suffixes.json'
import vectors from './fixtures/plugins_vectors.json'

const shared = publicSuffixes(suffixes.rules)

type Flags = { risk: string; reads?: boolean; egress?: boolean }

describe('the permission catalog', () => {
  test('48 permissions with the risk, read and pass-on flags of the model', () => {
    const want = catalog.catalog as Record<string, Flags>
    expect(Object.keys(PERMS)).toEqual(Object.keys(want))
    expect(Object.keys(PERMS)).toHaveLength(48)
    for (const [p, w] of Object.entries(want)) {
      const got: PermText = PERMS[p]
      if (got.risk !== w.risk || !!got.reads !== !!w.reads || !!got.egress !== !!w.egress)
        throw new Error(p)
      if (reads(p) !== !!w.reads || egress(p) !== !!w.egress) throw new Error(`${p} flags`)
    }
  })

  test('net patterns', () => {
    expect(vectors.net_patterns).toHaveLength(11)
    for (const c of vectors.net_patterns)
      if (netPattern(c.p, shared) !== c.want) throw new Error(`${c.p}: ${netPattern(c.p, shared)}`)
    expect(netPattern('read:messages', shared)).toBeNull()
    expect(
      netPattern(
        `net:${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`,
        shared
      )
    ).toBeNull()
  })

  test('the amended rule: numbers, addresses and public suffixes, case by case', () => {
    expect(net.patterns).toHaveLength(63)
    for (const c of net.patterns) {
      const got = netPattern(c.p, shared)
      if (got !== c.want) throw new Error(`${c.p}: ${got}`)
      if (known(c.p, shared) !== (c.want !== null)) throw new Error(`${c.p} known`)
    }
  })

  test('a host that ends in a number is a plain dotted address, and never under a wildcard', () => {
    for (const p of [
      'net:*.0.0.1',
      'net:*.0x1',
      'net:*.1.0x0',
      'net:127.1',
      'net:0x7f.0.0.1',
      'net:999.1.1.1',
    ]) {
      expect(netPattern(p, shared)).toBeNull()
      expect(netHost(p)).toBeNull()
      expect(known(p, shared)).toBe(false)
      expect(egress(p)).toBe(false)
      expect(risk(p)).toBeNull()
      expect(line(p)).toBeNull()
    }
    expect(netPattern('net:127.0.0.1', shared)).toBe('127.0.0.1')
    expect(summary(['read:messages', 'net:*.0.0.1']).passesOn).toBe(false)
  })

  test('the public suffix rules: plain names, wildcards, their exceptions and names above them', () => {
    for (const host of [
      'com',
      'co.uk',
      'github.io',
      'foo.ck',
      'x.kobe.jp',
      'kobe.jp',
      'ck',
      'unlisted',
      's3.amazonaws.com',
      'amazonaws.com',
    ])
      if (!shared(host)) throw new Error(host)
    for (const host of [
      'example.com',
      'example.co.uk',
      'a.github.io',
      'www.ck',
      'city.kobe.jp',
      'a.unlisted',
      'a.foo.ck',
      'bucket.s3.amazonaws.com',
      'a.amazonaws.com',
      'amazonaws.org',
    ])
      if (shared(host)) throw new Error(host)
    expect(suffixes.rules).toHaveLength(14)
    expect(suffixes.license).toBe('MPL-2.0')
  })

  test('a wildcard over a public suffix is refused when a manifest asks, and still reads as a way out', () => {
    for (const p of ['net:*.co.uk', 'net:*.github.io', 'net:*.kobe.jp', 'net:*.foo.ck']) {
      expect(netPattern(p, shared)).toBeNull()
      expect(known(p, shared)).toBe(false)
      expect(netHost(p)).toBe(p.slice(4))
      expect(egress(p)).toBe(true)
      expect(risk(p)).toBe('H')
    }
    expect(netPattern('net:*.example.co.uk', shared)).toBe('*.example.co.uk')
    expect(netPattern('net:*.co.uk', publicSuffixes([]))).toBe('*.co.uk')
  })

  test('a wildcard over a name with list rules beneath it is refused, as other owners hold them', () => {
    for (const p of ['net:*.amazonaws.com', 'net:*.s3.amazonaws.com']) {
      expect(netPattern(p, shared)).toBeNull()
      expect(known(p, shared)).toBe(false)
      expect(netHost(p)).toBe(p.slice(4))
      expect(egress(p)).toBe(true)
    }
    for (const p of ['net:*.bucket.s3.amazonaws.com', 'net:s3.amazonaws.com', 'net:amazonaws.com'])
      expect(netPattern(p, shared)).toBe(p.slice(4))
    const deep = publicSuffixes(['com', 'jp', '*.compute.amazonaws.com', '*.kobe.jp'])
    for (const host of ['amazonaws.com', 'compute.amazonaws.com', 'kobe.jp'])
      if (!deep(host)) throw new Error(host)
    for (const host of ['example.com', 'compute.example.com', 'a.b.compute.amazonaws.com'])
      if (deep(host)) throw new Error(host)
    expect(netPattern('net:*.amazonaws.com', deep)).toBeNull()
    expect(netPattern('net:*.x.compute.amazonaws.com', deep)).toBeNull()
    expect(netPattern('net:*.a.x.compute.amazonaws.com', deep)).toBe('*.a.x.compute.amazonaws.com')
    const except = publicSuffixes(['jp', '*.kobe.jp', '!city.kobe.jp', 'ward.city.kobe.jp'])
    expect(except('city.kobe.jp')).toBe(true)
    expect(netPattern('net:*.city.kobe.jp', except)).toBeNull()
    expect(netPattern('net:*.city.kobe.jp', shared)).toBe('*.city.kobe.jp')
    expect(netPattern('net:*.amazonaws.com', publicSuffixes(['s3.amazonaws.com']))).toBeNull()
    expect(netPattern('net:*.amazonaws.com', publicSuffixes(['com']))).toBe('*.amazonaws.com')
  })

  test('risk of net patterns and the Full access tier', () => {
    expect(risk('net:*')).toBe('C')
    expect(risk('net:a.example.com')).toBe('H')
    expect(risk('ui:slots')).toBe('L')
    expect(risk('ui:open')).toBe('M')
    expect(risk('page:code')).toBe('F')
    for (const [p, want] of catalog.risks) expect(risk(p)).toBe(want as ReturnType<typeof risk>)
    expect(FULL).toBe(catalog.full)
  })

  test('read:accessibility is medium; ui:sounds and ui:speech are low', () => {
    expect(risk('read:accessibility')).toBe('M')
    expect(risk('ui:sounds')).toBe('L')
    expect(risk('ui:speech')).toBe('L')
  })

  test('a name the catalog does not have is not known and has no risk', () => {
    for (const p of ['read:everything', 'ui:frame', 'net:', 'net:Example.com', '', 'toString']) {
      expect(known(p, shared)).toBe(false)
      expect(risk(p)).toBeNull()
      expect(line(p)).toBeNull()
      expect(reads(p)).toBe(false)
      expect(egress(p)).toBe(false)
    }
    for (const p of ['read:messages', 'page:code', 'net:*', 'net:localhost'])
      expect(known(p, shared)).toBe(true)
  })

  test('reserved names are known to dialogs and not grantable', () => {
    expect(RESERVED['app:frame']).toMatchObject({
      since: '0.9.5',
      risk: 'H',
      reads: true,
      egress: true,
    })
    expect(RESERVED).toEqual(catalog.reserved as typeof RESERVED)
    expect(reserved('app:frame')).toBe(true)
    expect(reserved('scope:profile')).toBe(true)
    expect(reserved('read:messages')).toBe(false)
    expect(known('app:frame', shared)).toBe(false)
    expect(known('scope:profile', shared)).toBe(false)
    expect(RESERVED_REFUSAL).toBe("This plugin asks for a permission this version can't give")
  })
})

describe('install lines', () => {
  test('the lines of the catalog table', () => {
    expect(line('read:profile')).toBe(
      'See your names, avatars and which instances your accounts are on'
    )
    expect(line('read:messages')).toBe(
      'Read messages in places you can see (for encrypted ones, only who sent them and when)'
    )
    expect(line('read:encrypted')).toBe(
      'Read end-to-end encrypted messages and see and hear encrypted calls'
    )
    expect(line('read:accessibility')).toBe(
      'See your accessibility settings, such as text size, contrast, color filters and fonts. This can reveal a disability.'
    )
    expect(line('act:credentials')).toBe(
      'See and make invite passwords, guest links and webhook tokens'
    )
    expect(line('hook:render')).toBe(
      'Change how messages, names and places look (changes are marked)'
    )
    expect(line('hook:internal')).toBe(
      'Change almost any app behavior, except sign-ins, passwords and keys. May break after updates'
    )
    expect(line('ui:slots')).toBe('Add buttons, panels, menu items, commands and settings pages')
    expect(line('ui:motion')).toBe(
      'Add animations and suggest them for parts of the app (only when you turned Animations on)'
    )
    expect(line('ui:sounds')).toBe('Add sound packs and change alert sounds')
    expect(line('ui:speech')).toBe("Read text aloud with your device's voice")
    expect(line('ui:open')).toBe(
      'Open links it chooses in your browser when you click them (asks for each new site)'
    )
    expect(line('hook:api')).toBe(
      'See and change what the app sends to your instances and what they answer (never your sign-ins). A changed request can reach other people.'
    )
    expect(line('media:effects')).toBe('Change your camera, mic or screen before others get it')
    expect(line('signals')).toBe(
      "Exchange data with this plugin on other people's devices. People in those places can see that you use it"
    )
    expect(line('storage:sync')).toBe(
      'Keep a little data on your instances, synced to your devices (the instance can read it)'
    )
    expect(line('files:open')).toBe('Open files you pick')
  })

  test('net lines name the host', () => {
    expect(line('net:api.example.com')).toBe('Send and receive data from api.example.com')
    expect(line('net:*.example.com')).toBe(
      'Send and receive data from *.example.com (also example.com)'
    )
    expect(line('net:*.a.example.co.uk')).toBe(
      'Send and receive data from *.a.example.co.uk (also a.example.co.uk)'
    )
    expect(line('net:*')).toBe('Send and receive data from any website')
  })

  test('Full access has its own dialog and a reserved name its reserved line', () => {
    expect(line('page:code')).toBeNull()
    expect(line('app:frame')).toBe(
      "Show this app's own page in a box. It can read this app's data and pass it on."
    )
    expect(line('scope:profile')).toBeNull()
  })

  test('every line is short plain copy', () => {
    const all = [...Object.values(PERMS).map(p => p.line), SANDBOX_NOTE, FULL_ACCESS_NOTE, CSS_NOTE]
    for (const text of all) {
      expect(text.length).toBeGreaterThan(5)
      expect(text.length).toBeLessThanOrEqual(140)
      if (/[\u2014`]/.test(text) || /rchat/i.test(text)) throw new Error(text)
      // eslint-disable-next-line no-control-regex
      if (/[^\x00-\x7f]/.test(text)) throw new Error(text)
    }
  })

  test('the lines of a request come grouped by risk, critical first', () => {
    const got = lines(['ui:slots', 'hook:render', 'net:api.example.com', 'read:messages', 'net:*'])
    expect(got.map(l => `${l.label} ${l.perm}`)).toEqual([
      'Critical net:*',
      'High net:api.example.com',
      'High read:messages',
      'Med hook:render',
      'Low ui:slots',
    ])
    expect(got[2]).toEqual({
      perm: 'read:messages',
      risk: 'H',
      label: 'High',
      line: 'Read messages in places you can see (for encrypted ones, only who sent them and when)',
    })
    expect(RISK_LABEL).toEqual({ C: 'Critical', H: 'High', M: 'Med', L: 'Low' })
  })

  test('names with no line are left out, and a repeat shows once', () => {
    expect(
      lines(['page:code', 'made:up', 'app:frame', 'ui:theme', 'ui:theme']).map(l => l.perm)
    ).toEqual(['ui:theme'])
  })

  test('the notes of the install dialog', () => {
    expect(SANDBOX_NOTE).toBe(
      "This plugin runs in a sandbox. It can't read your sign-ins, passwords, backup phrases or keys."
    )
    expect(FULL_ACCESS_NOTE).toBe('A plugin with full access is on. It can change these limits.')
    expect(CSS_NOTE).toBe(
      "Its styles can adapt to your accessibility settings. They can't send them anywhere."
    )
  })
})

describe('the summary', () => {
  test('the model cases: a read that meets a way out passes on', () => {
    expect(vectors.summaries).toHaveLength(11)
    for (const c of vectors.summaries) {
      const got = summary(c.perms).passesOn
      if (got !== c.want.passesOn || got !== c.got.passesOn) throw new Error(c.perms.join(' '))
    }
  })

  test('what reads and what passes on, as the model lists them', () => {
    for (const c of catalog.summaries) expect(summary(c.perms)).toEqual(c.got as Summary)
  })

  test('read:accessibility flags the summary with any way out', () => {
    expect(summary(['read:accessibility', 'net:a.example.com']).passesOn).toBe(true)
    expect(summary(['read:accessibility', 'ui:slots']).passesOn).toBe(false)
  })

  test('a plugin and what it depends on are summarized together', () => {
    const own = ['read:messages', 'ui:slots']
    const dependency = ['net:api.example.com']
    expect(summary(own).passesOn).toBe(false)
    expect(summary([...own, ...dependency]).passesOn).toBe(true)
  })
})

describe('the summary line', () => {
  test('a read that meets a way out', () => {
    expect(summaryLine(['read:messages', 'net:api.example.com', 'hook:render', 'ui:slots'])).toBe(
      'Can read your messages, as well as the messages, names and places you see, and pass them on to api.example.com'
    )
    expect(summaryLine(['read:messages', 'net:api.example.com', 'act:send'])).toBe(
      'Can read your messages and pass them on to api.example.com and other people'
    )
    expect(summaryLine(['hook:render', 'signals'])).toBe(
      'Can read the messages, names and places you see, and pass them on to other people'
    )
  })

  test('one thing is "it", several are "them"', () => {
    expect(summaryLine(['media:screen', 'net:*'])).toBe(
      'Can read your screen and pass it on to any website'
    )
    expect(summaryLine(['media:screen', 'clipboard:read', 'signals'])).toBe(
      'Can read your screen and your clipboard, and pass them on to other people'
    )
  })

  test('a list inside a list reads cleanly', () => {
    expect(summaryLine(['act:credentials'])).toBe(
      'Can read invite passwords, guest links and webhook tokens, and pass them on to other people'
    )
    expect(summaryLine(['read:messages', 'act:credentials'])).toBe(
      'Can read invite passwords, guest links and webhook tokens, as well as your messages, and pass them on to other people'
    )
    expect(summaryLine(['media:effects', 'act:calls'])).toBe(
      'Can read your camera, microphone and screen, and pass them on to other people'
    )
    expect(summaryLine(['clipboard:write', 'read:messages', 'read:places'])).toBe(
      'Can read your messages, as well as your servers, channels, DMs, unread counts and what you have open'
    )
    expect(
      summaryLine([
        'read:profile',
        'storage:sync',
        'read:encrypted',
        'hook:incoming',
        'read:messages',
        'net:b.example.com',
        'hook:send',
        'act:social',
        'net:*.a.example.com',
        'ui:open',
      ])
    ).toBe(
      'Can read your encrypted messages and calls; incoming messages, events and alerts; your messages; and your names, avatars and instances, and pass them on to b.example.com, *.a.example.com, your instances, other people and sites it opens'
    )
  })

  test('the corrected forms say no less than the permission', () => {
    expect(summaryLine(['hook:api'])).toBe(
      "Can read the app's requests and their answers, and pass them on to your instances and other people"
    )
    expect(summaryLine(['hook:internal'])).toBe(
      'Can read almost everything in the app and pass it on to other people and your instances'
    )
    expect(summaryLine(['read:profile', 'net:a.example.com'])).toBe(
      'Can read your names, avatars and instances, and pass them on to a.example.com'
    )
    expect(summaryLine(['read:messages', 'ui:open'])).toBe(
      'Can read your messages and pass them on to sites it opens'
    )
    expect(summaryLine(['hook:api', 'hook:internal', 'act:send'])).toBe(
      "Can read the app's requests and their answers, as well as almost everything in the app, and pass them on to your instances and other people"
    )
    expect(summaryLine(['read:messages', 'net:a.example.com', 'net:*'])).toBe(
      'Can read your messages and pass them on to any website'
    )
  })

  test('reads with no way out', () => {
    expect(summaryLine(['read:messages', 'hook:render', 'ui:slots'])).toBe(
      'Can read your messages, as well as the messages, names and places you see'
    )
    expect(summaryLine(['read:messages', 'hook:wasm', 'ui:slots'])).toBe('Can read your messages')
    expect(summaryLine(['read:calls'])).toBe('Can read who is in calls and who is talking')
  })

  test('a plugin that only acts gets a line for what it can change', () => {
    expect(summaryLine(['act:send'])).toBe('Can send, edit and delete your messages, and react')
    expect(summaryLine(['act:account'])).toBe('Can change your profile and status')
    expect(summaryLine(['act:account', 'act:send'])).toBe(
      'Can send, edit and delete your messages, and react, as well as change your profile and status'
    )
    expect(summaryLine(['act:send', 'act:social', 'net:x.example.com'])).toBe(
      'Can send, edit and delete your messages, and react; send friend requests, open DMs and block people for you; and exchange data with x.example.com'
    )
    expect(summaryLine(['act:manage', 'act:p2p'])).toBe(
      'Can use your moderator and manager powers, as well as act as your P2P identities'
    )
    expect(summaryLine(['ui:theme', 'ui:css', 'net:*'])).toBe(
      "Can exchange data with any website, restyle the app and change the app's colors"
    )
    expect(summaryLine(['net:a.example.com', 'net:*.b.example.com'])).toBe(
      'Can exchange data with a.example.com and *.b.example.com'
    )
    expect(summaryLine(['net:a.example.com', 'net:*', 'ui:slots', 'ui:slots'])).toBe(
      'Can exchange data with any website, as well as add buttons, panels, menu items, commands and settings pages'
    )
  })

  test('signals says whose devices the data reaches', () => {
    expect(summaryLine(['signals'])).toBe(
      "Can exchange data with this plugin on other people's devices (they can see that you use it)"
    )
    expect(summaryLine(['signals', 'storage:sync'])).toBe(
      "Can exchange data with this plugin on other people's devices (they can see that you use it), as well as keep data on your instances, synced to your devices (your instances can read it)"
    )
  })

  test('a short form covers its whole install line', () => {
    const want: Record<string, string> = {
      'read:places': 'Can read your servers, channels, DMs, unread counts and what you have open',
      'read:p2p': 'Can read your P2P identities, contacts, servers and messages',
      'hook:render': 'Can read the messages, names and places you see',
      'hook:incoming': 'Can read incoming messages, events and alerts',
      'act:send': 'Can send, edit and delete your messages, and react',
      'act:calls':
        'Can join and leave calls, mute, and turn on your camera, mic or screen once you agree',
      'ui:slots': 'Can add buttons, panels, menu items, commands and settings pages',
      'ui:sounds': 'Can add sound packs and change alert sounds',
      'ui:notify': 'Can show notifications and toasts',
      'ui:motion': 'Can add animations and suggest them for parts of the app',
      signals:
        "Can exchange data with this plugin on other people's devices (they can see that you use it)",
      'storage:sync':
        'Can keep data on your instances, synced to your devices (your instances can read it)',
    }
    for (const [p, text] of Object.entries(want)) expect(summaryLine([p])).toBe(text)
  })

  test('nothing the catalog knows, or Full access, has no line', () => {
    expect(summaryLine([])).toBeNull()
    expect(summaryLine(['made:up', 'app:frame'])).toBeNull()
    expect(summaryLine(['page:code', 'read:messages', 'net:*'])).toBeNull()
    expect(summaryLine(['page:code', 'act:send'])).toBeNull()
  })

  test('every read has a short form, every way out a destination, every other permission a verb', () => {
    for (const [p, t] of Object.entries(PERMS)) {
      if (!!t.reads !== (t.what !== undefined)) throw new Error(`${p} what`)
      if (!!t.egress !== (t.to !== undefined)) throw new Error(`${p} to`)
      if (!t.reads !== (t.can !== undefined)) throw new Error(`${p} can`)
      for (const text of [t.what, t.can, ...(t.to ?? [])])
        if (
          text !== undefined &&
          (text.length < 4 ||
            /[\u2014`.;]/.test(text) ||
            /rchat/i.test(text) ||
            /^[A-Z]/.test(text))
        )
          throw new Error(`${p}: ${text}`)
    }
  })

  test('each permission makes a line of its own', () => {
    for (const [p, t] of Object.entries(PERMS)) {
      if (t.reads) {
        const got = summaryLine([p, 'net:x.example.com'])
        if (
          got === null ||
          !got.startsWith(`Can read ${t.what}`) ||
          !got.endsWith(' on to x.example.com') === !t.egress
        )
          throw new Error(`${p}: ${got}`)
        if (!t.egress && summaryLine([p]) !== `Can read ${t.what}`) throw new Error(p)
      } else if (summaryLine([p]) !== `Can ${t.can}`) throw new Error(`${p}: ${summaryLine([p])}`)
      if (t.to && !summaryLine(['read:messages', p])?.endsWith(` on to ${t.to.join(' and ')}`))
        throw new Error(`${p} to`)
    }
  })
})
