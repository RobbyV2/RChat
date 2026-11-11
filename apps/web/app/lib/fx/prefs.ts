// An account's fun effects settings on this device (`fx` through `writeLocal`), versioned and
// parsed field by field. Pure.
import type { MotionChoice } from './gate'
import { SEASON_IDS, hemisphereOf, type Hemisphere, type SeasonId } from './seasons'

export interface FxPrefs {
  v: 2
  on: boolean
  motion: MotionChoice
  seasons: boolean
  seasonOff: SeasonId[]
  hemisphere: 'auto' | Hemisphere
  reactions: boolean
  messages: boolean
  eggs: boolean
  moments: boolean
  // The anniversary cursor trail.
  trail: boolean
  // 'MM-DD'. Stays on this device: never exported or sent.
  birthday: string | null
}

export const FX_KEY = 'fx'

export const defaultFxPrefs: FxPrefs = {
  v: 2,
  on: true,
  motion: 'device',
  seasons: true,
  seasonOff: [],
  hemisphere: 'auto',
  reactions: true,
  messages: true,
  eggs: true,
  moments: true,
  trail: true,
  birthday: null,
}

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const bool = (x: unknown, fallback: boolean) => (typeof x === 'boolean' ? x : fallback)

const birthday = (x: unknown, fallback: string | null) => {
  if (x === null) return null
  const found = typeof x === 'string' ? /^(\d\d)-(\d\d)$/.exec(x) : null
  if (!found) return fallback
  const month = Number(found[1])
  const day = Number(found[2])
  return month >= 1 && month <= 12 && day >= 1 && day <= MONTH_DAYS[month - 1] ? found[0] : fallback
}

const seasonOff = (x: unknown, fallback: SeasonId[]) =>
  Array.isArray(x) ? SEASON_IDS.filter(id => x.includes(id)) : fallback

const read = (data: unknown, base: FxPrefs): FxPrefs => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return base
  const o = data as Record<string, unknown>
  if (o.v !== 2) return base
  return {
    v: 2,
    on: bool(o.on, base.on),
    motion:
      o.motion === 'device' || o.motion === 'still' || o.motion === 'always'
        ? o.motion
        : base.motion,
    seasons: bool(o.seasons, base.seasons),
    seasonOff: seasonOff(o.seasonOff, base.seasonOff),
    hemisphere:
      o.hemisphere === 'auto' || o.hemisphere === 'north' || o.hemisphere === 'south'
        ? o.hemisphere
        : base.hemisphere,
    reactions: bool(o.reactions, base.reactions),
    messages: bool(o.messages, base.messages),
    eggs: bool(o.eggs, base.eggs),
    moments: bool(o.moments, base.moments),
    trail: bool(o.trail, base.trail),
    birthday: birthday(o.birthday, base.birthday),
  }
}

export const parseFxPrefs = (raw: string | null): FxPrefs => {
  try {
    return read(raw ? (JSON.parse(raw) as unknown) : null, defaultFxPrefs)
  } catch {
    return defaultFxPrefs
  }
}

export const fxValue = (prefs: FxPrefs) => JSON.stringify(prefs)

// What Sync config carries: everything but the birthday.
export const fxShared = ({ birthday: _, ...shared }: FxPrefs): Omit<FxPrefs, 'birthday'> => shared

// A synced value over this device's: fields it doesn't hold stay, and so does the birthday.
export const importFxShared = (local: FxPrefs, shared: unknown): FxPrefs => ({
  ...read(shared, local),
  birthday: local.birthday,
})

export type FxKind = 'seasons' | 'reactions' | 'messages' | 'eggs' | 'moments' | 'trail'

// The gate's `kindOn` for an effect of this kind.
export const fxKindOn = (prefs: FxPrefs, kind: FxKind) =>
  kind === 'trail' ? prefs.moments && prefs.trail : prefs[kind]

// The seasons that are off for an account: its own choices, and those the instance's list
// (`instance.fx.seasons`; missing on older instances) leaves out.
export const seasonsOff = (
  prefs: FxPrefs,
  allowed: readonly string[] | 'all' | undefined
): Set<SeasonId> =>
  new Set(
    SEASON_IDS.filter(
      id =>
        !prefs.seasons ||
        prefs.seasonOff.includes(id) ||
        (Array.isArray(allowed) && !allowed.includes(id))
    )
  )

export const hemisphereFor = (prefs: FxPrefs, timeZone: string | undefined): Hemisphere =>
  prefs.hemisphere === 'auto' ? hemisphereOf(timeZone) : prefs.hemisphere
