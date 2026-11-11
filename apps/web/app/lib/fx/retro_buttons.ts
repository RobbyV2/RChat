// Web buttons: 88x31 retro badges on profile cards and server about panels, derived on the
// device from data the viewer is already shown. Nothing is stored or sent. Named "web buttons"
// in copy and `RetroButton` in code: "badge" is the P2P account badge and app-icon badges, and
// "button" alone is every ordinary button.
//
// Rules:
// - Only celebratory and historical facts. Never security or identity facts (encryption, P2P,
//   verification, account confirmation, roles, staff, the site admin): those keep their own
//   indicators, and a button never sits in their row.
// - Only fixed words and numbers, so a button never carries user text (nothing to mask or
//   reveal), and the site-admin flag is never an input.
// - Drawn as DOM text (Silkscreen through CSS), not images, at least 88x31 and growing with
//   the text under text-only zoom.

export const RETRO_MIN_W = 88
export const RETRO_MIN_H = 31

// The 16 VGA colors, by index.
export const VGA = [
  '#000000',
  '#800000',
  '#008000',
  '#808000',
  '#000080',
  '#800080',
  '#008080',
  '#c0c0c0',
  '#808080',
  '#ff0000',
  '#00ff00',
  '#ffff00',
  '#0000ff',
  '#ff00ff',
  '#00ffff',
  '#ffffff',
] as const

export type ButtonStyle = 'bevel' | 'flat' | 'split'

export interface RetroButton {
  id: string
  line1: string
  line2: string | null
  emblem: string | null
  bg: number
  fg: number
  style: ButtonStyle
}

export interface ProfileFacts {
  createdAt: number
  now: number
  // In a server's context: when this member joined.
  member?: { joinedAt: number }
  // An instance friend of the viewer's account, or a P2P contact of the viewer's identity.
  friend?: boolean
  contact?: boolean
}

export interface ServerFacts {
  createdAt: number
  now: number
  members: number
}

// Dates are compared in the viewer's local calendar (the app passes local offsets; tests UTC).
const ymd = (s: number, offsetMin: number) => {
  const d = new Date((s + offsetMin * 60) * 1000)
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }
}
// The yearly day of `from` (29 February counts on 28 February in other years).
const anniversary = (from: number, now: number, off: number) => {
  const a = ymd(from, off)
  const b = ymd(now, off)
  if (b.y <= a.y) return 0
  const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const day = a.m === 2 && a.d === 29 && !leap(b.y) ? 28 : a.d
  return a.m === b.m && day === b.d ? b.y - a.y : 0
}
const count = (n: number) => (n >= 10_000 ? `${Math.floor(n / 1000)}K` : n.toLocaleString('en-US'))
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export function profileRetroButtons(f: ProfileFacts, offsetMin = 0): RetroButton[] {
  const out: RetroButton[] = [
    {
      id: 'since',
      line1: 'SINCE',
      line2: String(ymd(f.createdAt, offsetMin).y),
      emblem: '🕰️',
      bg: 4,
      fg: 15,
      style: 'split',
    },
  ]
  const years = anniversary(f.createdAt, f.now, offsetMin)
  if (years > 0)
    out.push({
      id: 'cake',
      line1: `${years} ${plural(years, 'YEAR', 'YEARS')}`,
      line2: 'TODAY',
      emblem: '🎂',
      bg: 11,
      fg: 0,
      style: 'bevel',
    })
  if (f.member)
    out.push({
      id: 'member',
      line1: 'MEMBER',
      line2: String(ymd(f.member.joinedAt, offsetMin).y),
      emblem: '🏠',
      bg: 6,
      fg: 15,
      style: 'split',
    })
  if (f.friend)
    out.push({
      id: 'friend',
      line1: 'FRIEND',
      line2: null,
      emblem: '🤝',
      bg: 2,
      fg: 15,
      style: 'bevel',
    })
  if (f.contact)
    out.push({
      id: 'contact',
      line1: 'CONTACT',
      line2: null,
      emblem: '📇',
      bg: 5,
      fg: 15,
      style: 'bevel',
    })
  return out
}

export function serverRetroButtons(f: ServerFacts, offsetMin = 0): RetroButton[] {
  const out: RetroButton[] = [
    {
      id: 'est',
      line1: 'EST.',
      line2: String(ymd(f.createdAt, offsetMin).y),
      emblem: '🏛️',
      bg: 4,
      fg: 15,
      style: 'split',
    },
    {
      id: 'members',
      line1: count(f.members),
      line2: plural(f.members, 'MEMBER', 'MEMBERS'),
      emblem: null,
      bg: 0,
      fg: 10,
      style: 'flat',
    },
  ]
  if (anniversary(f.createdAt, f.now, offsetMin) > 0)
    out.push({
      id: 'cake',
      line1: 'BIRTHDAY',
      line2: 'TODAY',
      emblem: '🎂',
      bg: 11,
      fg: 0,
      style: 'bevel',
    })
  out.push({
    id: 'any',
    line1: 'BEST VIEWED',
    line2: 'ANYWHERE',
    emblem: null,
    bg: 7,
    fg: 0,
    style: 'bevel',
  })
  return out
}

// The accessible name: the button's text as words.
export const retroButtonLabel = (b: Pick<RetroButton, 'line1' | 'line2'>) =>
  [b.line1, b.line2]
    .filter(Boolean)
    .join(' ')
    .replace(/\bEST\./, 'Established')
    .toLowerCase()
    .replace(/^./, c => c.toUpperCase())

// Words a web button may never use, so a later "make your own" design can reserve them too.
export const SECURITY_WORDS = [
  'encrypt',
  'e2e',
  'secure',
  'private',
  'verified',
  'verify',
  'confirmed',
  'official',
  'admin',
  'mod',
  'moderator',
  'staff',
  'operator',
  'owner',
  'founder',
  'creator',
  'p2p',
  'peer',
  'trusted',
  'safe',
]
export const SECURITY_EMBLEMS = ['🔒', '🔐', '🔏', '🔑', '🛡️', '✅', '☑️', '✔️', '🛰️', '👑', '⭐']
