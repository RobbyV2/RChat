// The motion engine: the one place an animation starts. It plays a slot's animation on the
// element a screen hands it (transform and opacity only, through the Web Animations API), keeps
// to the tab's budget, and steps down when frames run late. It loads only while animations are on.
import type { Cancel, Time } from '../clock'
import { BUILTINS, PRESETS } from './presets'
import type { AnimStyle, CustomChoices } from './setting'
import { LOOK_IDS, PLAY_IDS, SLOTS, type PlaySlot, type Slot, type SlotId } from './slots'
import { stepOf, type Step } from './throttle'
import { DURATIONS, EASINGS } from './tokens'
import { reduced as reducedOf, type Animation, type Frame } from './validate'
import type { Player } from './wire'

// At most this many animations run in a tab; one more jumps to its end state.
export const MAX_RUNNING = 12
// At most this many message arrivals animate within this many ms; the rest appear still.
export const ARRIVALS = { count: 3, within: 500 } as const
// More elements than this leaving in one update is a screen change, which plays no exits.
export const MAX_LEAVING = 4
// More elements than this entering in one update is a screen that mounts, where nothing pops.
export const MAX_ENTERING = 300
// A reorder farther than this (px) is a jump, not a glide.
export const MAX_GLIDE = 600
// An item less than this (px) from where it was has not moved.
export const MIN_GLIDE = 2

export interface Config {
  style: AnimStyle
  custom: CustomChoices
  // Fades only: Motion is at Reduced.
  reduced: boolean
}

export interface Place {
  x: number
  y: number
}

// An item of a list: where it stands in the list, and whether it shows in the window.
export interface Spot {
  el: Element
  at: Place
  seen: boolean
}

// What the page tells of a list: `moved` as its items change order, before the page shows it,
// and `rest` a while after anything in it changed.
export interface ListWatch {
  moved(): void
  rest(): void
}

// What the engine keeps of an element that is about to leave the page, to show it going.
export type Shot = object

// The page as the engine sees it (`dom.ts`).
export interface Page {
  hidden(): boolean
  // Whether `slot` may play on `el` where it is (never in the composer; only tiles in a call).
  open(el: Element, slot: PlaySlot): boolean
  // Whether `el` is inside `other`.
  within(el: Element, other: Element): boolean
  // What came into, or went out of, the page in this update holding `el` (or `el` itself); null
  // when `el` was there before, or is there after.
  addedWith(el: Element): Element | null
  removedWith(el: Element): Element | null
  // Whether `added` stands after the last of a list that was already there.
  lastOfOld(added: Element): boolean
  place(el: Element): Place
  // Taken while `el` is still in the page; null when it can't be shown going.
  shoot(el: Element): Shot | null
  // A still copy of `el` where it was, over the page.
  ghost(el: Element, shot: Shot): Element | null
  // What stands for `inner`, an element inside `el`, in `el`'s copy.
  twin(el: Element, inner: Element, ghost: Element): Element | null
  drop(ghost: Element): void
  // The items of the list `scope` (what matches `items` in it), each placed against the item
  // that holds it, or against the list.
  spots(scope: Element, items: string): Spot[]
  watch(scope: Element, items: string, on: ListWatch): () => void
  // What the style sheet reads: the style, the slots it moves, and whether backdrops blur.
  mark(style: 'subtle' | 'lively' | 'reduced' | null, looks: readonly SlotId[]): void
  // After the update that is running now.
  soon(fn: () => void): void
}

export interface Throttle {
  step: number
  observe(workMs: number, gapMs: number): boolean
}

export interface Live {
  set(plays: ReadonlySet<SlotId> | null, blurs: ReadonlySet<SlotId> | null): void
}

const BY_ID = new Map<SlotId, Slot>(SLOTS.map(s => [s.id, s]))

const still = (a: Animation) => a.keyframes.every(f => (f.opacity ?? 1) === 1 && !f.transform)

// The same animation the other way, as an element goes: no longer than medium, speeding up.
export const leaving = (a: Animation): Animation => ({
  keyframes: [...a.keyframes]
    .reverse()
    .map(f => (f.offset === undefined ? f : { ...f, offset: 1 - f.offset })),
  timing: { duration: Math.min(a.timing.duration, DURATIONS.medium), easing: EASINGS.accelerate },
})

