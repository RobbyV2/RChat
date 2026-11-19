import {
  dangerBtn as dangerBase,
  fieldCls as fieldBase,
  filledBtn as filledBase,
  textBtn as textBase,
} from '../ui'

// The app's buttons and fields as the site administration page shows them: 44 px high on
// touch screens.
const touch = 'min-h-11 md:min-h-0'

export const textBtn = `${textBase} ${touch}`
export const filledBtn = `${filledBase} ${touch}`
export const dangerBtn = `${dangerBase} ${touch}`
export const fieldCls = `${fieldBase} ${touch}`
