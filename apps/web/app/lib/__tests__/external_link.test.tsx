import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ExternalLinkDialog from '../../components/external_link_dialog'
import { LinkSafetySection } from '../../components/link_safety_settings'
import { AccountProvider } from '../client/react'
import { openMessageLink, warnsBefore } from '../link_open'
import { DEFAULT_LINK_PREFS, linkPrefsKey, parseLinkPrefs, siteOf } from '../link_safety'
import { readLocal } from '../instances'
import { testAccount } from './test_account'
import type { RChatState } from '../store_types'

// What a server render reads: the store's first state.
const show = (a: ReturnType<typeof testAccount>, state: Partial<RChatState>) => {
  a.store.setState(state)
  Object.assign(a.store.getInitialState(), state)
}
const account = (name = 'alice') => {
  const a = testAccount(name)
  return a
}

test('the warning names the site, calls out what looks off, and offers to trust it', () => {
  const a = account()
  show(a, {
    activeDialog: {
      kind: 'external_link',
      href: 'https://bank.com@xn--pple-43d.com/login?next=1',
      label: 'https://apple.com/login',
    },
  })
  const html = renderToStaticMarkup(
    <AccountProvider session={a}>
      <ExternalLinkDialog />
    </AccountProvider>
  )
  for (const text of [
    'External link warning',
    'You are about to leave this site',
    'External links can be dangerous. Be careful.',
    'Destination URL:',
    'https://bank.com@xn--pple-43d.com/login?next=1',
    'The link text points to a different domain than the destination.',
    'This address uses letters that can look like other letters.',
    'This address has a name or password in front of the site.',
    'Always trust',
    'Cancel',
    'Visit site',
  ])
    expect([text, html.includes(text)]).toEqual([text, true])
  expect(html).toContain('aria-label="Close"')
  expect(html).not.toContain('—')
})

test('a plain link shows no callout', () => {
  const a = account()
  show(a, {
    activeDialog: { kind: 'external_link', href: 'https://example.com/a', label: 'docs' },
  })
  const html = renderToStaticMarkup(
    <AccountProvider session={a}>
      <ExternalLinkDialog />
    </AccountProvider>
  )
  expect(html).toContain('example.com')
  expect(html).not.toContain('role="alert"')
})

test('the offer to trust names the whole site, and never a public suffix', () => {
  const offer = (href: string) => {
    const a = account()
    show(a, { activeDialog: { kind: 'external_link', href, label: null } })
    const html = renderToStaticMarkup(
      <AccountProvider session={a}>
        <ExternalLinkDialog />
      </AccountProvider>
    )
    return /Always trust <span[^>]*>([^<]+)<\/span>/.exec(html)?.[1] ?? null
  }
  expect(offer('https://docs.example.com/a')).toBe('example.com')
  expect(offer('https://www.com/')).toBe('www.com')
  expect(offer('https://www.co.uk/')).toBe('www.co.uk')
  expect(offer('https://github.io/')).toBeNull()
  expect(offer('http://localhost:8080/')).toBeNull()
  expect(offer('https://a_b.example.com/')).toBe('example.com')
  expect(offer('https://co.uk/')).toBeNull()
})

test('opening asks first until the site is trusted, and the choice is kept for the account', () => {
  const a = account('bob')
  expect(a.store.getState().linkPrefs).toEqual(DEFAULT_LINK_PREFS)
  expect(warnsBefore(a, 'https://evil.io/x', false)).toBe(true)
  expect(warnsBefore(a, 'https://evil.io/x', true)).toBe(false)
  expect(warnsBefore(a, 'https://instance.test/s/den', false)).toBe(false)
  openMessageLink(a, 'https://evil.io/x', 'evil', false)
  expect(a.store.getState().activeDialog).toEqual({
    kind: 'external_link',
    href: 'https://evil.io/x',
    label: 'evil',
  })
  a.store.getState().trustLinkSite(siteOf('www.evil.io')!)
  expect<readonly string[]>(a.store.getState().linkPrefs.trusted).toEqual(['evil.io'])
  expect(warnsBefore(a, 'https://sub.evil.io/x', false)).toBe(false)
  expect(parseLinkPrefs(readLocal(a.conn.scoped(linkPrefsKey('bob'))))).toEqual({
    warn: true,
    strip: false,
    trusted: [siteOf('evil.io')!],
  })
  a.store.getState().setLinkPrefs({ ...a.store.getState().linkPrefs, warn: false })
  expect(warnsBefore(a, 'https://other.io/', false)).toBe(false)
})

test('Settings lists the trusted domains with a remove button each', () => {
  const a = account()
  show(a, { linkPrefs: { warn: true, strip: true, trusted: [siteOf('github.com')!] } })
  const html = renderToStaticMarkup(
    <AccountProvider session={a}>
      <LinkSafetySection />
    </AccountProvider>
  )
  expect(html).toContain('Warn before opening external links')
  expect(html).toContain('Strip tracking parameters when sending')
  expect(html).toContain('github.com')
  expect(html).toContain('aria-label="Remove github.com"')
  expect(html).toContain('title="Remove github.com"')
})
