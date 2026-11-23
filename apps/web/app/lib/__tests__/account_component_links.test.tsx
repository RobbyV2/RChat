import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageLink } from '../../components/markdown_message'
import { AccountProvider } from '../client/react'
import { client } from '../client/client'
import { testAccount } from './test_account'

test('markdown routes only links belonging to the account displaying it', () => {
  const a = testAccount('sam', 'https://one.test')
  const b = testAccount('sam', 'https://two.test')
  const shown = client.shown
  try {
    client.shown = () => a
    for (const path of ['/dm/1/7/', '/invite/garden/']) {
      const href = b.conn.origin + path
      const link = <MessageLink href={href}>Open</MessageLink>
      expect(renderToStaticMarkup(link)).toContain('target="_blank"')
      expect(
        renderToStaticMarkup(<AccountProvider session={b}>{link}</AccountProvider>)
      ).not.toContain('target="_blank"')
    }
  } finally {
    client.shown = shown
    a.store.dispose()
    b.store.dispose()
  }
})
