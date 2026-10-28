import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { hashBlob, Sha256, validSha256 } from '../sha256'
import { audioHint, downloadName, guessKind, kindOf, NEUTRAL_TYPE, safeType, sniff } from '../sniff'

const enc = (s: string) => new TextEncoder().encode(s)
const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap(p => (typeof p === 'string' ? [...enc(p)] : p)))

describe('sha256', () => {
  test('matches known digests', () => {
    expect(new Sha256().hex()).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
    expect(new Sha256().update(enc('abc')).hex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  test('gives the same digest however the input is split', async () => {
    const data = new Uint8Array(200_003)
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 7 + 3) % 256
    const want = createHash('sha256').update(data).digest('hex')
    for (const step of [1, 63, 64, 65, 4096, 100_000]) {
      const sha = new Sha256()
      for (let at = 0; at < data.length; at += step) sha.update(data.subarray(at, at + step))
      expect(sha.hex()).toBe(want)
    }
    expect(await hashBlob(new Blob([data]))).toBe(want)
    for (const n of [55, 56, 57, 63, 64, 119, 120]) {
      const d = data.subarray(0, n)
      expect(new Sha256().update(d).hex()).toBe(createHash('sha256').update(d).digest('hex'))
    }
  })

  test('only lowercase 64-character hex is a valid hash', () => {
    expect(validSha256('ab'.repeat(32))).toBe(true)
    expect(validSha256('AB'.repeat(32))).toBe(false)
    expect(validSha256('ab'.repeat(31))).toBe(false)
    expect(validSha256(null)).toBe(false)
  })
})

describe('sniffing received bytes', () => {
  test('recognizes the passive image, video and audio types', () => {
    const cases: [Uint8Array, string][] = [
      [bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), 'image/png'],
      [bytes([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
      [bytes('GIF89a', [1, 0]), 'image/gif'],
      [bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '), 'image/webp'],
      [bytes([0, 0, 0, 0x1c], 'ftypavif'), 'image/avif'],
      [bytes([0, 0, 0, 0x20], 'ftypisom'), 'video/mp4'],
      [
        bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0x82, 0x84], 'webm'),
        'video/webm',
      ],
      [bytes('OggS', [0, 2]), 'audio/ogg'],
      [bytes('ID3', [4, 0]), 'audio/mpeg'],
      [bytes([0xff, 0xfb, 0x90, 0x64]), 'audio/mpeg'],
      [bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt '), 'audio/wav'],
    ]
    for (const [head, mime] of cases) {
      expect(sniff(head)?.mime).toBe(mime)
      expect(safeType(head)).toBe(mime)
      expect(kindOf(mime) === null).toBe(false)
    }
    const webm = cases[6][0]
    expect(sniff(webm, true)).toEqual({ mime: 'audio/webm', kind: 'audio' })
  })

  test('anything else is neutral, whatever its name or declared type', () => {
    for (const head of [
      enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      enc('<?xml version="1.0"?><svg/>'),
      enc('<!doctype html><script>alert(1)</script>'),
      enc('%PDF-1.7'),
      bytes([0, 0, 0, 0x18], 'ftypqt  '),
      bytes([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88], 'matroska'),
      bytes('RIFF', [0, 0, 0, 0], 'AVI '),
      bytes([0x89, 0x50, 0x4e]),
      new Uint8Array(0),
    ]) {
      expect(sniff(head)).toBeNull()
      expect(safeType(head)).toBe(NEUTRAL_TYPE)
    }
    expect(kindOf('image/svg+xml')).toBeNull()
    expect(kindOf('text/html')).toBeNull()
    expect(kindOf('__proto__')).toBeNull()
  })

  test('names only hint what might be previewed', () => {
    expect(guessKind('a.PNG')).toBe('image')
    expect(guessKind('a.svg')).toBeNull()
    expect(guessKind('clip.webm')).toBe('video')
    expect(guessKind('song.mp3')).toBe('audio')
    expect(guessKind('noext')).toBeNull()
    expect(audioHint('x.weba', null)).toBe(true)
    expect(audioHint('x.webm', 'audio/webm')).toBe(true)
    expect(audioHint('x.webm', 'video/webm')).toBe(false)
  })

  test('download names lose paths, control and direction characters', () => {
    expect(downloadName('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(downloadName('a\u202egnp.exe')).toBe('a_gnp.exe')
    expect(downloadName('C:\\x\\y.txt')).toBe('C__x_y.txt')
    expect(downloadName('...')).toBe('download')
    expect(downloadName('ok name.png')).toBe('ok name.png')
    const long = `${'x'.repeat(300)}.pdf`
    expect(downloadName(long).length).toBe(120)
    expect(downloadName(long).endsWith('.pdf')).toBe(true)
  })
})
