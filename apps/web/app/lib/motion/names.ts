// The named animations a slot can be set to, and what Settings calls them.
export const BUILTIN_NAMES = [
  'core.fade',
  'core.fade-scale',
  'core.slide',
  'core.rise',
  'core.pop',
  'core.jiggle',
  'core.spring-scale',
  'core.crossfade',
] as const
export type BuiltinName = (typeof BUILTIN_NAMES)[number]

export const BUILTIN_LABELS: Record<BuiltinName, string> = {
  'core.fade': 'Fade',
  'core.fade-scale': 'Fade and scale',
  'core.slide': 'Slide',
  'core.rise': 'Rise',
  'core.pop': 'Pop',
  'core.jiggle': 'Jiggle',
  'core.spring-scale': 'Spring',
  'core.crossfade': 'Crossfade',
}

export const isBuiltin = (x: unknown): x is BuiltinName =>
  typeof x === 'string' && (BUILTIN_NAMES as readonly string[]).includes(x)

// The extension points a plugin host registers motion under, and the permission they need.
export const MOTION_POINTS = { animations: 'motion.animations@1', slots: 'motion.slots@1' } as const
export const MOTION_PERMISSION = 'ui:motion'