// The same animation with its sideways travel the other way, for going back.
export const mirrored = (a: Animation): Animation => ({
  keyframes: a.keyframes.map(f =>
    f.transform === undefined
      ? f
      : {
          ...f,
          transform: f.transform.replace(/translateX\((-?[\d.]+)/g, (all, n: string) =>
            Number(n) === 0 ? all : `translateX(${-Number(n)}`
          ),
        }
  ),
  timing: a.timing,
})

// The animation of what lies behind a slot's element (a scrim, a blur): its fade alone, in step.
export const behind = (a: Animation): Animation | null => {
  const faded: Animation = {
    keyframes: a.keyframes.map(({ offset, opacity }) => ({
      ...(offset === undefined ? {} : { offset }),
      opacity: opacity ?? 1,
    })),
    timing: a.timing,
  }
  return still(faded) ? null : faded
}

// A slot's animation under a config and a throttle step, or null when it shows still.
export const resolve = (slot: PlaySlot, config: Config, step: Step): Animation | null => {
  if (step === 'none') return null
  const choice = config.style === 'custom' ? config.custom[slot] : undefined
  if (choice === 'off') return null
  const preset = config.style === 'lively' && step === 'full' ? PRESETS.lively : PRESETS.subtle
  const full = choice ? BUILTINS[choice] : preset[slot]
  if (!config.reduced) return full
  const faded = reducedOf(full)
  return still(faded) ? null : faded
}

// The slots the style sheet moves under a config and a throttle step.
export const looksOf = (config: Config, step: Step): SlotId[] =>
  config.reduced || step === 'none'
    ? []
    : LOOK_IDS.filter(id => !(config.style === 'custom' && config.custom[id] === 'off'))

interface Run {
  cancel(): void
}

export class Engine implements Player {
  private running = new Set<Run>()
  private onEl = new WeakMap<Element, Map<PlaySlot, Run>>()
  private keys = new WeakMap<Element, Map<PlaySlot, string | number>>()
  private places = new WeakMap<Element, Place>()
  private spots = new WeakMap<Element, Place>()
  private lists = new Set<() => void>()
  private ghosts = new Set<Element>()
  private entered = new WeakSet<Element>()
  private batch: Element[] = []
  private waiting: { el: Element; slot: PlaySlot; a: Animation }[] = []
  private going: { el: Element; slot: PlaySlot; back: boolean; shot: Shot | null }[] = []
  private behinds = new Map<PlaySlot, Animation | null>()
  private arrivals: number[] = []
  private watching: Cancel | null = null
  private stopped = false
  private step: Step
  private resolved = new Map<PlaySlot, Animation | null>()

  constructor(
    private readonly config: Config,
    private readonly page: Page,
    private readonly time: Time,
    private readonly throttle: Throttle,
    private readonly live: Live
  ) {
    this.step = stepOf(throttle as { step: 0 | 1 | 2 | 3 })
    this.announce()
  }

  get count() {
    return this.running.size
  }

  private announce() {
    this.resolved.clear()
    this.behinds.clear()
    const { config, step } = this
    const looks = looksOf(config, step)
    const style =
      step === 'none'
        ? null
        : config.reduced
          ? 'reduced'
          : config.style === 'lively' && step === 'full'
            ? 'lively'
            : 'subtle'
    this.page.mark(style, looks)
    const moving = config.reduced ? [] : PLAY_IDS.filter(id => this.animation(id) !== null)
    const plays = new Set<SlotId>([...moving, ...looks])
    this.live.set(plays, step === 'full' ? plays : new Set())
  }

  private animation(slot: PlaySlot) {
    let a = this.resolved.get(slot)
    if (a === undefined) {
      a = resolve(slot, this.config, this.step)
      this.resolved.set(slot, a)
    }
    return a
  }

  private part(slot: PlaySlot, back: boolean) {
    const a = this.animation(slot)
    if (!a || !back) return a
    let b = this.behinds.get(slot)
    if (b === undefined) {
      b = behind(a)
      this.behinds.set(slot, b)
    }
    return b
  }

  private may(el: Element, slot: PlaySlot) {
    return !this.stopped && !this.page.hidden() && this.page.open(el, slot)
  }

  // Starts `a` on `el`; a slot already playing there is cut short. False when the tab is at its
  // budget, and the element shows in its end state.
  private run(el: Element, slot: PlaySlot, a: Animation, fill: FillMode, done?: () => void) {
    const mine = this.onEl.get(el) ?? new Map<PlaySlot, Run>()
    mine.get(slot)?.cancel()
    if (this.running.size >= MAX_RUNNING) return false
    const { duration, delay = 0, easing = EASINGS.standard, iterations = 1 } = a.timing
    const playing = el.animate(a.keyframes as Keyframe[], {
      duration,
      delay,
      easing,
      iterations,
      fill,
    })
    const run: Run = { cancel: () => playing.cancel() }
    let over = false
    const end = () => {
      if (over) return
      over = true
      this.running.delete(run)
      if (mine.get(slot) === run) mine.delete(slot)
      done?.()
    }
    playing.onfinish = end
    playing.oncancel = end
    this.running.add(run)
    mine.set(slot, run)
    this.onEl.set(el, mine)
    this.watch()
    return true
  }

  // Frames are timed only while something plays.
  private watch() {
    if (this.watching) return
    let last: number | null = null
    const tick = (at: number) => {
      this.watching = null
      if (this.stopped || this.running.size === 0) return
      if (last !== null) {
        this.throttle.observe(0, at - last)
        const step = stepOf(this.throttle as { step: 0 | 1 | 2 | 3 })
        if (step !== this.step) {
          this.step = step
          this.announce()
        }
      }
      last = at
      this.watching = this.time.frame(tick)
    }
    this.watching = this.time.frame(tick)
  }

  private arrives() {
    const now = this.time.elapsed()
    this.arrivals = this.arrivals.filter(at => now - at < ARRIVALS.within)
    if (this.arrivals.length >= ARRIVALS.count) return false
    this.arrivals.push(now)
    return true
  }

  // An element enters once: a ref that runs again for it plays nothing.
  enter(el: Element, slot: PlaySlot, back = false) {
    const def = BY_ID.get(slot)
    if (!def || def.plays === 'exit' || def.plays === 'change') return
    if (this.entered.has(el)) return
    this.entered.add(el)
    this.batch.push(el)
    if (this.batch.length === 1) this.page.soon(() => this.settles())
    const a = this.part(slot, back)
    if (!a || !this.may(el, slot)) return
    if (def.tail) {
      const added = this.page.addedWith(el)
      if (!added || !this.page.lastOfOld(added) || !this.arrives()) return
    }
    if (def.solo) this.waiting.push({ el, slot, a })
    else this.run(el, slot, a, 'backwards')
  }

  // What plays only on its own waits for the update to end: it plays when it is the one element
  // of its slot in what was added, and nothing else that entered holds it.
  private settles() {
    const batch = this.batch
    const waiting = this.waiting
    this.batch = []
    this.waiting = []
    if (this.stopped || batch.length > MAX_ENTERING) return
    const added = waiting.map(w => this.page.addedWith(w.el))
    waiting.forEach((w, i) => {
      const root = added[i]
      if (!root) return
      if (waiting.some((o, j) => j !== i && o.slot === w.slot && added[j] === root)) return
      if (batch.some(o => o !== w.el && this.page.within(w.el, o))) return
      this.run(w.el, w.slot, w.a, 'backwards')
    })
  }

  leave(el: Element, slot: PlaySlot, back = false) {
    const def = BY_ID.get(slot)
    if (!def || (def.plays !== 'both' && def.plays !== 'exit')) return
    if (!this.part(slot, back) || !this.may(el, slot)) return
    const shot = this.going.length < MAX_LEAVING ? this.page.shoot(el) : null
    this.going.push({ el, slot, back, shot })
    if (this.going.length === 1) this.page.soon(() => this.leaves())
  }

  private leaves() {
    const going = this.going
    this.going = []
    if (this.stopped || going.length > MAX_LEAVING) return
    const removed = going.map(g => (g.el.isConnected ? null : this.page.removedWith(g.el)))
    const copies = new Map<Element, Element>()
    const held: { el: Element; slot: PlaySlot; a: Animation; holder: Element }[] = []
    for (const [i, { el, slot, back, shot }] of going.entries()) {
      const def = BY_ID.get(slot)
      const a = this.part(slot, back)
      if (!def || !a || !shot || el.isConnected) continue
      // What leaves inside something that leaves goes with its copy. A slot's element inside
      // what lies behind it (a dialog in its scrim) plays its own exit there.
      const holder = going.find(g => g.el !== el && !g.el.isConnected && this.page.within(el, g.el))
      if (holder) {
        if (holder.slot === slot && holder.back && !back && def.plays === 'both')
          held.push({ el, slot, a, holder: holder.el })
        continue
      }
      const root = removed[i]
      const shared = going.some((o, j) => j !== i && o.slot === slot && removed[j] === root)
      if (def.solo && (!root || shared)) continue
      if (this.running.size >= MAX_RUNNING) continue
      const ghost = this.page.ghost(el, shot)
      if (!ghost) continue
      this.ghosts.add(ghost)
      const drop = () => {
        if (this.ghosts.delete(ghost)) this.page.drop(ghost)
      }
      if (this.run(ghost, slot, def.plays === 'exit' ? a : leaving(a), 'both', drop))
        copies.set(el, ghost)
      else drop()
    }
    for (const { el, slot, a, holder } of held) {
      const ghost = copies.get(holder)
      const twin = ghost && this.page.twin(holder, el, ghost)
      if (twin) this.run(twin, slot, leaving(a), 'both')
    }
  }

  change(el: Element, slot: PlaySlot, key: string | number) {
    const def = BY_ID.get(slot)
    if (!def) return
    const keys = this.keys.get(el) ?? new Map<PlaySlot, string | number>()
    const before = keys.get(slot)
    keys.set(slot, key)
    this.keys.set(el, keys)
    const was = def.flip ? this.places.get(el) : undefined
    const now = def.flip ? this.page.place(el) : undefined
    if (now) this.places.set(el, now)
    if (before === undefined || before === key) return
    const a = this.animation(slot)
    if (!a || !this.may(el, slot)) return
    if (!def.flip) {
      const back = typeof key === 'number' && typeof before === 'number' && key < before
      this.run(el, slot, back ? mirrored(a) : a, 'backwards')
      return
    }
    if (!was || !now) return
    const dx = was.x - now.x
    const dy = was.y - now.y
    if ((dx === 0 && dy === 0) || Math.abs(dx) > MAX_GLIDE || Math.abs(dy) > MAX_GLIDE) return
    const from: Frame = { transform: `translate(${dx}px, ${dy}px)` }
    this.run(el, slot, { keyframes: [from, ...a.keyframes], timing: a.timing }, 'backwards')
  }

  // The items of a list glide to their places when their order changes: each from where it
  // stood when the list was last at rest, the farthest first.
  list(scope: Element, items: string): () => void {
    if (this.stopped) return () => {}
    const rest = () => {
      for (const { el, at } of this.page.spots(scope, items))
        if (!this.onEl.get(el)?.has('reorder')) this.spots.set(el, at)
    }
    const off = this.page.watch(scope, items, {
      moved: () => this.reordered(scope, items),
      rest,
    })
    const stop = () => {
      off()
      this.lists.delete(stop)
    }
    this.lists.add(stop)
    return stop
  }

  private reordered(scope: Element, items: string) {
    if (this.stopped) return
    let spots = this.page.spots(scope, items)
    const gliding = spots.map(s => this.onEl.get(s.el)?.get('reorder')).filter(run => !!run)
    if (gliding.length > 0) {
      for (const run of gliding) run.cancel()
      spots = this.page.spots(scope, items)
    }
    const a = this.animation('reorder')
    const moves: { el: Element; dx: number; dy: number }[] = []
    for (const { el, at, seen } of spots) {
      const was = this.spots.get(el)
      this.spots.set(el, at)
      if (!was || !a || !seen || !this.may(el, 'reorder')) continue
      const dx = Math.round(was.x - at.x)
      const dy = Math.round(was.y - at.y)
      const far = Math.max(Math.abs(dx), Math.abs(dy))
      if (far >= MIN_GLIDE && far <= MAX_GLIDE) moves.push({ el, dx, dy })
    }
    if (!a) return
    const far = (m: { dx: number; dy: number }) => Math.abs(m.dx) + Math.abs(m.dy)
    moves.sort((x, y) => far(y) - far(x))
    for (const { el, dx, dy } of moves) {
      const from: Frame = { transform: `translate(${dx}px, ${dy}px)` }
      const glide = { keyframes: [from, ...a.keyframes], timing: a.timing }
      if (!this.run(el, 'reorder', glide, 'backwards')) break
    }
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    for (const off of [...this.lists]) off()
    this.watching?.()
    this.watching = null
    for (const run of [...this.running]) run.cancel()
    this.running.clear()
    for (const ghost of [...this.ghosts]) this.page.drop(ghost)
    this.ghosts.clear()
    this.going = []
    this.batch = []
    this.waiting = []
    this.page.mark(null, [])
  }
}
