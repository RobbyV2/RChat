import { isRecord } from '../bytes'
import { b64u, canonicalBytes, fromB64u, parseCanonicalBytes } from './canonical'
import { inflateRaw, storeRaw } from './inflate'
import { cleanName, isKeyId, keyId, liveCerts, verifyCert, type Cert, type KeyPair } from './keys'

// A contact card: `rcp1.` + base64url(deflate-raw(canonical JSON)). It carries what a contact
// needs to dial us: the identity, its device certificates (each signed by the identity key), a
// claimed name and the instance whose signaling server we use. The name is only a claim, like
// any name: a petname wins, and the safety number is what proves who it is.

export const PREFIX = 'rcp1.'
export const CARD_MAX = 2048
const JSON_MAX = 4096
export const CERTS_MAX = 4
const HOST_MAX = 253

export interface Card {
  v: 1
  ik: string
  certs: Cert[]
  name: string
  // Unauthenticated hint, like the name: anyone relaying the card can change it. Never trust it
  // for routing or security; only the certs are signed.
  sig_host: string
}

export class CardError extends Error {}

export const makeCard = (ik: KeyPair, certs: Cert[], name: string, host: string): Card => ({
  v: 1,
  ik: keyId(ik.pk),
  certs,
  name: cleanName(name),
  sig_host: host,
})

const deflate = async (data: Uint8Array): Promise<Uint8Array> => {
  if (typeof CompressionStream === 'undefined') return storeRaw(data)
  try {
    const stream = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return storeRaw(data)
  }
}

const inflate = async (data: Uint8Array): Promise<Uint8Array> => {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const stream = new Blob([data as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'))
      const out = new Uint8Array(await new Response(stream).arrayBuffer())
      if (out.length > JSON_MAX) throw new CardError('too large')
      return out
    } catch (e) {
      if (e instanceof CardError) throw e
    }
  }
  return inflateRaw(data, JSON_MAX)
}

export const encodeCard = async (card: Card): Promise<string> => {
  const text = PREFIX + b64u(await deflate(canonicalBytes(card)))
  if (text.length > CARD_MAX) throw new CardError('Contact card is too large')
  return text
}

export const BAD_CARD = "That isn't a valid P2P contact code"

// Checks shape and every signature.
export const checkCard = (x: unknown): Card => {
  if (!isRecord(x)) throw new CardError(BAD_CARD)
  const keys = Object.keys(x)
  const allowed = ['v', 'ik', 'certs', 'name', 'sig_host']
  if (!keys.every(k => allowed.includes(k))) throw new CardError(BAD_CARD)
  const c = x as unknown as Card
  if (
    c.v !== 1 ||
    !isKeyId(c.ik) ||
    !Array.isArray(c.certs) ||
    c.certs.length < 1 ||
    c.certs.length > CERTS_MAX ||
    typeof c.name !== 'string' ||
    c.name !== cleanName(c.name) ||
    typeof c.sig_host !== 'string' ||
    !c.sig_host ||
    c.sig_host.length > HOST_MAX
  )
    throw new CardError(BAD_CARD)
  if (!c.certs.every(cert => verifyCert(cert, c.ik))) throw new CardError(BAD_CARD)
  if (liveCerts(c.certs, []).length === 0) throw new CardError(BAD_CARD)
  return c
}

export const decodeCard = async (text: string): Promise<Card> => {
  const t = text.trim()
  if (!t.startsWith(PREFIX) || t.length > CARD_MAX) throw new CardError(BAD_CARD)
  let json: unknown
  try {
    json = parseCanonicalBytes(await inflate(fromB64u(t.slice(PREFIX.length))))
  } catch {
    throw new CardError(BAD_CARD)
  }
  return checkCard(json)
}

export const looksLikeCard = (text: string) => text.trim().startsWith(PREFIX)
