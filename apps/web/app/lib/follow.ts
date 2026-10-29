export const BOTTOM_SLACK = 60
export const INTENT_MS = 1000

export interface Metrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export interface Follow {
  following: boolean
  top: number
}

export const FOLLOWING: Follow = { following: true, top: 0 }

export const nearBottom = (m: Metrics) =>
  m.scrollHeight - m.scrollTop - m.clientHeight < BOTTOM_SLACK

export const userScrolling = (touching: boolean, lastInput: number, now: number) =>
  touching || now - lastInput < INTENT_MS

export const placed = (m: Metrics, detached: boolean): Follow => ({
  following: !detached && nearBottom(m),
  top: m.scrollTop,
})

export const scrolled = (s: Follow, m: Metrics, user: boolean, detached: boolean): Follow => {
  const following = detached
    ? false
    : nearBottom(m)
      ? true
      : user && m.scrollTop < s.top
        ? false
        : s.following
  return following === s.following && m.scrollTop === s.top ? s : { following, top: m.scrollTop }
}

const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

export const upKey = (key: string, shift: boolean) => UP_KEYS.has(key) || (key === ' ' && shift)

export interface Pill {
  scope: string | null
  ready: string | null
  left: number | null
}

export type PillEvent =
  | { kind: 'scope'; scope: string | null }
  | { kind: 'ready'; scope: string }
  | { kind: 'follow'; scope: string; following: boolean; lastId: number }
  | { kind: 'bottom' }

export const pillStep = (s: Pill, e: PillEvent): Pill => {
  switch (e.kind) {
    case 'scope':
      return s.scope === e.scope ? s : { scope: e.scope, ready: null, left: null }
    case 'ready':
      return s.scope !== e.scope || s.ready === e.scope ? s : { ...s, ready: e.scope }
    case 'follow': {
      if (s.scope !== e.scope) return s
      const left = e.following ? null : e.lastId
      return left === s.left ? s : { ...s, left }
    }
    case 'bottom':
      return s.left === null ? s : { ...s, left: null }
  }
}

const POPOVER = '[role="dialog"], [role="listbox"], [role="menu"], [data-popover]'
export const EDITABLE = 'input, textarea, select, [contenteditable]'

export interface EscapeLike {
  defaultPrevented: boolean
  target: unknown
}

const within = (t: unknown, selector: string) =>
  typeof t === 'object' &&
  t !== null &&
  'closest' in t &&
  typeof t.closest === 'function' &&
  t.closest(selector) !== null

export const escapeMarksRead = (e: EscapeLike) => {
  if (e.defaultPrevented) return false
  return !within(e.target, EDITABLE) && !within(e.target, POPOVER)
}
