import {
  PASSWORD,
  baseWs,
  channels,
  finish,
  header,
  json,
  load,
  log,
  openMany,
  openSock,
  pct,
  pool,
  proc,
  req,
  serverPid,
  sleep,
  snap,
  stats,
  uname,
  usage,
  type Sock,
} from './lib'

const PHASES = (process.env.PHASES || 'login,ready,storm,presence,send,members,search,unreads')
  .split(',')
  .map(p => p.trim())
const SOCKETS = Number(process.env.SOCKETS ?? 1000)

async function phaseLogin() {
  for (const [conc, start] of [
    [1, 3000],
    [8, 3100],
    [32, 3300],
  ]) {
    const ids = Array.from({ length: conc === 1 ? 40 : 160 }, (_, k) => start + k)
    const ms: number[] = []
    let bad = 0
    const t0 = performance.now()
    await pool(ids, conc, async i => {
      const r = await req('/auth/login', {
        body: { username: uname(i), password: PASSWORD },
        ipn: 40000 + i,
      })
      if (r.status !== 200) bad++
      ms.push(r.ms)
    })
    const rate = ids.length / ((performance.now() - t0) / 1000)
    log(stats(`login conc=${conc}`, ms, `fail=${bad} rate=${rate.toFixed(0)}/s ${usage()}`))
  }
  const codes: Record<number, number> = {}
  await pool(
    Array.from({ length: 60 }, (_, k) => 4800 + k),
    8,
    async i => {
      const r = await req('/auth/login', {
        body: { username: uname(i), password: PASSWORD },
        ipn: 99999,
      })
      codes[r.status] = (codes[r.status] ?? 0) + 1
    }
  )
  log(`login 60 from one address: codes=${JSON.stringify(codes)} ${snap()}`)
}

type Me = { servers_more: boolean; servers_cursor: string | null }
type Ready = {
  me: number
  meBytes: number
  serversMs: number
  pages: number
  bytes: number
  unreads: number
  unBytes: number
  unItems: number
  ws: number
}

async function readySet(i: number): Promise<Ready> {
  const me = await req('/me', { i })
  let bytes = me.bytes
  let pages = 1
  let { servers_more: more, servers_cursor: cursor } = json<Me>(me)
  const t0 = performance.now()
  while (more && cursor && pages <= 20) {
    const r = await req('/me/servers?cursor=' + encodeURIComponent(cursor), { i })
    bytes += r.bytes
    pages++
    cursor = r.headers.get('x-next-cursor')
    more = !!cursor
  }
  const serversMs = performance.now() - t0
  const un = await req('/unreads', { i })
  const ws = await openSock(i, 'big')
  ws.sock.ws.close()
  return {
    me: me.ms,
    meBytes: me.bytes,
    serversMs,
    pages,
    bytes,
    unreads: un.ms,
    unBytes: un.bytes,
    unItems: json<{ items: unknown[] }>(un).items.length,
    ws: ws.readyMs,
  }
}

async function phaseReady() {
  for (const [label, base] of [
    ['heavy (200 servers)', 0],
    ['light (big + ~2)', 2000],
  ] as const) {
    const rs: Ready[] = []
    for (let k = 0; k < 20; k++) rs.push(await readySet(base + k))
    const f = (key: keyof Ready) => rs.map(r => r[key])
    log(`ready ${label} sequential:`)
    log('  ' + stats('GET /me', f('me'), `bytes=${rs[0].meBytes}`))
    log(
      '  ' +
        stats(
          '/me/servers paging',
          f('serversMs'),
          `pages=${rs[0].pages} total_bytes=${rs[0].bytes}`
        )
    )
    log('  ' + stats('GET /unreads', f('unreads'), `bytes=${rs[0].unBytes} items=${rs[0].unItems}`))
    log('  ' + stats('WS open+auth+viewing->presence_snapshot', f('ws'), usage()))
  }
  const t0 = performance.now()
  const rs = await Promise.all(Array.from({ length: 50 }, (_, k) => readySet(50 + k)))
  log(`ready heavy x50 concurrent: wall=${(performance.now() - t0).toFixed(0)}ms ${load()}`)
  log(
    '  ' +
      stats(
        'GET /me',
        rs.map(r => r.me)
      )
  )
  log(
    '  ' +
      stats(
        'GET /unreads',
        rs.map(r => r.unreads)
      )
  )
  log(
    '  ' +
      stats(
        'WS ready',
        rs.map(r => r.ws),
        usage()
      )
  )
}

