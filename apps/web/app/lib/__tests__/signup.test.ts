import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { ApiError } from '../api'
import { api } from '../instances'
import { signupFailure, signupField } from '../signup'
import { resetSessionCaches, useStore } from '../store'

// Every test file of a run shares the store and the client: start signed out with no notice,
// whatever an earlier file left, and put back what was there.
let realSend = api.send
let before = useStore.getState()

beforeEach(() => {
  realSend = api.send
  before = useStore.getState()
  useStore.setState({ token: null, error: null })
})

afterEach(() => {
  api.send = realSend
  useStore.setState(before)
})

afterAll(resetSessionCaches)

test('a refused username is shown under the username field', () => {
  for (const message of [
    'Content blocked by profanity filter',
    'Username is taken',
    'Username is banned',
    'Username required',
    'Username must be at most 100 characters',
    "Usernames can't contain @",
    'That name is reserved',
    'Something the server says tomorrow',
  ])
    expect([message, signupField(400, message)]).toEqual([message, 'username'])
})

test('other refusals stay in the form line', () => {
  for (const message of [
    'Password required',
    'Pick 7 words from your word set',
    'Provide exactly one of password or words',
    'Invalid avatar color',
  ])
    expect([message, signupField(400, message)]).toEqual([message, 'form'])
  for (const status of [401, 404, 423, 429, 500, 503])
    expect([status, signupField(status, 'Username is taken')]).toEqual([status, 'form'])
})

test('failures keep their message, whatever they are', () => {
  expect(signupFailure(new ApiError('Username is taken', 400))).toEqual({
    field: 'username',
    message: 'Username is taken',
  })
  expect(signupFailure(new ApiError('Not found', 404))).toEqual({
    field: 'form',
    message: 'Not found',
  })
  expect(signupFailure(new TypeError('Failed to fetch'))).toEqual({
    field: 'form',
    message: 'Failed to fetch',
  })
  expect(signupFailure('offline')).toEqual({ field: 'form', message: 'offline' })
})

const answer = (status: number, body: string, headers: Record<string, string> = {}) => {
  api.send = () => Promise.resolve(new Response(body, { status, headers }))
}
const signUp = () =>
  useStore.getState().register({ username: 'x', password: 'p', avatar_kind: 'identicon' })

test('a refused sign-up comes back to the form and is not a passing notice', async () => {
  answer(400, JSON.stringify({ error: 'Content blocked by profanity filter' }))
  expect(await signUp()).toEqual({
    field: 'username',
    message: 'Content blocked by profanity filter',
  })
  expect(useStore.getState().error).toBe(null)
  expect(useStore.getState().token).toBe(null)
  answer(400, JSON.stringify({ error: 'Invalid avatar color' }))
  expect(await signUp()).toEqual({ field: 'form', message: 'Invalid avatar color' })
  answer(400, 'not json')
  expect((await signUp())?.field).toBe('username')
  answer(429, 'Too many requests', { 'Retry-After': '7' })
  const limited = await signUp()
  expect(limited?.field).toBe('form')
  expect(limited?.message).toContain('7')
  answer(500, '')
  expect((await signUp())?.field).toBe('form')
  api.send = () => Promise.reject(new TypeError('Failed to fetch'))
  expect(await signUp()).toEqual({ field: 'form', message: 'Failed to fetch' })
  expect(useStore.getState().error).toBe(null)
})
