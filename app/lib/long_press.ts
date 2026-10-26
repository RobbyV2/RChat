export const HOLD_MS = 450
export const PRESSED_DELAY_MS = 100
export const MOVE_SLOP = 10
export const DRAG_SLOP = 5
export const CLICK_GUARD_MS = 400

export type PressPhase = 'idle' | 'pending' | 'held' | 'lifted' | 'dragging'

export interface Press {
  phase: PressPhase
  x: number
  y: number
  guardUntil: number
  drag: boolean
  mouse: boolean
}

export const idlePress: Press = {
  phase: 'idle',
  x: 0,
  y: 0,
  guardUntil: 0,
  drag: false,
  mouse: false,
}

export type PressInput =
  | { kind: 'start'; x: number; y: number; touches: number; drag?: boolean }
  | { kind: 'mouse'; x: number; y: number }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'timer' }
  | { kind: 'native'; x: number; y: number; now: number }
  | { kind: 'end'; now: number }
  | { kind: 'cancel'; now: number }
  | { kind: 'escape' }
  | { kind: 'key' }
  | { kind: 'touch'; touches: number }

export type DragSignal = 'start' | 'drop' | 'cancel' | null

export interface PressOutput {
  arm: boolean
  clear: boolean
  open: { x: number; y: number } | null
  swallow: boolean
  lift: boolean
  drag: DragSignal
}

const out = (over: Partial<PressOutput> = {}): PressOutput => ({
  arm: false,
  clear: false,
  open: null,
  swallow: false,
  lift: false,
  drag: null,
  ...over,
})

const busy = (phase: PressPhase) => phase === 'held' || phase === 'lifted' || phase === 'dragging'

const dropped = (phase: PressPhase): DragSignal => (phase === 'dragging' ? 'cancel' : null)

const lift = (press: Press): [Press, PressOutput] => [
  { ...press, phase: 'lifted' },
  out({ clear: true, lift: true }),
]

export const pressStep = (press: Press, input: PressInput): [Press, PressOutput] => {
  const { phase } = press
  const far = (x: number, y: number, slop: number) => Math.hypot(x - press.x, y - press.y) > slop
  switch (input.kind) {
    case 'start':
      if (input.touches !== 1)
        return busy(phase)
          ? [press, out()]
          : [{ ...press, phase: 'idle' }, out({ clear: phase === 'pending' })]
      return [
        {
          ...press,
          phase: 'pending',
          x: input.x,
          y: input.y,
          drag: input.drag ?? false,
          mouse: false,
        },
        out({ arm: true, clear: phase === 'pending', drag: dropped(phase) }),
      ]
    case 'mouse':
      return [
        { phase: 'pending', x: input.x, y: input.y, guardUntil: 0, drag: true, mouse: true },
        out({ clear: phase === 'pending', drag: dropped(phase) }),
      ]
    case 'move':
      if (phase === 'lifted')
        return far(input.x, input.y, MOVE_SLOP)
          ? [{ ...press, phase: 'dragging' }, out({ drag: 'start' })]
          : [press, out()]
      if (phase !== 'pending') return [press, out()]
      if (press.mouse)
        return far(input.x, input.y, DRAG_SLOP)
          ? [{ ...press, phase: 'dragging' }, out({ drag: 'start' })]
          : [press, out()]
      if (!far(input.x, input.y, MOVE_SLOP)) return [press, out()]
      return [{ ...press, phase: 'idle' }, out({ clear: true })]
    case 'timer':
      if (phase !== 'pending' || press.mouse) return [press, out()]
      if (press.drag) return lift(press)
      return [{ ...press, phase: 'held' }, out({ clear: true, open: { x: press.x, y: press.y } })]
    case 'native':
      if (phase === 'pending' && press.drag && !press.mouse) return lift(press)
      if (phase === 'pending')
        return [{ ...press, phase: 'held' }, out({ clear: true, open: { x: press.x, y: press.y } })]
      if (busy(phase) || input.now < press.guardUntil) return [press, out()]
      return [press, out({ open: { x: input.x, y: input.y } })]
    case 'end':
    case 'cancel': {
      if (!busy(phase)) return [{ ...press, phase: 'idle' }, out({ clear: phase === 'pending' })]
      const next: Press = { ...press, phase: 'idle', guardUntil: input.now + CLICK_GUARD_MS }
      const ended = input.kind === 'end'
      if (phase === 'dragging')
        return [next, out({ swallow: ended, drag: ended ? 'drop' : 'cancel' })]
      if (phase === 'lifted' && ended)
        return [next, out({ swallow: true, open: { x: press.x, y: press.y } })]
      return [next, out({ swallow: ended })]
    }
    case 'escape':
      if (phase !== 'lifted' && phase !== 'dragging') return [press, out()]
      return [{ ...press, phase: 'held' }, out({ drag: dropped(phase) })]
    case 'key':
      if (phase === 'held') return [{ ...press, phase: 'idle', guardUntil: 0 }, out()]
      return phase === 'idle' ? [{ ...press, guardUntil: 0 }, out()] : [press, out()]
    case 'touch':
      if (input.touches === 1)
        return [
          { ...press, phase: 'idle', guardUntil: 0 },
          out({ clear: phase === 'pending', drag: dropped(phase) }),
        ]
      return [busy(phase) ? press : { ...press, guardUntil: 0 }, out()]
  }
}

export const swallowsClick = (press: Press, now: number) =>
  busy(press.phase) || now < press.guardUntil
