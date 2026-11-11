// Cues: which effect a message or a reaction asks for, and the gate that keeps a storm from
// becoming a light show. Pure; the app supplies the clock. ("Cue", not "trigger": automations
// own that word.)
import { cueSegments } from './md_text'
import type { SeasonId } from './seasons'

export type EffectId =
  | 'confetti'
  | 'balloons'
  | 'trophy'
  | 'fireworks'
  | 'snow'
  | 'hearts'
  | 'rocket'
  // Today's season rain, or a confetti rain when no season is on.
  | 'season_rain'
  | `season:${SeasonId}`

interface Cue {
  effect: EffectId
  // Word sequences, matched on word boundaries after normalizing.
  phrases?: string[]
  // Scripts without spaces: matched as substrings of the normalized text.
  cjk?: string[]
  dmOnly?: true
}

// Order matters only for ties at the same text position.
export const MESSAGE_CUES: readonly Cue[] = [
  {
    effect: 'season:lunar_new_year',
    phrases: [
      'happy lunar new year',
      'happy chinese new year',
      'gong hei fat choy',
      'gong hei fat choi',
      'kung hei fat choi',
      'gong xi fa cai',
      'chuc mung nam moi',
    ],
    cjk: ['恭喜发财', '恭喜發財', '新春快乐', '新春快樂'],
  },
  {
    effect: 'fireworks',
    phrases: [
      'happy new year',
      'feliz ano nuevo',
      'feliz ano novo',
      'bonne annee',
      'frohes neues jahr',
      'frohes neues',
      'felice anno nuovo',
      'gelukkig nieuwjaar',
      'szczesliwego nowego roku',
      'с новым годом',
    ],
    cjk: ['あけましておめでとう', '新年快乐', '新年快樂', '새해 복 많이'],
  },
  {
    effect: 'balloons',
    phrases: [
      'happy birthday',
      'happy bday',
      'happy b day',
      'hbd',
      'feliz cumpleanos',
      'joyeux anniversaire',
      'alles gute zum geburtstag',
      'buon compleanno',
      'feliz aniversario',
      'gefeliciteerd met je verjaardag',
      'wszystkiego najlepszego',
      'с днем рождения',
    ],
    cjk: ['お誕生日おめでとう', '誕生日おめでとう', '生日快乐', '生日快樂', '생일 축하'],
  },
  {
    effect: 'confetti',
    phrases: [
      'congrats',
      'congratulations',
      'congratz',
      'grats',
      'felicidades',
      'felicitations',
      'herzlichen gluckwunsch',
      'gluckwunsch',
      'parabens',
      'complimenti',
      'gefeliciteerd',
      'mazel tov',
      'tada',
    ],
    cjk: ['おめでとう', '恭喜'],
  },
  { effect: 'trophy', phrases: ['gg', 'ggwp', 'gg wp', 'good game', 'well played'] },
  { effect: 'snow', phrases: ['let it snow'] },
  {
    effect: 'rocket',
    phrases: [
      'ship it',
      'shipped it',
      'we shipped',
      'its live',
      'it s live',
      'it is live',
      'to the moon',
    ],
  },
  { effect: 'season_rain', phrases: ['make it rain'] },
  {
    effect: 'hearts',
    phrases: [
      'i love you',
      'love you',
      'ily',
      'te quiero',
      'te amo',
      'je t aime',
      'ich liebe dich',
      'ti amo',
    ],
    cjk: ['愛してる', '我爱你', '我愛你', '사랑해'],
    dmOnly: true,
  },
  { effect: 'season:halloween', phrases: ['happy halloween', 'trick or treat'] },
  {
    effect: 'season:christmas',
    phrases: [
      'merry christmas',
      'merry xmas',
      'happy holidays',
      'feliz navidad',
      'joyeux noel',
      'frohe weihnachten',
      'buon natale',
      'vrolijk kerstfeest',
      'wesolych swiat',
    ],
    cjk: ['メリークリスマス', '圣诞快乐', '聖誕快樂', '메리 크리스마스'],
  },
  { effect: 'season:thanksgiving', phrases: ['happy thanksgiving'] },
  {
    effect: 'season:hanukkah',
    phrases: ['happy hanukkah', 'happy chanukah', 'happy hanukah', 'chag sameach'],
  },
  { effect: 'season:diwali', phrases: ['happy diwali', 'happy deepavali', 'shubh deepavali'] },
  { effect: 'season:holi', phrases: ['happy holi'] },
  { effect: 'season:eid_al_fitr', phrases: ['eid mubarak'] },
  {
    effect: 'season:easter',
    phrases: ['happy easter', 'frohe ostern', 'joyeuses paques', 'felices pascuas', 'buona pasqua'],
  },
  {
    effect: 'season:valentines',
    phrases: ['happy valentines', 'happy valentine s day', 'happy valentines day'],
  },
  {
    effect: 'season:st_patricks',
    phrases: ['happy st patrick s day', 'happy st patricks day', 'happy st paddy s day'],
  },
  { effect: 'season:pi_day', phrases: ['happy pi day'] },
  { effect: 'season:earth_day', phrases: ['happy earth day'] },
  {
    effect: 'season:mid_autumn',
    phrases: ['happy mid autumn', 'happy moon festival'],
    cjk: ['中秋快乐', '中秋快樂'],
  },
]

