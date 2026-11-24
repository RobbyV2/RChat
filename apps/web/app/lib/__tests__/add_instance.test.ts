import { expect, test } from 'bun:test'
import {
  addingAllowed,
  afterProbe,
  alreadySignedIn,
  p2pTrustText,
  trustText,
} from '../add_instance'
import { addAccount, addInstance, parseBook } from '../client/book'
const own = 'https://alpha.test',
  foreign = 'https://beta.test'
const web = { pageOrigin: own, shell: false }
test('a new host requires trust, including from a shell, while own hosted and local-server targets proceed', () => {
  const book = parseBook(null)
  expect(afterProbe(book, own, 'alpha', web).step).toBe('signin')
  expect(afterProbe(book, foreign, 'beta', web).step).toBe('trust')
  expect(afterProbe(book, own, 'alpha', { ...web, ownOrigin: null }).step).toBe('trust')
  expect(afterProbe(book, own, 'alpha', { ...web, shell: true }).step).toBe('trust')
  expect(afterProbe(book, foreign, 'beta', { ...web, shell: true, localServer: true }).step).toBe(
    'signin'
  )
  expect(trustText('beta.test', 'alpha.test')).toBe(
    'This app is served by alpha.test, not by beta.test. It will keep your sign-in for beta.test and can read and send anything your account can. Continue only if you trust alpha.test.'
  )
  expect(trustText('beta.test', null)).toContain('a source you trust')
  expect(p2pTrustText(null)).toContain('read your P2P messages and act as you')
  expect(alreadySignedIn('alice', 'beta.test')).toBe(
    "You're already signed in as alice on beta.test."
  )
})
test('saved accounts and guests can return without consent, a discovery record alone cannot grant trust', () => {
  let b = addInstance(parseBook(null), { origin: foreign, id: 'beta', name: 'Beta' })
  expect(afterProbe(b, foreign, 'beta', web).step).toBe('trust')
  expect(afterProbe(b, own, 'beta', web).error).toContain('same instance as beta.test')
  b = addAccount(
    b,
    foreign,
    { username: 'alice', display: null, avatar: null, connect: true, added: 0, identities: [] },
    own
  )
  expect(afterProbe(b, foreign, 'beta', web).step).toBe('known')
  expect(
    afterProbe(
      { ...b, instances: [{ ...b.instances[0], accounts: [], guest: true }] },
      foreign,
      'beta',
      web
    ).step
  ).toBe('known')
  expect(afterProbe(b, foreign, 'beta', { ...web, knownAccountEntry: true }).step).toBe('signin')
  for (let i = 1; i < 50; i++)
    b = addAccount(b, foreign, { ...b.instances[0].accounts[0], username: 'u' + i }, own)
  expect(afterProbe(b, own, 'alpha', web).error).toContain('50 saved accounts')
  expect(afterProbe(b, foreign, 'beta', web).step).toBe('known')
  expect(addingAllowed(false, false, false)).toBe(false)
  expect(addingAllowed(true, false, false)).toBe(true)
  expect(addingAllowed(false, true, false)).toBe(true)
})
