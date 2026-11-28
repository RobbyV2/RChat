// Motion that shows a state (busy, ringing, speaking, time running out, a sheet opening) and plays
// whatever the Animations setting says. These are the only keyframe classes a screen uses.
export const FUNCTIONAL = {
  spin: 'animate-spin',
  spinSafe: 'motion-safe:animate-spin',
  pulse: 'animate-pulse',
  pulseSafe: 'motion-safe:animate-pulse',
  ring: 'motion-safe:animate-ring',
  ringLate: 'animation-delay-700 motion-safe:animate-ring',
  speak: 'motion-safe:animate-speak',
  countdown: 'animate-notice-time motion-reduce:animate-none',
  sheetUp: 'animate-sheet-up',
} as const
