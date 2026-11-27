import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

// The search rows of a sealed room or DM hold no words: each is HMAC-SHA256 under this device's
// search key of the room and the word, cut to 16 bytes, named with the device key it came from.
// A query word as long as `exact` or shorter matches whole words only, a longer one any word it
// starts, so a word longer than `exact` is held as each of its starts longer than `exact`.
export interface Keyed {
  // The rows a word is held as.
  rows(room: string, word: string): string[]
  // The row a query word looks for.
  row(room: string, word: string): string
}

// Every keyed row starts with this, which no word holds.
export const KEYED_MARK = '#'

const utf8 = new TextEncoder()

export function keyedWords(key: Uint8Array, keyId: number, exact: number): Keyed {
  const row = (room: string, word: string) =>
    `${KEYED_MARK}${keyId}.${bytesToHex(hmac(sha256, key, utf8.encode(`${room}\0${word}`)).subarray(0, 16))}`
  return {
    row,
    rows(room, word) {
      if (word.length <= exact) return [row(room, word)]
      const out: string[] = []
      let start = ''
      for (const ch of word) {
        start += ch
        if (start.length > exact) out.push(row(room, start))
      }
      return out
    },
  }
}