const socks: Sock[] = []

async function phaseStorm() {
  const before = proc(serverPid())
  const t0 = performance.now()
  const ids = Array.from({ length: SOCKETS }, (_, k) => 1000 + k)
  const opened = await openMany(ids, 'big')
  socks.push(...opened.socks)
  const wall = performance.now() - t0
  await sleep(3000)
  const frames = socks.reduce((a, s) => a + s.frames, 0)
  const bytes = socks.reduce((a, s) => a + s.bytes, 0)
  const after = proc(serverPid())
  log(
    stats(
      `storm: ${SOCKETS} sockets (100 at a time) open+auth+viewing big -> snapshot`,
      opened.ready,
      `wall=${wall.toFixed(0)}ms fail=${opened.fail}`
    )
  )
  log(
    `  frames received during storm: ${frames} (${(bytes / 1048576).toFixed(1)} MiB) server_cpu=${(after.cpu - before.cpu).toFixed(1)}s ${snap()}`
  )
}

function needSockets(phase: string) {
  if (socks.length) return
  log(`${phase}: no sockets open`)
  finish(1)
}

async function phasePresence() {
  needSockets('presence')
  const lat: number[] = []
  const slowest: number[] = []
  for (let k = 0; k < 15; k++) {
    const who = uname(2600 + k)
    const seen: number[] = []
    let t0 = 0
    for (const s of socks)
      s.onFrame = (ev, at) => {
        if (ev.type === 'presence_changed' && ev.username === who && ev.online) seen.push(at - t0)
      }
    t0 = performance.now()
    const r = await openSock(2600 + k, 'big', baseWs())
    const deadline = performance.now() + 10000
    while (seen.length < socks.length && performance.now() < deadline) await sleep(20)
    lat.push(...seen)
    slowest.push(pct(seen, 100))
    r.sock.ws.close()
    await sleep(300)
  }
  for (const s of socks) s.onFrame = undefined
  log(
    stats(
      `presence: one user online -> presence_changed at ${socks.length} viewers (15 users)`,
      lat,
      `slowest-receiver p50=${pct(slowest, 50).toFixed(1)}ms ${usage()}`
    )
  )
}

async function phaseSend() {
  needSockets('send')
  const cid = (await channels())[0]
  for (const [label, senders, msgs, gap] of [
    ['single sender 2/s', 1, 40, 500],
    ['20 senders burst', 20, 5, 0],
  ] as const) {
    const sentAt = new Map<string, number>()
    const lat: number[] = []
    for (const s of socks)
      s.onFrame = (ev, at) => {
        const t = ev.type === 'message' ? sentAt.get(ev.message?.content ?? '') : undefined
        if (t !== undefined) lat.push(at - t)
      }
    const post: number[] = []
    const before = proc(serverPid())
    const t0 = performance.now()
    await Promise.all(
      Array.from({ length: senders }, async (_, sdx) => {
        for (let m = 0; m < msgs; m++) {
          const content = `probe ${label} ${sdx} ${m} ${Math.random()}`
          sentAt.set(content, performance.now())
          const r = await req(`/channels/${cid}/messages`, { i: 1 + sdx, body: { content } })
          if (r.status !== 200) console.error('send', r.status, r.text.slice(0, 200))
          post.push(r.ms)
          if (gap) await sleep(gap)
        }
      })
    )
    const want = senders * msgs * socks.length
    const deadline = performance.now() + 20000
    while (lat.length < want && performance.now() < deadline) await sleep(50)
    const after = proc(serverPid())
    log(`send ${label} (${senders * msgs} msgs to big/#chan-000, ${socks.length} sockets):`)
    log('  ' + stats('POST /channels/{id}/messages', post))
    log(
      '  ' +
        stats(
          'send->delivery (all receivers)',
          lat,
          `delivered=${lat.length}/${want} wall=${(performance.now() - t0).toFixed(0)}ms server_cpu=${(after.cpu - before.cpu).toFixed(2)}s ${usage()}`
        )
    )
  }
  for (const s of socks) s.onFrame = undefined
}

