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
// A reorder farther than this (px) is a jump, not a glide.
export const MAX_GLIDE = 600

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

// What the engine keeps of an element that is about to leave the page, to show it going.
export type Shot = object

// The page as the engine sees it (`dom.ts`).
export interface Page {
  hidden(): boolean
  // Whether `slot` may play on `el` where it is (never in the composer; only tiles in a call).
  open(el: Element, slot: PlaySlot): boolean
  // Whether `el` came into, or went out of, the page by itself in this update.
  cameAlone(el: Element): boolean
  wentAlone(el: Element): boolean
  // Whether `el` is the one new element after the last of a list that was already there.
  newTail(el: Element): boolean
  place(el: Element): Place
  // Taken while `el` is still in the page; null when it can't be shown going.
  shoot(el: Element): Shot | null
  // A still copy of `el` where it was, over the page.
  ghost(el: Element, shot: Shot): Element | null
  drop(ghost: Element): void
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
  private ghosts = new Set<Element>()
  private going: { el: Element; slot: PlaySlot; shot: Shot | null }[] = []
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

  enter(el: Element, slot: PlaySlot) {
    const def = BY_ID.get(slot)
    if (!def || def.plays === 'exit' || def.plays === 'change') return
    const a = this.animation(slot)
    if (!a || !this.may(el, slot)) return
    if (def.solo && !this.page.cameAlone(el)) return
    if (def.tail && !(this.page.newTail(el) && this.arrives())) return
    this.run(el, slot, a, 'backwards')
  }

  leave(el: Element, slot: PlaySlot) {
    const def = BY_ID.get(slot)
    if (!def || (def.plays !== 'both' && def.plays !== 'exit')) return
    if (!this.animation(slot) || !this.may(el, slot)) return
    const shot = this.going.length < MAX_LEAVING ? this.page.shoot(el) : null
    this.going.push({ el, slot, shot })
    if (this.going.length === 1) this.page.soon(() => this.leaves())
  }

  private leaves() {
    const going = this.going
    this.going = []
    if (this.stopped || going.length > MAX_LEAVING) return
    for (const { el, slot, shot } of going) {
      const def = BY_ID.get(slot)
      const a = this.animation(slot)
      if (!def || !a || !shot || el.isConnected) continue
      if (def.solo && !this.page.wentAlone(el)) continue
      if (this.running.size >= MAX_RUNNING) continue
      const ghost = this.page.ghost(el, shot)
      if (!ghost) continue
      this.ghosts.add(ghost)
      const drop = () => {
        if (this.ghosts.delete(ghost)) this.page.drop(ghost)
      }
      if (!this.run(ghost, slot, def.plays === 'exit' ? a : leaving(a), 'both', drop)) drop()
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

  stop() {
    if (this.stopped) return
    this.stopped = true
    this.watching?.()
    this.watching = null
    for (const run of [...this.running]) run.cancel()
    this.running.clear()
    for (const ghost of [...this.ghosts]) this.page.drop(ghost)
    this.ghosts.clear()
    this.going = []
    this.page.mark(null, [])
  }
}
