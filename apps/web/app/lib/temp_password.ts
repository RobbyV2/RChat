// An account that signed in with a temporary password: what the app tells it.

import { span } from './admin_accounts'
import type { Me } from './types'

type Temporary = NonNullable<Me['password_temporary']>

// The line of the notice at the top of the app. `now` is in unix seconds.
export const temporaryNotice = (temporary: Temporary, now: number) => {
  if (temporary.change === 'required')
    return 'Your password is temporary. Choose your own to use the app.'
  if (temporary.expires_at === null) return 'Your password is temporary. Choose your own.'
  return `Your password is temporary. It stops working in ${span(temporary.expires_at, now)}.`
}
