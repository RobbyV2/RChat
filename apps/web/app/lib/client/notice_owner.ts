import type { AlertInput } from '../notices'
import { client } from './client'
import type { AccountSession } from './session'

// Show the destination account for any viewing prompt, but keep the current
// history entry with its source until the action has an admitted destination.
export async function openAccountNotice(account: AccountSession, go: AlertInput['go']) {
  const source = client.shown()
  const { authExpired, signedOut } = account.store.getState()
  if (authExpired || signedOut) return
  if (source === account) return void (await go())
  if (!client.show(account, 'notice')) return
  const mark = account.lifetime.sessionMark()
  const result = go(true)
  if (!(result instanceof Promise)) {
    if (client.noticePending(account)) {
      if (result === false) client.show(source, 'none')
      else client.show(account)
    }
    return
  }
  const intent = account.store.navigationMark()
  try {
    await result
  } finally {
    if (
      client.noticePending(account) &&
      (account.store.navigationMark() === intent || mark !== account.lifetime.sessionMark())
    )
      client.show(source, 'none')
  }
}
