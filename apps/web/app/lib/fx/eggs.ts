// Easter-egg inputs. Pure; the app passes keys, focus and the clock.

// Palette eggs (`Action.egg`): unlisted, run only by their exact phrase. Party mode, Make it rain
// and Let it snow are listed commands, not eggs.
export const EGG_PHRASES: Readonly<Record<string, readonly string[]>> = {
  barrel_roll: ['do a barrel roll'],
  tilt: ['askew', 'tilt'],
  flip: ['flip'],
  digital_rain: ['follow the white rabbit'],
  sandwich: ['sudo make me a sandwich'],
  credits: ['credits'],
  y1999: ['1999'],
  konami: ['up up down down left right left right b a'],
}

export const normalizePhrase = (q: string) =>
  q
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

// The palette's modes: plain commands (no prefix or `>`) and the others (`#`, `@`, `*`, `/`,
// `$`, `?`, `!`, message search).
export type PaletteMode = 'commands' | 'other'

// The egg Enter runs, or null: only in command mode, only on an exact phrase, and never when a
// listed action's title equals the query too (that action wins).
export function eggFor(query: string, mode: PaletteMode, listedTitles: readonly string[]) {
  if (mode !== 'commands') return null
  const q = normalizePhrase(query)
  if (!q || listedTitles.some(t => normalizePhrase(t) === q)) return null
  for (const [id, phrases] of Object.entries(EGG_PHRASES)) if (phrases.includes(q)) return id
  return null
}

// Where keyboard focus is: the page itself, a plain element (a button, a message row), a
// composite widget that uses arrow keys (tree, menu, listbox, grid, tablist, slider, radio
// group), or text entry (input, textarea, contenteditable, combobox).
export type FocusKind = 'body' | 'plain' | 'composite' | 'text'

const KONAMI = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'b',
  'a',
]

// Counts the sequence only while focus is on the page or a plain element; the last
// ten keys must be the code, with no gap over 2 s between them.
export function createKonami(idleMs = 2000) {
  let keys: string[] = []
  let last = -Infinity
  return (key: string, focus: FocusKind, now: number): boolean => {
    if (focus === 'composite' || focus === 'text') {
      keys = []
      return false
    }
    if (now - last > idleMs) keys = []
    last = now
    keys.push(key.length === 1 ? key.toLowerCase() : key)
    if (keys.length > KONAMI.length) keys.shift()
    if (keys.length === KONAMI.length && keys.every((k, i) => k === KONAMI[i])) {
      keys = []
      return true
    }
    return false
  }
}

// n clicks within the window (7 on the rail logo in 3 s; 5 on your avatar in 2 s).
export function createClicks(n: number, windowMs: number) {
  const times: number[] = []
  return (now: number): boolean => {
    times.push(now)
    while (times.length && now - times[0] > windowMs) times.shift()
    if (times.length >= n) {
      times.length = 0
      return true
    }
    return false
  }
}
