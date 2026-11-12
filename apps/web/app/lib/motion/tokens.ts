export const DURATIONS = { short: 120, medium: 200, long: 320 } as const

export const DURATION_VARS = {
  '--motion-short': `${DURATIONS.short}ms`,
  '--motion-medium': `${DURATIONS.medium}ms`,
  '--motion-long': `${DURATIONS.long}ms`,
} as const

export const EASINGS = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  decelerate: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  accelerate: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
} as const

export const SPRINGS = {
  gentle: { stiffness: 300, damping: 30 },
  bouncy: { stiffness: 300, damping: 15 },
} as const
