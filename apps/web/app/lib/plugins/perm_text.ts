export type Risk = 'L' | 'M' | 'H' | 'C'

// `reads`: it lets the plugin see data. `egress`: it can pass data the plugin holds to someone
// else. `line` is what the dialog says and never says less than the permission allows. For the
// summary, `what` names what a reading permission sees (`many` when it takes "them"), `to`
// where a passing one can send it, and `can` what a permission that reads nothing lets it do.
export interface PermText {
  risk: Risk
  reads?: true
  egress?: true
  line: string
  what?: string
  many?: true
  to?: readonly string[]
  can?: string
}

const PEOPLE = 'other people'
const INSTANCES = 'your instances'
const MESSAGES = 'your messages'

export const PERMS: Record<string, PermText> = {
  'read:profile': {
    risk: 'L',
    reads: true,
    line: 'See your names, avatars and which instances your accounts are on',
    what: 'your names, avatars and instances',
    many: true,
  },
  'read:settings': {
    risk: 'L',
    reads: true,
    line: 'See your app settings (the listed ones: look, layout, emoji, palette, calls; never relays, privacy or saved passwords)',
    what: 'your app settings',
    many: true,
  },
  'read:places': {
    risk: 'M',
    reads: true,
    line: 'See your servers, channels, DMs, unread counts and what you have open',
    what: 'your servers, channels, DMs, unread counts and what you have open',
    many: true,
  },
  'read:people': {
    risk: 'M',
    reads: true,
    line: 'See members, friends, profiles and who is online',
    what: 'members, friends, profiles and who is online',
    many: true,
  },
  'read:calls': {
    risk: 'M',
    reads: true,
    line: 'See who is in calls and who is talking',
    what: 'who is in calls and who is talking',
    many: true,
  },
  'read:command_log': {
    risk: 'M',
    reads: true,
    line: 'Read your command log',
    what: 'your command log',
  },
  'read:accessibility': {
    risk: 'M',
    reads: true,
    line: 'See your accessibility settings, such as text size, contrast, color filters and fonts. This can reveal a disability.',
    what: 'your accessibility settings',
    many: true,
  },
  'read:messages': {
    risk: 'H',
    reads: true,
    line: 'Read messages in places you can see (for encrypted ones, only who sent them and when)',
    what: MESSAGES,
    many: true,
  },
  'read:p2p': {
    risk: 'H',
    reads: true,
    line: 'See your P2P identities, contacts, servers and messages',
    what: 'your P2P identities, contacts, servers and messages',
    many: true,
  },
  'read:encrypted': {
    risk: 'C',
    reads: true,
    line: 'Read end-to-end encrypted messages and see and hear encrypted calls',
    what: 'your encrypted messages and calls',
    many: true,
  },
  'act:navigate': { risk: 'L', line: 'Open places and panels', can: 'open places and panels' },
  'act:settings': {
    risk: 'M',
    line: 'Change your app settings (the listed ones; never relays, privacy or saved passwords)',
    can: 'change your app settings',
  },
  'act:account': {
    risk: 'M',
    egress: true,
    line: 'Change your profile and status',
    to: [PEOPLE],
    can: 'change your profile and status',
  },
  'act:calls': {
    risk: 'M',
    line: 'Join and leave calls, and mute (turning on camera, mic or screen needs your click and asks you first)',
    can: 'join and leave calls, mute, and turn on your camera, mic or screen once you agree',
  },
  'act:report': {
    risk: 'M',
    egress: true,
    line: 'Send reports for you',
    to: ['moderators'],
    can: 'send reports for you',
  },
  'act:send': {
    risk: 'H',
    egress: true,
    line: 'Send, edit and delete your messages, and react',
    to: [PEOPLE],
    can: 'send, edit and delete your messages, and react',
  },
  'act:social': {
    risk: 'H',
    egress: true,
    line: 'Send friend requests, open DMs and block people',
    to: [PEOPLE],
    can: 'send friend requests, open DMs and block people for you',
  },
  'act:manage': {
    risk: 'H',
    egress: true,
    line: 'Use your moderator and manager powers',
    to: [PEOPLE],
    can: 'use your moderator and manager powers',
  },
  'act:p2p': {
    risk: 'H',
    egress: true,
    line: 'Act as your P2P identities',
    to: [PEOPLE],
    can: 'act as your P2P identities',
  },
  'act:credentials': {
    risk: 'C',
    reads: true,
    egress: true,
    line: 'See and make invite passwords, guest links and webhook tokens',
    what: 'invite passwords, guest links and webhook tokens',
    many: true,
    to: [PEOPLE],
  },
  'hook:render': {
    risk: 'M',
    reads: true,
    line: 'Change how messages, names and places look (changes are marked)',
    what: 'the messages, names and places you see',
    many: true,
  },
  'hook:wasm': {
    risk: 'M',
    reads: true,
    line: "Change the app's built-in filters",
    what: MESSAGES,
    many: true,
  },
  'hook:send': {
    risk: 'H',
    reads: true,
    egress: true,
    line: 'See and change your messages before they are sent, or stop them',
    what: MESSAGES,
    many: true,
    to: [PEOPLE],
  },
  'hook:incoming': {
    risk: 'H',
    reads: true,
    line: 'Hide or change messages, events and alerts before you see them (changes are marked)',
    what: 'incoming messages, events and alerts',
    many: true,
  },
  'hook:store': {
    risk: 'H',
    reads: true,
    egress: true,
    line: 'Change what app actions do (a changed status or reaction reaches other people)',
    what: 'what you do in the app',
    to: [PEOPLE],
  },
  'hook:p2p': {
    risk: 'H',
    reads: true,
    line: 'See the P2P traffic of your identities',
    what: 'your P2P traffic',
  },
  'hook:api': {
    risk: 'C',
    reads: true,
    egress: true,
    line: 'See and change what the app sends to your instances and what they answer (never your sign-ins). A changed request can reach other people.',
    what: "the app's requests and their answers",
    many: true,
    to: [INSTANCES, PEOPLE],
  },
  'hook:internal': {
    risk: 'C',
    reads: true,
    egress: true,
    line: 'Change almost any app behavior, except sign-ins, passwords and keys. May break after updates',
    what: 'almost everything in the app',
    to: [PEOPLE, INSTANCES],
  },
  'ui:slots': {
    risk: 'L',
    line: 'Add buttons, panels, menu items, commands and settings pages',
    can: 'add buttons, panels, menu items, commands and settings pages',
  },
  'ui:theme': { risk: 'L', line: "Change the app's colors", can: "change the app's colors" },
  'ui:motion': {
    risk: 'L',
    line: 'Add animations and suggest them for parts of the app (only when you turned Animations on)',
    can: 'add animations and suggest them for parts of the app',
  },
  'ui:sounds': {
    risk: 'L',
    line: 'Add sound packs and change alert sounds',
    can: 'add sound packs and change alert sounds',
  },
  'ui:speech': {
    risk: 'L',
    line: "Read text aloud with your device's voice",
    can: 'read text aloud',
  },
  'ui:notify': {
    risk: 'L',
    line: 'Show notifications and toasts',
    can: 'show notifications and toasts',
  },
  'ui:components': {
    risk: 'M',
    reads: true,
    line: 'Change or replace message rows, member rows, channel rows, profile cards and headers',
    what: 'what is on screen',
  },
  'ui:css': { risk: 'M', line: 'Restyle the app', can: 'restyle the app' },
  'ui:open': {
    risk: 'M',
    egress: true,
    line: 'Open links it chooses in your browser when you click them (asks for each new site)',
    to: ['sites it opens'],
    can: 'open links it chooses',
  },
  'media:screen': {
    risk: 'H',
    reads: true,
    line: 'See your screen while you share it',
    what: 'your screen',
  },
  'media:camera': {
    risk: 'H',
    reads: true,
    line: 'See your camera while it is on in a call',
    what: 'your camera',
  },
  'media:mic': {
    risk: 'H',
    reads: true,
    line: 'Hear your microphone while it is on in a call',
    what: 'your microphone',
  },
  'media:effects': {
    risk: 'H',
    reads: true,
    egress: true,
    line: 'Change your camera, mic or screen before others get it',
    what: 'your camera, microphone and screen',
    many: true,
    to: [PEOPLE],
  },
  'media:remote': {
    risk: 'C',
    reads: true,
    line: 'See and hear what others share with you in calls',
    what: 'what others share in calls',
  },
  signals: {
    risk: 'M',
    egress: true,
    line: "Exchange data with this plugin on other people's devices. People in those places can see that you use it",
    to: [PEOPLE],
    can: "exchange data with this plugin on other people's devices (they can see that you use it)",
  },
  'storage:sync': {
    risk: 'L',
    egress: true,
    line: 'Keep a little data on your instances, synced to your devices (the instance can read it)',
    to: [INSTANCES],
    can: 'keep data on your instances, synced to your devices (your instances can read it)',
  },
  'clipboard:write': {
    risk: 'L',
    line: 'Copy text to your clipboard',
    can: 'copy text to your clipboard',
  },
  'clipboard:read': {
    risk: 'H',
    reads: true,
    line: 'Read your clipboard when you click it',
    what: 'your clipboard',
  },
  'files:save': {
    risk: 'L',
    line: 'Save files where you choose',
    can: 'save files where you choose',
  },
  'files:open': {
    risk: 'L',
    reads: true,
    line: 'Open files you pick',
    what: 'files you pick',
    many: true,
  },
}

