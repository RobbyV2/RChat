import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SignInMethods } from '../../components/sso/sign_in_methods'
import { AccountProvider } from '../client/react'
import { testAccount } from './test_account'

test('Settings protects the configured provider and allows removing an obsolete link', () => {
  const acct = testAccount('alice')
  const links = [
    { provider: 'work', name: 'Work', linked_at: 1, can_unlink: false },
    { provider: 'old', name: 'Old', linked_at: 2, can_unlink: true },
  ]
  try {
    const html = renderToStaticMarkup(
      <AccountProvider session={acct}>
        <SignInMethods list={{ links, supported: true, error: null, refresh: () => {} }} />
      </AccountProvider>
    )
    const buttons = Array.from(html.matchAll(/<button([^>]*)>Unlink<\/button>/g), match => match[1])
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toContain(' disabled=""')
    expect(buttons[1]).not.toContain(' disabled=""')
  } finally {
    acct.store.dispose()
  }
})
