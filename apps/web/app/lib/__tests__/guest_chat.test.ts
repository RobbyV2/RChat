import { expect, test } from 'bun:test'
import { ApiClient } from '../api'
import { accountBenefits, guestHomeLine, postGuest } from '../guest_chat'

function guest(origin: string) {
  const api = new ApiClient(origin + '/api')
  const seen: { path: string; session?: string }[] = []
  let releases!: () => void
  let began!: () => void
  const started = new Promise<void>(resolve => {
    began = resolve
  })
  const hold = new Promise<void>(resolve => {
    releases = resolve
  })
  let rejectFirst = false
  api.req = async <T>(
    _method: string,
    path: string,
    _body: unknown,
    headers: Record<string, string> = {}
  ) => {
    const secret = headers['X-Guest-Session']
    seen.push({ path, session: secret })
    const issued = 'session-' + seen.length
    if (seen.length === 1) {
      began()
      await hold
      if (rejectFirst) throw Error('Could not post')
    }
    return { message: { content: path }, session: secret || issued } as T
  }
  return {
    seen,
    started,
    release: () => releases(),
    fail: () => {
      rejectFirst = true
    },
    post: (server: string, path: string) => postGuest(api, server, path, { content: path }),
  }
}
test('overlapping first sends share an author across composers without persistent storage', async () => {
  const a = guest('https://chat-a.example'),
    b = guest('https://chat-b.example')
  const first = a.post('garden', 'general')
  await a.started
  const second = a.post('garden', 'thread')
  const other = a.post('music', 'chat')
  const remote = b.post('garden', 'chat')
  await b.started
  b.release()
  await Promise.all([other, remote])
  expect(a.seen.map(s => s.path)).toEqual(['general', 'chat'])
  a.release()
  await Promise.all([first, second])
  expect(a.seen.at(-1)).toEqual({ path: 'thread', session: 'session-1' })
  await a.post('garden', 'other-channel')
  expect(a.seen.at(-1)?.session).toBe(a.seen[2].session)
})
test('a waiting composer acquires a session after the first request fails', async () => {
  const a = guest('https://retry.example')
  a.fail()
  const first = a.post('garden', 'first')
  await a.started
  const second = a.post('garden', 'second')
  a.release()
  expect(await first.catch((e: Error) => e.message)).toBe('Could not post')
  await second
  await a.post('garden', 'retry')
  expect(a.seen.map(s => s.session)).toEqual([undefined, undefined, 'session-2'])
})

test('the guest home says what guests can do on this site', () => {
  const site = (chat: boolean, voice: boolean) => ({
    guests_enabled: true,
    guest_chat_enabled: chat,
    guest_voice_enabled: voice,
  })
  expect(guestHomeLine(site(false, false))).toBe(
    "You're browsing as a guest. You can read servers but not post."
  )
  expect(guestHomeLine(site(true, false))).toBe(
    "You're browsing as a guest. You can send messages in servers that allow it."
  )
  expect(guestHomeLine(site(false, true))).toBe(
    "You're browsing as a guest. You can read servers and join voice in servers that allow it."
  )
  expect(guestHomeLine(site(true, true))).toBe(
    "You're browsing as a guest. You can send messages or join voice in servers that allow it."
  )
  expect(accountBenefits(site(false, true))).toBe(
    'send messages, add friends and get notified when someone mentions you.'
  )
  expect(accountBenefits(site(true, false))).toBe(
    'send direct messages, add friends and get notified when someone mentions you.'
  )
})