// The Full access tier. It is not a catalog entry and its own dialog replaces the list.
export const FULL = 'page:code'

// Names that manifests and dialogs know but no version grants yet.
export const RESERVED: Record<
  string,
  { since: string; risk: Risk; reads?: true; egress?: true; line?: string }
> = {
  'app:frame': {
    since: '0.9.5',
    risk: 'H',
    reads: true,
    egress: true,
    line: "Show this app's own page in a box. It can read this app's data and pass it on.",
  },
}
export const RESERVED_GROUPS = ['scope:']
export const RESERVED_REFUSAL = "This plugin asks for a permission this version can't give"

export const SANDBOX_NOTE =
  "This plugin runs in a sandbox. It can't read your sign-ins, passwords, backup phrases or keys."
export const FULL_ACCESS_NOTE = 'A plugin with full access is on. It can change these limits.'
export const CSS_NOTE =
  "Its styles can adapt to your accessibility settings. They can't send them anywhere."

export const RISK_LABEL: Record<Risk, string> = { C: 'Critical', H: 'High', M: 'Med', L: 'Low' }

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
// A label the URL parser reads as a number: digits, or `0x` and hexadecimal digits.
const NUMBER = /^(\d+|0x[0-9a-f]*)$/
const BYTE = /^(0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/

// Tells whether a wildcard over a host would reach names that unrelated owners hold: the host
// is a public suffix, the name a `*.name` rule of the Public Suffix List stands under, or a
// name with a rule of the list beneath it (`amazonaws.com`, above `s3.amazonaws.com`). The
// rules are the list's own: plain names, `*.name` and `!name`.
export const publicSuffixes = (rules: readonly string[]): ((host: string) => boolean) => {
  const plain = new Set(rules.filter(r => !r.startsWith('*.') && !r.startsWith('!')))
  const under = new Set(rules.filter(r => r.startsWith('*.')).map(r => r.slice(2)))
  const except = new Set(rules.filter(r => r.startsWith('!')).map(r => r.slice(1)))
  const above = new Set<string>()
  for (const rule of plain)
    for (let dot = rule.indexOf('.'); dot >= 0; dot = rule.indexOf('.', dot + 1))
      above.add(rule.slice(dot + 1))
  for (const name of under) {
    above.add(name)
    for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1))
      above.add(name.slice(dot + 1))
  }
  return host => {
    const dot = host.indexOf('.')
    if (dot < 0 || above.has(host)) return true
    if (except.has(host)) return false
    return plain.has(host) || under.has(host.slice(dot + 1))
  }
}

