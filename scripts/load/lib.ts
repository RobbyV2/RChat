import { $ } from 'bun'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PASSWORD = 'load-pass-1'

export function need(name: string) {
  const value = process.env[name]
  if (!value) {
    console.error(`Set ${name}`)
    process.exit(2)
  }
  return value
}

let base: string | undefined
export const baseUrl = () => (base ??= need('BASE').replace(/\/+$/, ''))
export const baseWs = () => baseUrl().replace(/^http/, 'ws') + '/api/v1/ws'
const wsUrl = () => process.env.WS_BASE ?? baseWs()
export const serverPid = () => Number(process.env.SERVER_PID ?? 0)

export const uname = (i: number) => 'u' + String(i).padStart(5, '0')
export const tok = (i: number) => 'tok-' + uname(i)
const ip = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`

export function pct(xs: number[], p: number) {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

export function stats(name: string, xs: number[], extra = '') {
  const tail = [extra, load()].filter(Boolean).join(' ')
  if (!xs.length) return `${name}: n=0 ${tail}`
  const f = (n: number) => n.toFixed(1)
  return `${name}: n=${xs.length} p50=${f(pct(xs, 50))}ms p99=${f(pct(xs, 99))}ms max=${f(Math.max(...xs))}ms ${tail}`
}

export function load() {
  return 'load=' + readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')
}

export function proc(pid: number) {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
    return { cpu: (Number(st[11]) + Number(st[12])) / 100, rss: Number(st[21]) * 4096 }
  } catch {
    return { cpu: NaN, rss: NaN }
  }
}

export function usage() {
  const p = proc(serverPid())
  return `srv_cpu=${p.cpu.toFixed(1)}s rss=${(p.rss / 1048576).toFixed(0)}MiB`
}

export const snap = () => `${load()} ${usage()}`

const lines: string[] = []
export function log(line: string) {
  console.log(line)
  lines.push(line)
}
export function header(script: string) {
  log(`# ${script} ${new Date().toISOString()} base=${baseUrl()} ws=${wsUrl()} ${snap()}`)
}
export function finish(code = 0): never {
  const out = process.env.OUT
  if (out) appendFileSync(out, lines.join('\n') + '\n')
  process.exit(code)
}

type Reply = { status: number; ms: number; text: string; bytes: number; headers: Headers }

export async function req(
  path: string,
  opts: { i?: number; method?: string; body?: unknown; ipn?: number } = {}
): Promise<Reply> {
  const headers: Record<string, string> = { 'X-Forwarded-For': ip(opts.ipn ?? opts.i ?? 0) }
  if (opts.i !== undefined) headers.Authorization = 'Bearer ' + tok(opts.i)
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const t0 = performance.now()
  const r = await fetch(baseUrl() + '/api/v1' + path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await r.text()
  return {
    status: r.status,
    ms: performance.now() - t0,
    text,
    bytes: text.length,
    headers: r.headers,
  }
}

export const json = <T>(reply: Reply) => JSON.parse(reply.text) as T

export async function channels(server = 'big', i = 5) {
  return json<{ channels: { id: number }[] }>(await req(`/servers/${server}`, { i })).channels.map(
    c => c.id
  )
}

type WsEvent = {
  type?: string
  username?: string
  online?: boolean
  message?: { content?: string }
}

export type Sock = {
  i: number
  ws: WebSocket
  frames: number
  bytes: number
  onFrame?: (ev: WsEvent, at: number) => void
}

export function openSock(
  i: number,
  view: string | null,
  url = wsUrl()
): Promise<{ sock: Sock; ms: number; readyMs: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const ws = new WebSocket(url, { headers: { 'X-Forwarded-For': ip(i) } })
    const sock: Sock = { i, ws, frames: 0, bytes: 0 }
    let openMs = 0
    let done = false
    const timer = setTimeout(() => {
      if (!done) reject(new Error('ws timeout ' + i))
    }, 60000)
    const ready = (readyMs: number) => {
      done = true
      clearTimeout(timer)
      resolve({ sock, ms: openMs, readyMs })
    }
    ws.onopen = () => {
      openMs = performance.now() - t0
      ws.send(JSON.stringify({ type: 'auth', token: tok(i) }))
      if (view) ws.send(JSON.stringify({ type: 'viewing', server: view }))
      else ready(openMs)
    }
    ws.onmessage = m => {
      const at = performance.now()
      const data = typeof m.data === 'string' ? m.data : ''
      sock.frames++
      sock.bytes += data.length
      let ev: WsEvent
      try {
        ev = JSON.parse(data) as WsEvent
      } catch {
        return
      }
      if (!done && ev.type === 'presence_snapshot') ready(at - t0)
      sock.onFrame?.(ev, at)
    }
    ws.onerror = () => {
      if (!done) reject(new Error('ws error ' + i))
    }
    ws.onclose = c => {
      if (!done) reject(new Error(`ws close ${i} ${c.code} ${c.reason}`))
    }
  })
}

export async function openMany(ids: number[], view: string | null, conc = 100) {
  const socks: Sock[] = []
  const ready: number[] = []
  let fail = 0
  await pool(ids, conc, async i => {
    try {
      const r = await openSock(i, view)
      socks.push(r.sock)
      ready.push(r.readyMs)
    } catch (e) {
      fail++
      if (fail < 5) console.error(String(e))
    }
  })
  return { socks, ready, fail }
}

export async function pool<T>(items: T[], n: number, fn: (x: T, k: number) => Promise<void>) {
  let k = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (k < items.length) {
        const my = k++
        await fn(items[my], my)
      }
    })
  )
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function psql(sql: string) {
  const container = need('PG_CONTAINER')
  return (await $`docker exec ${container} psql -U postgres -At -F ${'|'} -c ${sql}`.text()).trim()
}
const own = "query NOT ILIKE '%pg_stat_statements%'"
export const resetStatements = () => psql('SELECT pg_stat_statements_reset()')
export const statements = async () =>
  Number(await psql(`SELECT COALESCE(sum(calls), 0) FROM pg_stat_statements WHERE ${own}`))
export const topStatements = () =>
  psql(
    `SELECT calls, round(total_exec_time::numeric, 1), rows, left(regexp_replace(query, '\\s+', ' ', 'g'), 150) FROM pg_stat_statements WHERE ${own} ORDER BY calls DESC, total_exec_time DESC LIMIT 12`
  )

export function findChrome(browsers: string) {
  if (!existsSync(browsers)) return null
  const revisions = readdirSync(browsers)
    .filter(dir => /^chromium-\d+$/.test(dir))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  for (const dir of revisions)
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const path = join(browsers, dir, sub, 'chrome')
      if (existsSync(path)) return path
    }
  return null
}
