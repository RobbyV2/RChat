// Reference solver for scripts and self-bots (spec "The puzzle"). No dependencies: node or bun.
// const { token } = await trust(base, session) gives the X-Trust-Token value for later requests.
import { createHash } from 'node:crypto'

export const seedOf = challenge =>
  createHash('sha256').update('rchat-pow-seed1\0').update(challenge).digest()

const input = (seed, sub, nonce) => {
  const b = Buffer.alloc(51)
  b.write('rchat-pow1', 0, 'ascii')
  seed.copy(b, 10)
  b[42] = sub
  b.writeBigUInt64LE(nonce, 43)
  return b
}

export const wins = (seed, sub, nonce, target) =>
  createHash('sha256')
    .update(input(seed, sub, nonce))
    .digest()
    .readBigUInt64BE(0) < target

export const solve = (challenge, k, target) => {
  const seed = seedOf(challenge)
  const nonces = []
  for (let sub = 0; sub < k; sub++) {
    let n = 0n
    while (!wins(seed, sub, n, target)) n++
    nonces.push(n)
  }
  return nonces
}

export const wire = nonces =>
  nonces
    .map(n => {
      const b = Buffer.alloc(8)
      b.writeBigUInt64LE(n)
      return b.toString('hex')
    })
    .join('')

// The whole exchange against an instance. `session` is the account's session token, or null for
// a guest. A sign-in token (`cls` 'signin') binds to the address and `username`.
export const trust = async (base, session, cls = 'general', username = undefined) => {
  const auth = session ? { Authorization: `Bearer ${session}` } : {}
  const json = { 'Content-Type': 'application/json' }
  const c = await fetch(`${base}/api/v1/pow/challenge`, {
    method: 'POST',
    headers: { ...auth, ...json },
    body: JSON.stringify({ class: cls, username }),
  }).then(r => r.json())
  const nonces = solve(c.challenge, c.k, BigInt(c.target))
  return fetch(`${base}/api/v1/pow/token`, {
    method: 'POST',
    headers: { ...auth, ...json },
    body: JSON.stringify({ challenge: c.challenge, nonces: wire(nonces) }),
  }).then(r => r.json())
}
