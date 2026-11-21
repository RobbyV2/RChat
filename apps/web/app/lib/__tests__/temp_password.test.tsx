import { afterAll, afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Banners } from '../../components/banners'
import { api } from '../instances'
import { resetSessionCaches, useStore } from '../store'
import { temporaryNotice } from '../temp_password'
import { me } from './fixtures'

const realChange = api.changePassword
const initial = useStore.getInitialState()
const saved = { ...initial }

afterEach(() => {
  api.changePassword = realChange
  Object.assign(initial, saved)
  useStore.setState({ ...saved })
})

afterAll(resetSessionCaches)

test('the notice says what the temporary password asks of the account', () => {
  const now = 1_000_000
  expect(temporaryNotice({ expires_at: now + 3 * 86400, change: 'required' }, now)).toBe(
    'Your password is temporary. Choose your own to use the app.'
  )
  expect(temporaryNotice({ expires_at: now + 3 * 86400, change: 'encouraged' }, now)).toBe(
    'Your password is temporary. It stops working in 3 days.'
  )
  expect(temporaryNotice({ expires_at: null, change: 'encouraged' }, now)).toBe(
    'Your password is temporary. Choose your own.'
  )
})

test('an account with a temporary password sees the notice until a toast or an error shows', () => {
  const temporary = { expires_at: null, change: 'required' as const }
  Object.assign(initial, { token: 'tok', me: me('dana', { password_temporary: temporary }) })
  const html = renderToStaticMarkup(<Banners />)
  expect(html).toContain('data-temporary-password')
  expect(html).toContain('Your password is temporary. Choose your own to use the app.')
  expect(html).toContain('Change it')
  Object.assign(initial, { error: 'Change your password first' })
  const failing = renderToStaticMarkup(<Banners />)
  expect(failing).not.toContain('data-temporary-password')
  expect(failing).toContain('Change your password first')
  Object.assign(initial, { error: null, me: me('dana') })
  expect(renderToStaticMarkup(<Banners />)).not.toContain('data-temporary-password')
  Object.assign(initial, { me: me('dana', { password_temporary: null }) })
  expect(renderToStaticMarkup(<Banners />)).not.toContain('data-temporary-password')
})

test('choosing a password ends the notice', async () => {
  api.changePassword = async () => ({ ok: true })
  useStore.setState({
    token: 'tok',
    me: me('dana', { password_temporary: { expires_at: null, change: 'required' } }),
  })
  expect(
    await useStore.getState().changePassword({ password: 'a' }, { password: 'b' }, 'text')
  ).toBe(null)
  expect(useStore.getState().me?.password_temporary).toBe(null)
  expect(useStore.getState().me?.password_kind).toBe('text')
})
