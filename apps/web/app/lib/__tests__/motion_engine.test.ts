import { describe, expect, test } from 'bun:test'
import { ManualTime, type Time } from '../clock'
import { DESKTOP, FxThrottle } from '../fx/particles'
import {
  ARRIVALS,
  Engine,
  MAX_ENTERING,
  MAX_LEAVING,
  MAX_RUNNING,
  MIN_GLIDE,
  behind,
  leaving,
  looksOf,
  mirrored,
  resolve,
  type Config,
  type Page,
  type ListWatch,
  type Place,
  type Spot,
} from '../motion/engine'
import { BUILTINS, PRESETS } from '../motion/presets'
import { LOOK_IDS, PLAY_IDS, type PlaySlot, type SlotId } from '../motion/slots'
import { DURATIONS, EASINGS } from '../motion/tokens'
import { check, type Frame } from '../motion/validate'

const SUBTLE: Config = { style: 'subtle', custom: {}, reduced: false }
const LIVELY: Config = { style: 'lively', custom: {}, reduced: false }

interface Played {
  keyframes: Frame[]
  options: KeyframeAnimationOptions
  state: 'running' | 'finished' | 'cancelled'
  finish(): void
}

class El {
  isConnected = true
  played: Played[] = []
  animate(keyframes: Frame[], options: KeyframeAnimationOptions) {
    const handle = {
      onfinish: null as null | (() => void),
      oncancel: null as null | (() => void),
      cancel: () => {
        if (played.state !== 'running') return
        played.state = 'cancelled'
        handle.oncancel?.()
      },
    }
    const played: Played = {
      keyframes,
      options,
      state: 'running',
      finish: () => {
        if (played.state !== 'running') return
        played.state = 'finished'
        handle.onfinish?.()
      },
    }
    this.played.push(played)
    return handle
  }
}
const el = () => new El()
const dom = (e: El) => e as unknown as Element

const world = (config: Config = SUBTLE, step: 0 | 1 | 2 | 3 = 0, frameMs?: number) => {
  const time = new ManualTime()
  const clock: Time =
    frameMs === undefined
      ? time
      : {
          now: () => time.now(),
          elapsed: () => time.elapsed(),
          after: (ms, fn) => time.after(ms, fn),
          every: (ms, fn) => time.every(ms, fn),
          deadline: ms => time.deadline(ms),
          frame: fn => time.after(frameMs, () => fn(time.elapsed())),
        }
  const throttle = new FxThrottle(DESKTOP, { step })
  const state = {
    hidden: false,
    shut: new Set<El>(),
    came: new Map<El, El>(),
    went: new Map<El, El>(),
    tails: new Set<El>(),
    places: new Map<El, Place>(),
    unshot: new Set<El>(),
    inside: new Map<El, El>(),
    ghosts: [] as El[],
    twins: new Map<El, El>(),
    spots: [] as { el: El; at: Place; seen?: boolean }[],
    lists: [] as ListWatch[],
    unwatched: 0,
    dropped: [] as El[],
    marks: [] as [string | null, readonly SlotId[]][],
    soon: [] as (() => void)[],
    live: null as ReadonlySet<SlotId> | null,
    blurs: null as ReadonlySet<SlotId> | null,
  }
  const page: Page = {
    hidden: () => state.hidden,
    open: e => !state.shut.has(e as unknown as El),
    within: (e, o) => state.inside.get(e as unknown as El) === (o as unknown as El),
    addedWith: e => (state.came.get(e as unknown as El) as unknown as Element) ?? null,
    removedWith: e => (state.went.get(e as unknown as El) as unknown as Element) ?? null,
    lastOfOld: e => state.tails.has(e as unknown as El),
    place: e => state.places.get(e as unknown as El) ?? { x: 0, y: 0 },
    shoot: e => (state.unshot.has(e as unknown as El) ? null : {}),
    ghost: () => {
      const ghost = el()
      state.ghosts.push(ghost)
      return dom(ghost)
    },
    twin: (_, inner) => {
      const twin = el()
      state.twins.set(inner as unknown as El, twin)
      return dom(twin)
    },
    drop: g => void state.dropped.push(g as unknown as El),
    spots: () =>
      state.spots.map(({ el, at, seen = true }): Spot => ({ el: dom(el), at: { ...at }, seen })),
    watch: (_scope, _items, on) => {
      state.lists.push(on)
      return () => void state.unwatched++
    },
    mark: (style, looks) => void state.marks.push([style, looks]),
    soon: fn => void state.soon.push(fn),
  }
  const engine = new Engine(config, page, clock, throttle, {
    set: (plays, blurs) => {
      state.live = plays
      state.blurs = blurs
    },
  })
  const settle = () => {
    for (const fn of state.soon.splice(0)) fn()
  }
  return { engine, time, throttle, state, settle }
}