// The host pattern of a `net:` permission as it is written: `*`, `*.<host>` or `<host>`, where
// a host is a lowercase DNS name, `localhost` or a dotted IPv4 address. Anything else is null.
// A host that ends in a number is an address in its one plain spelling or nothing, and never
// stands under a wildcard, so no pattern covers an address it does not show.
export const netHost = (p: string): string | null => {
  if (!p.startsWith('net:')) return null
  const h = p.slice(4)
  if (h === '*') return h
  const host = h.startsWith('*.') ? h.slice(2) : h
  if (host.length > 253) return null
  const labels = host.split('.')
  if (!labels.every(l => LABEL.test(l))) return null
  if (labels.length === 1 && host !== 'localhost') return null
  if (NUMBER.test(labels[labels.length - 1]))
    return host === h && labels.length === 4 && labels.every(l => BYTE.test(l)) ? h : null
  return h
}

// What a manifest may ask for: a pattern as above, and no wildcard over a name `shared` (from
// `publicSuffixes`) gives to unrelated owners.
export const netPattern = (p: string, shared: (host: string) => boolean): string | null => {
  const h = netHost(p)
  return h !== null && h.startsWith('*.') && shared(h.slice(2)) ? null : h
}

// Does a granted host pattern cover a requested one? `*.example.com` also covers `example.com`.
export const netCovers = (granted: string, requested: string): boolean => {
  if (granted === '*') return true
  if (requested === '*') return false
  if (!granted.startsWith('*.')) return granted === requested
  const base = granted.slice(2)
  const host = requested.startsWith('*.') ? requested.slice(2) : requested
  return host === base || host.endsWith('.' + base)
}

