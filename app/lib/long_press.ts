export const HOLD_MS = 450
export const PRESSED_DELAY_MS = 100
export const MOVE_SLOP = 10
export const CLICK_GUARD_MS = 400

export type PressPhase = 'idle' | 'pending' | 'held'

export interface Press {
  phase: PressPhase
  x: number
  y: number
  guardUntil: number
}

export const idlePress: Press = { phase: 'idle', x: 0, y: 0, guardUntil: 0 }

export type PressInput =
  | { kind: 'start'; x: number; y: number; touches: number }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'timer' }
  | { kind: 'native'; x: number; y: number; now: number }
  | { kind: 'end'; now: number }
  | { kind: 'cancel'; now: number }
  | { kind: 'touch'; touches: number }

export interface PressOutput {
  arm: boolean
  clear: boolean
  open: { x: number; y: number } | null
  swallow: boolean
}

const out = (over: Partial<PressOutput> = {}): PressOutput => ({
  arm: false,
  clear: false,
  open: null,
  swallow: false,
  ...over,
})

export const pressStep = (press: Press, input: PressInput): [Press, PressOutput] => {
  const { phase } = press
  switch (input.kind) {
    case 'start':
      if (input.touches !== 1)
        return phase === 'held'
          ? [press, out()]
          : [{ ...press, phase: 'idle' }, out({ clear: phase === 'pending' })]
      return [
        { ...press, phase: 'pending', x: input.x, y: input.y },
        out({ arm: true, clear: phase === 'pending' }),
      ]
    case 'move':
      if (phase !== 'pending') return [press, out()]
      if (Math.hypot(input.x - press.x, input.y - press.y) <= MOVE_SLOP) return [press, out()]
      return [{ ...press, phase: 'idle' }, out({ clear: true })]
    case 'timer':
      if (phase !== 'pending') return [press, out()]
      return [{ ...press, phase: 'held' }, out({ clear: true, open: { x: press.x, y: press.y } })]
    case 'native':
      if (phase === 'pending')
        return [{ ...press, phase: 'held' }, out({ clear: true, open: { x: press.x, y: press.y } })]
      if (phase === 'held' || input.now < press.guardUntil) return [press, out()]
      return [press, out({ open: { x: input.x, y: input.y } })]
    case 'end':
    case 'cancel':
      if (phase === 'held')
        return [
          { ...press, phase: 'idle', guardUntil: input.now + CLICK_GUARD_MS },
          out({ swallow: input.kind === 'end' }),
        ]
      return [{ ...press, phase: 'idle' }, out({ clear: phase === 'pending' })]
    case 'touch':
      if (input.touches === 1)
        return [{ ...press, phase: 'idle', guardUntil: 0 }, out({ clear: phase === 'pending' })]
      return [phase === 'held' ? press : { ...press, guardUntil: 0 }, out()]
  }
}

export const swallowsClick = (press: Press, now: number) =>
  press.phase === 'held' || now < press.guardUntil