describe('what a slot plays', () => {
  test('Subtle and Lively play their own tables', () => {
    for (const slot of PLAY_IDS) {
      expect(resolve(slot, SUBTLE, 'full')).toBe(PRESETS.subtle[slot])
      expect(resolve(slot, LIVELY, 'full')).toBe(PRESETS.lively[slot])
    }
  })

  test('a tab that runs late plays Lively as Subtle, then nothing', () => {
    for (const slot of PLAY_IDS) {
      expect(resolve(slot, LIVELY, 'calm')).toBe(PRESETS.subtle[slot])
      expect(resolve(slot, LIVELY, 'none')).toBeNull()
      expect(resolve(slot, SUBTLE, 'none')).toBeNull()
    }
  })

  test('Custom plays Subtle but for the slots set to off or to a named animation', () => {
    const custom: Config = {
      style: 'custom',
      custom: { dialog: 'core.pop', toast: 'off' },
      reduced: false,
    }
    expect(resolve('dialog', custom, 'full')).toBe(BUILTINS['core.pop'])
    expect(resolve('toast', custom, 'full')).toBeNull()
    expect(resolve('menu', custom, 'full')).toBe(PRESETS.subtle.menu)
    expect(resolve('dialog', { ...custom, style: 'lively' }, 'full')).toBe(PRESETS.lively.dialog)
  })

  test('Reduced keeps only opacity, for at most 150 ms, and plays nothing else', () => {
    for (const style of ['subtle', 'lively'] as const)
      for (const slot of PLAY_IDS) {
        const a = resolve(slot, { style, custom: {}, reduced: true }, 'full')
        if (a === null) continue
        expect(check(a)).toEqual([])
        expect(a.keyframes.some(f => 'transform' in f)).toBe(false)
        expect(a.keyframes.some(f => f.opacity !== 1)).toBe(true)
        expect(a.timing.duration).toBeLessThanOrEqual(150)
      }
    const reduced: Config = { style: 'subtle', custom: {}, reduced: true }
    expect(resolve('sheet', reduced, 'full')).toBeNull()
    expect(resolve('badge', reduced, 'full')).toBeNull()
    expect(resolve('reorder', reduced, 'full')).toBeNull()
    expect(resolve('dialog', reduced, 'full')?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
  })

  test('the style sheet moves its slots unless reduced, set to off, or the tab is too late', () => {
    expect(looksOf(SUBTLE, 'full')).toEqual([...LOOK_IDS])
    expect(looksOf(LIVELY, 'calm')).toEqual([...LOOK_IDS])
    expect(looksOf(SUBTLE, 'none')).toEqual([])
    expect(looksOf({ ...SUBTLE, reduced: true }, 'full')).toEqual([])
    const custom: Config = { style: 'custom', custom: { press: 'off' }, reduced: false }
    expect(looksOf(custom, 'full')).toEqual(LOOK_IDS.filter(id => id !== 'press'))
    expect(looksOf({ ...custom, style: 'subtle' }, 'full')).toEqual([...LOOK_IDS])
  })

  test('an exit is the entrance the other way: medium at most, speeding up', () => {
    const out = leaving(PRESETS.lively.dialog)
    expect(out.keyframes).toEqual([...PRESETS.lively.dialog.keyframes].reverse())
    expect(out.timing).toEqual({ duration: DURATIONS.medium, easing: EASINGS.accelerate })
    expect(leaving(PRESETS.subtle.menu).timing.duration).toBe(DURATIONS.short)
    const middle = leaving({
      keyframes: [{ opacity: 0 }, { offset: 0.25, opacity: 0.9 }, { opacity: 1 }],
      timing: { duration: 100 },
    })
    expect(middle.keyframes).toEqual([
      { opacity: 1 },
      { offset: 0.75, opacity: 0.9 },
      { opacity: 0 },
    ])
  })

  test('going back mirrors the sideways travel', () => {
    expect(mirrored(PRESETS.subtle['lightbox.slide']).keyframes).toEqual([
      { opacity: 0, transform: 'translateX(-24px)' },
      { opacity: 1, transform: 'translateX(0)' },
    ])
    expect(mirrored(mirrored(PRESETS.lively['lightbox.slide']))).toEqual(
      PRESETS.lively['lightbox.slide']
    )
  })
})

describe('the engine', () => {
  test('tells the page its style and slots as it starts, and clears them as it stops', () => {
    const { engine, state } = world(LIVELY)
    expect(state.marks).toEqual([['lively', [...LOOK_IDS]]])
    expect([...(state.live ?? [])].sort()).toEqual([...PLAY_IDS, ...LOOK_IDS].sort())
    expect(state.blurs).toBe(state.live)
    engine.stop()
    expect(state.marks[1]).toEqual([null, []])
  })

  test('Reduced marks the page reduced, with nothing the style sheet moves and no blur', () => {
    const { state } = world({ ...SUBTLE, reduced: true })
    expect(state.marks).toEqual([['reduced', []]])
    expect(state.live?.size).toBe(0)
  })

  test('an entering element plays its slot with the token timing', () => {
    const { engine } = world()
    const a = el()
    engine.enter(dom(a), 'dialog')
    expect(a.played).toHaveLength(1)
    expect(a.played[0].keyframes).toEqual(PRESETS.subtle.dialog.keyframes)
    expect(a.played[0].options).toEqual({
      duration: DURATIONS.medium,
      delay: 0,
      easing: EASINGS.standard,
      iterations: 1,
      fill: 'backwards',
    })
    expect(engine.count).toBe(1)
    a.played[0].finish()
    expect(engine.count).toBe(0)
  })

  test('an element enters once, however often its ref runs', () => {
    const { engine } = world()
    const a = el()
    engine.enter(dom(a), 'menu')
    engine.enter(dom(a), 'menu')
    expect(a.played.map(p => p.state)).toEqual(['running'])
  })

  test('a slot that plays again on an element cuts the one before short', () => {
    const { engine } = world()
    const a = el()
    engine.change(dom(a), 'reaction.count', 1)
    engine.change(dom(a), 'reaction.count', 2)
    engine.change(dom(a), 'reaction.count', 3)
    expect(a.played.map(p => p.state)).toEqual(['cancelled', 'running'])
    expect(engine.count).toBe(1)
  })

  test('what lies behind a slot fades in step with it, and never moves', () => {
    const { engine } = world(LIVELY)
    const scrim = el()
    engine.enter(dom(scrim), 'dialog', true)
    expect(scrim.played[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(scrim.played[0].options.duration).toBe(PRESETS.lively.dialog.timing.duration)
    expect(behind(PRESETS.subtle.sheet)).toBeNull()
    const still = el()
    engine.enter(dom(still), 'sheet', true)
    expect(still.played).toHaveLength(0)
  })

  test('what leaves inside something that leaves goes with its copy', () => {
    const { engine, state, settle } = world()
    const scrim = el()
    const panel = el()
    state.inside.set(panel, scrim)
    engine.leave(dom(panel), 'dialog')
    engine.leave(dom(scrim), 'dialog', true)
    panel.isConnected = false
    scrim.isConnected = false
    settle()
    expect(state.ghosts).toHaveLength(1)
    expect(state.ghosts[0].played[0].keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }])
  })

  test('a dialog that closes scales down inside the copy of its fading scrim', () => {
    const { engine, state, settle } = world()
    const scrim = el()
    const panel = el()
    state.inside.set(panel, scrim)
    engine.leave(dom(panel), 'dialog')
    engine.leave(dom(scrim), 'dialog', true)
    panel.isConnected = false
    scrim.isConnected = false
    settle()
    const twin = state.twins.get(panel)
    expect(twin?.played).toHaveLength(1)
    expect(twin?.played[0].keyframes).toEqual(leaving(PRESETS.subtle.dialog).keyframes)
    expect(twin?.played[0].options.duration).toBe(DURATIONS.medium)
    expect(twin?.played[0].options.fill).toBe('both')
    expect(engine.count).toBe(2)
    state.ghosts[0].played[0].finish()
    expect(state.dropped).toEqual([state.ghosts[0]])
  })

  test('only the element of the scrim it lies on plays inside the copy', () => {
    const { engine, state, settle } = world()
    const scrim = el()
    const menu = el()
    const badge = el()
    state.inside.set(menu, scrim)
    state.inside.set(badge, scrim)
    engine.leave(dom(menu), 'menu')
    engine.leave(dom(badge), 'toast')
    engine.leave(dom(scrim), 'dialog', true)
    for (const e of [menu, badge, scrim]) e.isConnected = false
    settle()
    expect(state.ghosts).toHaveLength(1)
    expect(state.twins.size).toBe(0)
  })

  test(`at most ${MAX_RUNNING} run at once; one more shows in its end state`, () => {
    const { engine } = world()
    const els = Array.from({ length: MAX_RUNNING + 1 }, el)
    for (const e of els) engine.enter(dom(e), 'dialog')
    expect(els.map(e => e.played.length)).toEqual([...Array(MAX_RUNNING).fill(1), 0])
    els[0].played[0].finish()
    const next = el()
    engine.enter(dom(next), 'dialog')
    expect(next.played).toHaveLength(1)
  })

  test('nothing plays in a hidden page, where the page is shut, or after a stop', () => {
    const { engine, state } = world()
    const a = el()
    state.hidden = true
    engine.enter(dom(a), 'dialog')
    state.hidden = false
    state.shut.add(a)
    engine.enter(dom(a), 'dialog')
    state.shut.clear()
    engine.stop()
    engine.enter(dom(a), 'dialog')
    expect(a.played).toHaveLength(0)
  })

  test('a stop cuts short what plays and removes what was going', () => {
    const { engine, state, settle } = world()
    const a = el()
    const b = el()
    engine.enter(dom(a), 'dialog')
    engine.leave(dom(b), 'sheet')
    b.isConnected = false
    settle()
    expect(state.ghosts).toHaveLength(1)
    engine.stop()
    expect(a.played[0].state).toBe('cancelled')
    expect(state.dropped).toEqual(state.ghosts)
    expect(engine.count).toBe(0)
  })

  test('a badge pops once the update ends, when it is the one badge in what was added', () => {
    const { engine, state, settle } = world()
    const old = el()
    const alone = el()
    const wrapped = el()
    const wrapper = el()
    state.came.set(alone, alone)
    state.came.set(wrapped, wrapper)
    for (const e of [old, alone, wrapped]) engine.enter(dom(e), 'badge')
    expect(alone.played).toHaveLength(0)
    settle()
    expect(old.played).toHaveLength(0)
    expect(alone.played).toHaveLength(1)
    expect(wrapped.played).toHaveLength(1)
  })

  test('badges that come together with their screen stay as they are', () => {
    const { engine, state, settle } = world()
    const sidebar = el()
    const badges = [el(), el(), el()]
    for (const e of badges) {
      state.came.set(e, sidebar)
      engine.enter(dom(e), 'badge')
    }
    settle()
    expect(badges.map(e => e.played.length)).toEqual([0, 0, 0])
  })

  test('what enters inside something else that enters stays as it is', () => {
    const { engine, state, settle } = world()
    const row = el()
    const chip = el()
    state.came.set(row, row)
    state.came.set(chip, row)
    state.inside.set(chip, row)
    engine.enter(dom(chip), 'reaction.add')
    engine.enter(dom(row), 'message.arrive')
    settle()
    expect(chip.played).toHaveLength(0)
    const later = el()
    state.came.set(later, later)
    state.inside.set(later, row)
    engine.enter(dom(later), 'reaction.add')
    settle()
    expect(later.played).toHaveLength(1)
  })

  test(`a screen of more than ${MAX_ENTERING} entering elements pops nothing`, () => {
    const { engine, state, settle } = world()
    const alone = el()
    state.came.set(alone, alone)
    engine.enter(dom(alone), 'badge')
    for (let i = 0; i < MAX_ENTERING; i++) engine.enter(dom(el()), 'route')
    settle()
    expect(alone.played).toHaveLength(0)
  })

  test(`messages arrive moving only at the end of a list, ${ARRIVALS.count} per ${ARRIVALS.within} ms`, () => {
    const { engine, state, time } = world()
    const loaded = el()
    state.came.set(loaded, loaded)
    engine.enter(dom(loaded), 'message.arrive')
    const older = el()
    engine.enter(dom(older), 'message.arrive')
    expect(loaded.played).toHaveLength(0)
    expect(older.played).toHaveLength(0)
    const burst = Array.from({ length: 5 }, el)
    for (const e of burst) {
      const wrapper = el()
      state.came.set(e, wrapper)
      state.tails.add(wrapper)
      engine.enter(dom(e), 'message.arrive')
    }
    expect(burst.map(e => e.played.length)).toEqual([1, 1, 1, 0, 0])
    time.advance(ARRIVALS.within)
    const next = el()
    state.came.set(next, next)
    state.tails.add(next)
    engine.enter(dom(next), 'message.arrive')
    expect(next.played).toHaveLength(1)
  })

  test('an element that left shows going as a copy, which is removed at the end', () => {
    const { engine, state, settle } = world()
    const a = el()
    engine.leave(dom(a), 'dialog')
    a.isConnected = false
    expect(state.ghosts).toHaveLength(0)
    settle()
    const [ghost] = state.ghosts
    expect(ghost.played[0].keyframes).toEqual(leaving(PRESETS.subtle.dialog).keyframes)
    expect(ghost.played[0].options.fill).toBe('both')
    expect(state.dropped).toEqual([])
    ghost.played[0].finish()
    expect(state.dropped).toEqual([ghost])
    expect(engine.count).toBe(0)
  })

  test('nothing goes for an element that stays in the page, one that only enters, or one not shot', () => {
    const { engine, state, settle } = world()
    const stays = el()
    const route = el()
    const unseen = el()
    state.unshot.add(unseen)
    engine.leave(dom(stays), 'dialog')
    engine.leave(dom(route), 'route')
    engine.leave(dom(unseen), 'dialog')
    route.isConnected = false
    unseen.isConnected = false
    settle()
    expect(state.ghosts).toHaveLength(0)
  })

  test('a removed message goes only when it went on its own, with its own exit', () => {
    const { engine, state, settle } = world()
    const list = el()
    const withList = [el(), el()]
    const deleted = el()
    const wrapper = el()
    state.went.set(deleted, wrapper)
    for (const e of withList) state.went.set(e, list)
    for (const e of [...withList, deleted]) {
      engine.leave(dom(e), 'message.remove')
      e.isConnected = false
    }
    settle()
    expect(state.ghosts).toHaveLength(1)
    expect(state.ghosts[0].played[0].keyframes).toEqual(PRESETS.subtle['message.remove'].keyframes)
  })

  test(`more than ${MAX_LEAVING} leaving at once is a screen change, with no exits`, () => {
    const { engine, state, settle } = world()
    const els = Array.from({ length: MAX_LEAVING + 1 }, el)
    for (const e of els) {
      engine.leave(dom(e), 'dialog')
      e.isConnected = false
    }
    settle()
    expect(state.ghosts).toHaveLength(0)
    const one = el()
    engine.leave(dom(one), 'dialog')
    one.isConnected = false
    settle()
    expect(state.ghosts).toHaveLength(1)
  })

  test('a change plays when the key is another one, never for the first', () => {
    const { engine } = world()
    const a = el()
    engine.change(dom(a), 'reaction.count', 1)
    engine.change(dom(a), 'reaction.count', 1)
    expect(a.played).toHaveLength(0)
    engine.change(dom(a), 'reaction.count', 2)
    expect(a.played).toHaveLength(1)
    expect(a.played[0].keyframes).toEqual(PRESETS.subtle['reaction.count'].keyframes)
  })

  test('the media viewer swaps forward, and mirrored going back', () => {
    const { engine } = world()
    const a = el()
    engine.change(dom(a), 'lightbox.slide', 3)
    engine.change(dom(a), 'lightbox.slide', 4)
    engine.change(dom(a), 'lightbox.slide', 2)
    expect(a.played[0].keyframes[0].transform).toBe('translateX(24px)')
    expect(a.played[1].keyframes[0].transform).toBe('translateX(-24px)')
  })

  test('a reorder glides from where the element was', () => {
    const { engine, state } = world()
    const a = el()
    state.places.set(a, { x: 0, y: 100 })
    engine.change(dom(a), 'reorder', 2)
    state.places.set(a, { x: 0, y: 40 })
    engine.change(dom(a), 'reorder', 1)
    expect(a.played[0].keyframes).toEqual([
      { transform: 'translate(0px, 60px)' },
      { transform: 'translate(0, 0)' },
    ])
    engine.change(dom(a), 'reorder', 0)
    expect(a.played).toHaveLength(1)
    state.places.set(a, { x: 0, y: 4000 })
    engine.change(dom(a), 'reorder', 9)
    expect(a.played).toHaveLength(1)
  })

  test('the items of a list glide from where they stood when the list was last at rest', () => {
    const { engine, state } = world()
    const [a, b, c] = [el(), el(), el()]
    state.spots = [
      { el: a, at: { x: 0, y: 0 } },
      { el: b, at: { x: 0, y: 40 } },
      { el: c, at: { x: 0, y: 80 } },
    ]
    engine.list(dom(el()), '[data-item]')
    state.lists[0].moved()
    expect([a, b, c].flatMap(e => e.played)).toHaveLength(0)
    state.lists[0].rest()
    state.spots = [
      { el: b, at: { x: 0, y: 0 } },
      { el: c, at: { x: 0, y: 40 } },
      { el: a, at: { x: 0, y: 80 } },
    ]
    state.lists[0].moved()
    expect(a.played[0].keyframes).toEqual([
      { transform: 'translate(0px, -80px)' },
      { transform: 'translate(0, 0)' },
    ])
    expect(a.played[0].options.duration).toBe(DURATIONS.medium)
    expect(b.played[0].keyframes[0]).toEqual({ transform: 'translate(0px, 40px)' })
    expect(c.played[0].keyframes[0]).toEqual({ transform: 'translate(0px, 40px)' })
  })

  test('an item that is new, out of sight, hardly moved or far away does not glide', () => {
    const { engine, state } = world()
    const [fresh, hidden, near, far, moved] = [el(), el(), el(), el(), el()]
    state.spots = [
      { el: hidden, at: { x: 0, y: 0 } },
      { el: near, at: { x: 0, y: 40 } },
      { el: far, at: { x: 0, y: 80 } },
      { el: moved, at: { x: 0, y: 120 } },
    ]
    engine.list(dom(el()), '[data-item]')
    state.lists[0].rest()
    state.spots = [
      { el: fresh, at: { x: 0, y: 0 } },
      { el: hidden, at: { x: 0, y: 40 }, seen: false },
      { el: near, at: { x: 0, y: 40 + MIN_GLIDE - 1 } },
      { el: far, at: { x: 0, y: 2000 } },
      { el: moved, at: { x: 0, y: 160 } },
    ]
    state.lists[0].moved()
    expect([fresh, hidden, near, far].flatMap(e => e.played)).toHaveLength(0)
    expect(moved.played).toHaveLength(1)
  })

  test('a list that changes order again glides from where it had settled to', () => {
    const { engine, state } = world()
    const a = el()
    state.spots = [{ el: a, at: { x: 0, y: 0 } }]
    engine.list(dom(el()), '[data-item]')
    state.lists[0].rest()
    state.spots = [{ el: a, at: { x: 0, y: 40 } }]
    state.lists[0].moved()
    state.spots = [{ el: a, at: { x: 500, y: 500 } }]
    state.lists[0].rest()
    state.spots = [{ el: a, at: { x: 0, y: 100 } }]
    state.lists[0].moved()
    expect(a.played[0].state).toBe('cancelled')
    expect(a.played[1].keyframes[0]).toEqual({ transform: 'translate(0px, -60px)' })
  })

  test(`the farthest items glide first when more move than the ${MAX_RUNNING} that may run`, () => {
    const { engine, state } = world()
    const items = Array.from({ length: MAX_RUNNING + 3 }, () => el())
    state.spots = items.map((e, i) => ({ el: e, at: { x: 0, y: i * 40 } }))
    engine.list(dom(el()), '[data-item]')
    state.lists[0].rest()
    state.spots = items.map((e, i) => ({ el: e, at: { x: 0, y: i * 40 + (i + 1) * 10 } }))
    state.lists[0].moved()
    expect(engine.count).toBe(MAX_RUNNING)
    expect(items.slice(0, 3).flatMap(e => e.played)).toHaveLength(0)
    expect(items.slice(3).every(e => e.played.length === 1)).toBe(true)
  })

  test('a list stops being watched as it goes, or as the engine stops', () => {
    const { engine, state } = world()
    const off = engine.list(dom(el()), '[data-item]')
    engine.list(dom(el()), '[data-item]')
    off()
    expect(state.unwatched).toBe(1)
    engine.stop()
    expect(state.unwatched).toBe(2)
    engine.list(dom(el()), '[data-item]')
    expect(state.lists).toHaveLength(2)
  })

  test('with reordering set to off, or reduced, a list jumps', () => {
    for (const config of [
      { style: 'custom', custom: { reorder: 'off' }, reduced: false } as Config,
      { ...SUBTLE, reduced: true },
    ]) {
      const { engine, state } = world(config)
      const a = el()
      state.spots = [{ el: a, at: { x: 0, y: 0 } }]
      engine.list(dom(el()), '[data-item]')
      state.lists[0].rest()
      state.spots = [{ el: a, at: { x: 0, y: 40 } }]
      state.lists[0].moved()
      expect(a.played).toHaveLength(0)
    }
  })

  test('frames are timed only while something plays', () => {
    const { engine, time } = world()
    expect(time.pending).toBe(0)
    const a = el()
    engine.enter(dom(a), 'dialog')
    expect(time.pending).toBe(1)
    time.advance(64)
    expect(time.pending).toBe(1)
    a.played[0].finish()
    time.advance(32)
    expect(time.pending).toBe(0)
  })

  test('late frames step Lively down to Subtle, then to nothing, and the blur goes first', () => {
    const { engine, time, throttle, state } = world(LIVELY, 0, 40)
    const late = () => {
      const a = el()
      engine.enter(dom(a), 'dialog')
      time.advance(40 * (DESKTOP.lateFrames + 1))
      a.played[0]?.finish()
      time.advance(40)
    }
    late()
    expect(throttle.step).toBe(1)
    expect(state.marks[state.marks.length - 1][0]).toBe('subtle')
    expect(state.live?.has('dialog')).toBe(true)
    expect(state.blurs?.size).toBe(0)
    const calm = el()
    engine.enter(dom(calm), 'dialog')
    expect(calm.played[0].options.easing).toBe(EASINGS.standard)
    calm.played[0].finish()
    time.advance(40)
    late()
    expect(throttle.step).toBe(2)
    expect(state.marks[state.marks.length - 1]).toEqual([null, []])
    expect(state.live?.size).toBe(0)
    const none = el()
    engine.enter(dom(none), 'dialog')
    expect(none.played).toHaveLength(0)
  })

  test('an engine that starts on a tab already stepped down starts there', () => {
    const { state } = world(LIVELY, 1)
    expect(state.marks).toEqual([['subtle', [...LOOK_IDS]]])
    const off = world(LIVELY, 3)
    expect(off.state.marks).toEqual([[null, []]])
  })

  test('every slot the engine plays is one a screen can name', () => {
    const { engine } = world()
    for (const slot of PLAY_IDS as PlaySlot[]) {
      const a = el()
      engine.enter(dom(a), slot)
      engine.change(dom(a), slot, 1)
      engine.leave(dom(a), slot)
    }
    expect(engine.count).toBeLessThanOrEqual(MAX_RUNNING)
  })
})