export const reserved = (p: string) =>
  has(RESERVED, p) || RESERVED_GROUPS.some(g => p.startsWith(g))

export const known = (p: string, shared: (host: string) => boolean) =>
  has(PERMS, p) || p === FULL || netPattern(p, shared) !== null

// `F` is the Full access tier; null is a name the catalog doesn't have.
export const risk = (p: string): Risk | 'F' | null =>
  p === FULL ? 'F' : p === 'net:*' ? 'C' : netHost(p) ? 'H' : has(PERMS, p) ? PERMS[p].risk : null

export const reads = (p: string) => has(PERMS, p) && PERMS[p].reads === true
export const egress = (p: string) =>
  netHost(p) !== null || (has(PERMS, p) && PERMS[p].egress === true)

export const line = (p: string): string | null => {
  const host = netHost(p)
  if (host === '*') return 'Send and receive data from any website'
  if (host !== null && host.startsWith('*.'))
    return `Send and receive data from ${host} (also ${host.slice(2)})`
  if (host !== null) return `Send and receive data from ${host}`
  if (has(PERMS, p)) return PERMS[p].line
  return has(RESERVED, p) ? (RESERVED[p].line ?? null) : null
}

const ORDER: Risk[] = ['C', 'H', 'M', 'L']

export interface PermLine {
  perm: string
  risk: Risk
  label: string
  line: string
}

// The lines of a request, grouped by risk with the riskiest first. A name with no line is left
// out, so a manifest that holds one is refused before this is shown (RESERVED_REFUSAL).
export const lines = (perms: readonly string[]): PermLine[] => {
  const out: PermLine[] = []
  for (const level of ORDER)
    for (const perm of new Set(perms)) {
      const text = line(perm)
      if (risk(perm) === level && text !== null)
        out.push({ perm, risk: level, label: RISK_LABEL[level], line: text })
    }
  return out
}