// A message made only of these (one to three of them, the same effect) triggers it too.
export const EMOJI_CUES: Readonly<Record<string, EffectId>> = {
  '🎉': 'confetti',
  '🥳': 'confetti',
  '🎊': 'confetti',
  '🎂': 'balloons',
  '🎈': 'balloons',
  '🎆': 'fireworks',
  '🎇': 'fireworks',
  '❄️': 'snow',
  '☃️': 'snow',
  '🏆': 'trophy',
  '🚀': 'rocket',
}

// Party reactions: a burst at the chip for the person who adds one and for anyone watching live
// (the approved list's four, plus a few).
export const REACTION_BURSTS: Readonly<Record<string, EffectId>> = {
  '🎉': 'confetti',
  '🥳': 'confetti',
  '🎊': 'confetti',
  '🎂': 'balloons',
  '🎈': 'balloons',
  '🎆': 'fireworks',
  '🏆': 'trophy',
  '🚀': 'rocket',
}

// Reaction counts that burst (with the reacted emoji) for everyone watching when crossed live.
export const ROUND_COUNTS = [10, 25, 50, 100, 250, 500, 1000] as const

export const CUE_TEXT_MAX = 500
const WORDS_MAX = 120

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[’ʼ]/g, "'")

// Words with letter runs collapsed ("happppy" reads as "hapy", so does "happy"), plus each word's
// raw length so a run never makes a shorter word ("g" never reads as "gg").
const words = (s: string) => {
  const raw = fold(s).match(/[\p{L}\p{N}]+/gu) ?? []
  return raw.slice(0, WORDS_MAX).map(w => ({ skel: w.replace(/(.)\1+/gu, '$1'), len: w.length }))
}

interface Compiled {
  effect: EffectId
  dmOnly: boolean
  seq: { skel: string; len: number }[]
}

// Phrases indexed by their first word, in cue order, so a scan is one lookup per word.
const BY_FIRST = new Map<string, Compiled[]>()
for (const t of MESSAGE_CUES)
  for (const p of t.phrases ?? []) {
    const seq = words(p)
    const list = BY_FIRST.get(seq[0].skel) ?? []
    list.push({ effect: t.effect, dmOnly: t.dmOnly === true, seq })
    BY_FIRST.set(seq[0].skel, list)
  }
const CJK = MESSAGE_CUES.flatMap(t =>
  (t.cjk ?? []).map(c => ({ effect: t.effect, dmOnly: t.dmOnly === true, text: fold(c) }))
)

// Emoji keys without the variation selector, so "❄" and "❄️" read the same.
const bare = (s: string) => s.replace(/\ufe0f/g, '')
const bareMap = (r: Readonly<Record<string, EffectId>>) =>
  new Map(Object.entries(r).map(([k, v]) => [bare(k), v]))
const EMOJI_BARE = bareMap(EMOJI_CUES)
const REACTION_BARE = bareMap(REACTION_BURSTS)

const isEmojiOnly = (text: string): EffectId | null => {
  const t = text.trim()
  if (!t || t.length > 40) return null
  const seg = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)]
    .map(s => s.segment)
    .filter(s => s.trim())
  if (!seg.length || seg.length > 3) return null
  const hits = seg.map(s => EMOJI_BARE.get(bare(s)) ?? null)
  return hits.every(h => h && h === hits[0]) ? hits[0] : null
}

export interface MessageMatch {
  effect: EffectId
  // Where in the text it matched (the earliest hit wins).
  at: number
}

// The earliest phrase in `text` (ties in cue order), its position counted in words from
// `offset`.
const findIn = (text: string, dm: boolean, offset: number): MessageMatch | null => {
  const ws = words(text)
  let best: MessageMatch | null = null
  for (let i = 0; i < ws.length && !best; i++)
    for (const c of BY_FIRST.get(ws[i].skel) ?? []) {
      if (c.dmOnly && !dm) continue
      if (i + c.seq.length > ws.length) continue
      if (c.seq.every((p, j) => ws[i + j].skel === p.skel && ws[i + j].len >= p.len)) {
        best = { effect: c.effect, at: offset + i }
        break
      }
    }
  const flat = fold(text)
  for (const c of CJK) {
    if (c.dmOnly && !dm) continue
    const idx = flat.indexOf(c.text)
    if (idx < 0) continue
    const at = offset + (flat.slice(0, idx).match(/[\p{L}\p{N}]+/gu) ?? []).length
    if (!best || at < best.at) best = { effect: c.effect, at }
  }
  return best
}

const EMOJI_KEYS = [...EMOJI_BARE.keys()]

// A cheap first look at the raw text: most messages hold no phrase and no cue emoji, and skip
// the markdown parse entirely.
const mightCue = (raw: string, dm: boolean) =>
  findIn(raw, dm, 0) !== null || EMOJI_KEYS.some(e => raw.includes(e))

