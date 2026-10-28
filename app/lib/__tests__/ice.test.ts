import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { iceConfig } from '../ice'

const sources = () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(path)
      } else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path)
    }
  }
  walk(root)
  return files.map(f => ({ f, src: readFileSync(f, 'utf8') }))
}

describe('ICE config', () => {
  test('the instance advertises no ICE servers yet', () => {
    expect(iceConfig()).toEqual({ iceServers: [] })
    expect(iceConfig() === iceConfig()).toBe(false)
  })

  test('every peer connection uses the instance ICE config', () => {
    const files = sources()
    expect(files.length > 20).toBe(true)
    const rel = (f: string) => f.slice(f.lastIndexOf('/') + 1)
    const outside = files.filter(
      ({ f, src }) => /\bRTCPeerConnection\b/.test(src) && !/\/(rtc|ice)\.ts$/.test(f)
    )
    expect(outside.map(o => rel(o.f))).toEqual([])
    const peerjs = files.filter(({ src }) => /from\s+['"]peerjs['"]/.test(src))
    expect(peerjs.map(o => rel(o.f))).toEqual(['p2p.ts'])
    const rtc = files.find(({ f }) => f.endsWith('/rtc.ts'))
    const p2p = files.find(({ f }) => f.endsWith('/p2p.ts'))
    expect(
      /new\s+(?:window\.)?\w*RTCPeerConnection\s*\(\s*iceConfig\(\)\s*\)/.test(rtc?.src ?? '')
    ).toBe(true)
    const peers = [...(p2p?.src ?? '').matchAll(/new\s+Peer\s*\(([^;]*?)\)\s*(?:\n|;|$)/g)]
    expect(peers.length > 0).toBe(true)
    expect(peers.filter(m => !/\bconfig\s*:\s*iceConfig\(\s*\)/.test(m[1]))).toEqual([])
  })
})
