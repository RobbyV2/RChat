// Rebuilds assets/stun_servers.json from the always-online-stun list: hostnames only, one
// per operator, each answering a real STUN Binding request within 2 s. Well-known,
// long-lived operators from PREFERRED come first; the rest is filled in a stable hash order.
// Run with `just src refresh-stun` and commit the result. The server never fetches anything
// at runtime.
import { createHash, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = 'https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_hosts.txt'
const MAX = 12
const TIMEOUT_MS = 2000
const OUT = fileURLToPath(new URL('./stun_servers.json', import.meta.url))
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ne', 'or'])
const USER_AGENT = 'rchat-dev-check'

// Operators that run STUN as part of a large, long-lived product, in order. Only entries
// that are in the upstream list and answer are used.
const PREFERRED = [
  'stun.l.google.com:19302',
  'stun.nextcloud.com:3478',
  'stun.voip.blackberry.com:3478',
  'stun.linphone.org:3478',
  'stun.freeswitch.org:3478',
  'stun.threema.ch:3478',
  'stun.t-online.de:3478',
  'stun.telnyx.com:3478',
]

// Domains run by the same organisation, so the list does not spend two slots on one operator.
const SAME_ORG: Record<string, string[]> = {
  aaisp: ['aa.net.uk', 'aaisp.co.uk'],
  'united-internet': ['1und1.de', 'gmx.de', 'gmx.net', 'schlund.de'],
  sonetel: ['sonetel.com', 'sonetel.net'],
  ippi: ['ippi.com', 'ippi.fr'],
  sipnet: ['sipnet.com', 'sipnet.net'],
  betamax: [
    '12voip.com',
    'actionvoip.com',
    'cheapvoip.com',
    'easyvoip.com',
    'freecall.com',
    'freevoipdeal.com',
    'internetcalls.com',
    'intervoip.com',
    'jumblo.com',
    'justvoip.com',
    'lowratevoip.com',
    'myvoiptraffic.com',
    'netappel.com',
    'nonoh.net',
    'poivy.com',
    'powervoip.com',
    'rynga.com',
    'sipdiscount.com',
    'smartvoip.com',
    'smsdiscount.com',
    'smslisto.com',
    'sparvoip.de',
    'voipbuster.com',
    'voipbusterpro.com',
    'voipcheap.com',
    'voipdiscount.com',
    'voipgain.com',
    'voipraider.com',
    'voipstunt.com',
    'voipwise.com',
    'voipzoom.com',
    'webcalldirect.com',
  ],
}
const ORG = new Map(
  Object.entries(SAME_ORG).flatMap(([org, domains]) => domains.map(d => [d, org] as const))
)

const registrable = (host: string) => {
  const labels = host.toLowerCase().split('.')
  const take = labels.length > 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2
  return labels.slice(-take).join('.')
}

const organisation = (host: string) => {
  const domain = registrable(host)
  return ORG.get(domain) ?? domain
}

const stableHash = (entry: string) => createHash('sha256').update(entry).digest('hex')

const parse = (text: string) =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      const at = line.lastIndexOf(':')
      const host = at > 0 ? line.slice(0, at) : line
      const port = at > 0 ? Number(line.slice(at + 1)) : 3478
      return isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535
        ? []
        : [{ host: host.toLowerCase(), port }]
    })

const answers = async (host: string, port: number) => {
  const { address, family } = await lookup(host).catch(() => ({ address: '', family: 4 }))
  if (!address) return false
  const socket = createSocket(family === 6 ? 'udp6' : 'udp4')
  const id = randomBytes(12)
  const request = Buffer.concat([Buffer.from([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]), id])
  return new Promise<boolean>(resolve => {
    const done = (ok: boolean) => {
      clearTimeout(timer)
      socket.close()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), TIMEOUT_MS)
    socket.on('error', () => done(false))
    socket.on('message', msg =>
      done(msg.length >= 20 && msg.readUInt16BE(0) === 0x0101 && msg.subarray(8, 20).equals(id))
    )
    socket.send(request, port, address)
  })
}

const main = async () => {
  const res = await fetch(SOURCE, { headers: { 'user-agent': USER_AGENT } })
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
  const candidates = parse(await res.text())
  const alive = await Promise.all(candidates.map(c => answers(c.host, c.port)))
  const entry = ({ host, port }: { host: string; port: number }) => `${host}:${port}`
  const live = candidates.filter((_, i) => alive[i])
  const rank = (c: { host: string; port: number }) => {
    const at = PREFERRED.indexOf(entry(c))
    return at >= 0 ? `0${String(at).padStart(4, '0')}` : `1${stableHash(entry(c))}`
  }
  const ordered = live
    .map(c => ({ ...c, rank: rank(c) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
  const seen = new Set<string>()
  const servers = ordered
    .filter(({ host }) => {
      const org = organisation(host)
      if (seen.has(org)) return false
      seen.add(org)
      return true
    })
    .slice(0, MAX)
    .map(c => `stun:${entry(c)}`)
  if (servers.length === 0) throw new Error('no STUN server answered')
  const doc = { source: SOURCE, fetched_at: new Date().toISOString(), servers }
  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`)
  const preferred = servers.filter(s => PREFERRED.includes(s.slice('stun:'.length))).length
  console.log(
    `${servers.length} servers (${preferred} preferred) from ${live.length} live of ${candidates.length} hosts; wrote ${OUT}`
  )
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
