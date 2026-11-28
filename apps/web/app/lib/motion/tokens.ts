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

// How far things travel, in px.
export const DISTANCES = { settle: 2, lift: 4, rise: 6, slide: 16, swap: 24 } as const

// How much a pressed and a hovered control scale.
export const SCALES = { press: 0.97, hover: 1.03 } as const

// The same values as the style sheet has them (`globals.css`).
export const TOKEN_VARS = {
  ...DURATION_VARS,
  '--motion-standard': EASINGS.standard,
  '--motion-decelerate': EASINGS.decelerate,
  '--motion-accelerate': EASINGS.accelerate,
  '--motion-settle': `${DISTANCES.settle}px`,
  '--motion-lift': `${DISTANCES.lift}px`,
  '--motion-rise': `${DISTANCES.rise}px`,
  '--motion-slide': `${DISTANCES.slide}px`,
  '--motion-swap': `${DISTANCES.swap}px`,
  '--motion-press': `${SCALES.press}`,
  '--motion-hover': `${SCALES.hover}`,
} as const