export function matchMessage(markdown: string, dm: boolean): MessageMatch | null {
  if (markdown.length > CUE_TEXT_MAX || !mightCue(markdown, dm)) return null
  const segments = cueSegments(markdown)
  if (segments.length === 1) {
    const emoji = isEmojiOnly(segments[0])
    if (emoji) return { effect: emoji, at: 0 }
  }
  let offset = 0
  for (const seg of segments) {
    const hit = findIn(seg, dm, offset)
    if (hit) return hit
    offset += words(seg).length
  }
  return null
}

// One live message, as the app sees it when it arrives.
export interface MessageEvent {
  id: string
  scope: string
  text: string
  dm: boolean
  // Arrived live for the view on screen, the page visible. Instance: the WS `message` event.
  // P2P: see `p2pLive`. History loads, jumps, edits, resyncs and catch-up are never live.
  live: boolean
  kind: 'user' | 'system' | 'webhook' | 'bot' | 'automation'
  blocked: boolean
  // The place allows fun effects (server switch on, or a DM).
  placeOn: boolean
}

export interface Gate {
  allow(scope: string, key: string, now: number): boolean
}

// At most one effect per scope every `scopeMs`, one anywhere every `globalMs`, and each key
// (a message id, or message id + count) once; keys are remembered up to `keysMax`, oldest out.
export function createGate(scopeMs: number, globalMs: number, keysMax = 2000): Gate {
  const lastScope = new Map<string, number>()
  const keys = new Set<string>()
  let lastAny = -Infinity
  return {
    allow(scope, key, now) {
      if (keys.has(key)) return false
      keys.add(key)
      if (keys.size > keysMax) keys.delete(keys.values().next().value as string)
      if (now - lastAny < globalMs) return false
      if (now - (lastScope.get(scope) ?? -Infinity) < scopeMs) return false
      lastAny = now
      lastScope.set(scope, now)
      if (lastScope.size > 500) lastScope.delete(lastScope.keys().next().value as string)
      return true
    },
  }
}

export const MESSAGE_GATE = { scopeMs: 10_000, globalMs: 4_000 }

// P2P has no "live" mark: an event counts as live when it came in a push frame (not
// a sync or history reply) while its room or DM was open, and its own timestamp is within 60 s
// of when it arrived (a peer reconnecting after an hour pushes old events).
export const P2P_LIVE_SKEW_MS = 60_000
export const p2pLive = (
  via: 'push' | 'sync' | 'history',
  open: boolean,
  sentAt: number,
  arrivedAt: number
) => via === 'push' && open && Math.abs(arrivedAt - sentAt) <= P2P_LIVE_SKEW_MS
export const REACTION_GATE = { scopeMs: 3_000, globalMs: 1_500 }

// Replaying a message's effect from its menu: the user asked, so no gate.
export const replayEffect = (markdown: string, dm: boolean): EffectId | null =>
  matchMessage(markdown, dm)?.effect ?? null

export function decideMessage(ev: MessageEvent, gate: Gate, now: number): EffectId | null {
  if (!ev.live || !ev.placeOn || ev.blocked || ev.kind !== 'user') return null
  const hit = matchMessage(ev.text, ev.dm)
  if (!hit) return null
  return gate.allow(ev.scope, `m:${ev.id}`, now) ? hit.effect : null
}

export interface ReactionEvent {
  messageId: string
  scope: string
  emoji: string
  // Who reacted (a username, or a P2P identity key).
  reactor: string
  // The count after the change, when the server or peer sent one.
  count: number | null
  previous: number | null
  added: boolean
  mine: boolean
  // The reactor is someone I blocked, or an automation reacted.
  reactorBlocked: boolean
  byAutomation: boolean
  // The message is on screen in the shown view and the page is visible.
  onScreen: boolean
  placeOn: boolean
}

export type ReactionEffect =
  { kind: 'burst'; effect: EffectId } | { kind: 'round'; emoji: string; count: number }

// A party reaction bursts at its chip for the reactor (they just clicked it) and for everyone
// who has the message on screen when it arrives live. A count crossing a round number upward
// bursts the reacted emoji for watchers, once per crossing; it wins over a party burst.
export function decideReaction(ev: ReactionEvent, gate: Gate, now: number): ReactionEffect | null {
  if (!ev.added || !ev.placeOn || !ev.onScreen) return null
  if (!ev.mine && (ev.reactorBlocked || ev.byAutomation)) return null
  if (!ev.mine && ev.count !== null && ev.previous !== null) {
    const crossed = ROUND_COUNTS.filter(n => ev.previous! < n && ev.count! >= n).pop()
    if (crossed !== undefined)
      return gate.allow(ev.scope, `r:${ev.messageId}:${ev.emoji}:${crossed}`, now)
        ? { kind: 'round', emoji: ev.emoji, count: crossed }
        : null
  }
  const effect = REACTION_BARE.get(bare(ev.emoji))
  if (!effect) return null
  const key = ev.mine
    ? `r:${ev.messageId}:${ev.emoji}:mine:${now}`
    : `r:${ev.messageId}:${ev.emoji}:${ev.reactor}`
  return gate.allow(ev.scope, key, now) ? { kind: 'burst', effect } : null
}
