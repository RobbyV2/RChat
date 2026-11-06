import { afterAll, describe, expect, test } from 'bun:test'
import { DEFAULT_LIMITS, limitsOf, tooLargeText } from '../instance_limits'
import { resetSessionCaches, startMode, useStore } from '../store'
import type { InstanceInfo, SiteSettings } from '../types'

afterAll(resetSessionCaches)

const MIB = 1024 * 1024

const info: InstanceInfo = {
  software: 'rchat',
  id: 'abc123',
  name: 'Lobby',
  host: 'chat.example.com',
  version: '0.4.0',
  api_version: '1.1',
  public_url: 'https://chat.example.com',
  api_url: 'https://chat.example.com/api',
  ws_url: 'wss://chat.example.com/api/ws',
  peerjs_url: 'https://chat.example.com:9001/peerjs',
  instance_url: 'https://chat.example.com/api/instance',
  jwks_uri: 'https://chat.example.com/.well-known/jwks.json',
  features: { guests: true, uploads: true, previews: true, identity_assertions: true },
  limits: {
    message_chars: 4000,
    name_chars: 100,
    upload_bytes: 25 * MIB,
    media_retention_secs: 86400,
    page_size: 50,
    assertion_ttl_secs: 300,
  },
}

describe('instance limits', () => {
  test('the defaults are the values before servers sent them', () => {
    expect(DEFAULT_LIMITS).toEqual({
      message_chars: 4000,
      upload_bytes: 25 * MIB,
      reconnect_base_ms: 1000,
      reconnect_cap_ms: 30000,
      reconnect_floor_ms: 250,
      resync_jitter_ms: 10000,
      catch_up_delay_ms: 5000,
      servers_per_account: 0,
      session_max_age_secs: 0,
      session_idle_secs: 0,
    })
  })

  test('older servers and bad values give the defaults', () => {
    expect(limitsOf(null)).toEqual(DEFAULT_LIMITS)
    const bad = {
      ...info,
      limits: { message_chars: -5, upload_bytes: Number.NaN },
    } as unknown as InstanceInfo
    expect(limitsOf(bad).message_chars).toBe(4000)
    expect(limitsOf(bad).upload_bytes).toBe(25 * MIB)
    expect(
      limitsOf({ ...info, limits: { ...info.limits, message_chars: 500 } }).message_chars
    ).toBe(500)
    for (const limits of [undefined, null, 'x', { upload_bytes: '9' }, { message_chars: Infinity }])
      expect(limitsOf({ ...info, limits } as unknown as InstanceInfo)).toEqual(DEFAULT_LIMITS)
  })

  test('limits a newer server adds are read, missing ones default', () => {
    const newer = {
      ...info,
      limits: { ...info.limits, upload_bytes: MIB, servers_per_account: 1000, extra: 7 },
    } as unknown as InstanceInfo
    expect(limitsOf(newer)).toEqual({
      ...DEFAULT_LIMITS,
      message_chars: 4000,
      upload_bytes: MIB,
      servers_per_account: 1000,
    })
  })

  test('the same info gives the same limits object', () => {
    const x = { ...info, limits: { ...info.limits, message_chars: 9 } }
    expect(limitsOf(x)).toBe(limitsOf(x))
  })

  test('the upload error names the configured size', () => {
    expect(tooLargeText(25 * MIB)).toBe('File exceeds 25MB limit')
    expect(tooLargeText(MIB)).toBe('File exceeds 1MB limit')
  })

  test('picking a file follows the instance upload size', () => {
    const settings = {
      ...useStore.getState().settings,
      asset_uploads: true,
      p2p_attachments: false,
    } as SiteSettings
    expect(startMode(settings, 2 * MIB, MIB)).toBe('server')
    expect(startMode({ ...settings, p2p_attachments: true }, 2 * MIB, MIB)).toBe('p2p')
    expect(startMode({ ...settings, p2p_attachments: true }, MIB, MIB)).toBe('server')
    const file = (size: number) =>
      ({ name: 'f.bin', size, type: '', slice: () => new Blob([]) }) as unknown as File
    useStore.setState({
      settings,
      instance: { ...info, limits: { ...info.limits, upload_bytes: MIB } },
      pending: {},
      error: null,
    })
    useStore.getState().uploadFile('c1', file(2 * MIB))
    expect(useStore.getState().pending.c1).toBeUndefined()
    expect(useStore.getState().error).toBe('File exceeds 1MB limit')
    useStore.setState({ instance: null, error: null })
    useStore.getState().uploadFile('c1', file(2 * MIB))
    expect(useStore.getState().pending.c1?.mode).toBe('server')
    useStore.setState({ pending: {}, error: null })
  })
})