async function phaseMembers() {
  const lat: number[] = []
  let cursor: string | null = null
  let pages = 0
  let rows = 0
  do {
    const page = cursor ? '&cursor=' + encodeURIComponent(cursor) : ''
    const r = await req('/servers/big/members?limit=50' + page, { i: 3 })
    lat.push(r.ms)
    rows += json<unknown[]>(r).length
    cursor = r.headers.get('x-next-cursor')
    pages++
  } while (cursor && pages < 200)
  log(
    stats(
      `members big: full walk ${pages} pages (${rows} rows), ${socks.length} online`,
      lat,
      usage()
    )
  )
  const off: number[] = []
  for (const o of [0, 1000, 2500, 4900])
    off.push((await req(`/servers/big/members?limit=50&offset=${o}`, { i: 3 })).ms)
  log(`  offset paging 0/1000/2500/4900: ${off.map(x => x.toFixed(1)).join(' / ')} ms ${load()}`)
}

async function phaseSearch() {
  const qs = [
    'kubernetes',
    'rollback hotfix',
    '#s4242',
    '#599999',
    'zzzqqq',
    'ab',
    'pager oncall retro',
  ]
  for (const [who, i] of [
    ['heavy', 0],
    ['light', 2000],
  ] as const) {
    for (const q of qs) {
      const ms: number[] = []
      let hits = 0
      for (let k = 0; k < 8; k++) {
        const r = await req('/search?q=' + encodeURIComponent(q), { i: i + k })
        ms.push(r.ms)
        if (r.status === 200) hits = json<unknown[]>(r).length
      }
      log(stats(`search ${who} q="${q}"`, ms, `hits=${hits}`))
    }
    const scoped: number[] = []
    for (let k = 0; k < 8; k++)
      scoped.push((await req('/search?server=big&q=kubernetes', { i: i + k })).ms)
    log(stats(`search ${who} server=big q=kubernetes`, scoped, usage()))
  }
}

async function phaseUnreads() {
  for (const [who, base] of [
    ['heavy (200 servers, ~1095 channels)', 0],
    ['light', 2000],
  ] as const) {
    const ms: number[] = []
    for (let k = 0; k < 40; k++) ms.push((await req('/unreads', { i: base + (k % 20) })).ms)
    log(stats(`unreads ${who} sequential`, ms, usage()))
    const conc: number[] = []
    await Promise.all(
      Array.from({ length: 50 }, async (_, k) =>
        conc.push((await req('/unreads', { i: base + k })).ms)
      )
    )
    log(stats(`unreads ${who} 50 concurrent`, conc, usage()))
  }
}

const phases: Record<string, () => Promise<void>> = {
  login: phaseLogin,
  ready: phaseReady,
  storm: phaseStorm,
  presence: phasePresence,
  send: phaseSend,
  members: phaseMembers,
  search: phaseSearch,
  unreads: phaseUnreads,
}

export function phaseError(list: string[]) {
  const unknown = list.find(p => !Object.hasOwn(phases, p))
  if (unknown !== undefined) return `Unknown phase ${unknown}`
  for (const p of ['presence', 'send'])
    if (list.includes(p) && !list.slice(0, list.indexOf(p)).includes('storm'))
      return `${p} needs storm earlier in PHASES`
  return null
}

async function main() {
  const error = phaseError(PHASES)
  if (error) {
    console.error(error)
    process.exit(2)
  }
  header(`run phases=${PHASES.join(',')}`)
  for (const p of PHASES) {
    const t0 = performance.now()
    await phases[p]()
    log(`-- phase ${p} took ${((performance.now() - t0) / 1000).toFixed(1)}s ${load()}`)
  }
  for (const s of socks) s.ws.close()
  finish()
}

if (import.meta.main) await main()
