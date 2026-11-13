import { SQL, type Subprocess } from 'bun'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const USAGE =
  'Usage: bun scripts/load/upgrade.ts --old <bin> --new <bin> --db sqlite|postgres [--pg-url <url>] [--check <file.sql>] [--wait <seconds>]'
const PASSWORD = 'upgrade-pass-1'

const bare = (sql: string) =>
  sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')

export function splitStatements(sql: string) {
  return sql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;[ \t]*(?:--[^\n]*)?$/m)
    .map(s => s.trim())
    .filter(s => bare(s).trim())
}

export const multiStatements = (statements: string[]) =>
  statements.filter(s => bare(s).includes(';'))

export const truthy = (value: unknown) =>
  value === true ||
  value === 1 ||
  value === 1n ||
  value === 't' ||
  value === 'true' ||
  value === '1'

export type Checked = { sql: string; rows: unknown[][] }

export function failures(results: Checked[]) {
  return results.flatMap(({ sql, rows }) => {
    if (!rows.length) return [`${sql}: no rows`]
    return rows.flatMap((row, k) =>
      truthy(row[0]) ? [] : [`${sql}: row ${k + 1} is ${JSON.stringify(row.map(String))}`]
    )
  })
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// `--wait`: whole seconds from 0 to 86400, 0 when it is not given. `null` for anything else.
export const waitSeconds = (raw: string | undefined) => {
  if (raw === undefined) return 0
  const seconds = /^\d+$/.test(raw) ? Number(raw) : -1
  return seconds >= 0 && seconds <= 86_400 ? seconds : null
}

// Runs `check` every second until nothing fails or `waitMs` has passed. The last results.
export async function checkUntil(
  check: () => Promise<Checked[]>,
  waitMs: number,
  pause: (ms: number) => Promise<void> = sleep,
  now: () => number = Date.now
) {
  const until = now() + waitMs
  for (;;) {
    const results = await check()
    if (!failures(results).length || now() >= until) return results
    await pause(1000)
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })

type Server = { proc: Subprocess; logs: string[] }
const alive = (proc: Subprocess) => proc.exitCode === null && proc.signalCode === null

function tail(logs: string[]) {
  return logs
    .map(path => {
      const text = (() => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return ''
        }
      })()
      return `--- ${path}\n${text.split('\n').slice(-30).join('\n')}`
    })
    .join('\n')
}

// The API base of the server at `base` from its discovery document: `/api/v1` when it lists v1,
// else `/api` (builds from before API versions).
export const apiBaseOf = (base: string, doc: unknown) => {
  const versions: unknown = (doc as { api_versions?: unknown } | null)?.api_versions
  return base + (Array.isArray(versions) && versions.includes('v1') ? '/api/v1' : '/api')
}

const apiOf = async (base: string) =>
  apiBaseOf(base, await (await fetch(base + '/api/instance')).json())

async function call<T>(api: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(api + path, {
    method: body !== undefined ? 'POST' : 'GET',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${path}: ${r.status} ${text.slice(0, 200)}`)
  return JSON.parse(text) as T
}

function expect(ok: boolean, what: string) {
  if (!ok) throw new Error(what)
}

type Auth = { token: string }
type Msg = { id: number; content: string }
type Seeded = { alice: string; bob: string; channel: number; root: number; dm: number }

async function seed(api: string): Promise<Seeded> {
  const register = (username: string) =>
    call<Auth>(api, '/auth/register', undefined, {
      username,
      password: PASSWORD,
      avatar_kind: 'identicon',
    })
  const alice = (await register('alice')).token
  const bob = (await register('bob')).token
  await call(api, '/servers', alice, { name: 'upgrade' })
  const channel = (
    await call<{ id: number }>(api, '/servers/upgrade/channels', alice, { name: 'notes' })
  ).id
  await call(api, '/servers/upgrade/join', bob, {})
  const root = (
    await call<Msg>(api, `/channels/${channel}/messages`, alice, { content: 'upgrade root' })
  ).id
  await call(api, `/channels/${channel}/messages`, bob, { content: 'upgrade second' })
  await call(api, `/messages/${root}/thread`, bob, { content: 'upgrade thread reply' })
  const dm = (await call<{ id: number }>(api, '/dms', alice, { username: 'bob' })).id
  await call(api, `/dms/${dm}/messages`, alice, { content: 'upgrade dm' })
  await call(api, `/dms/${dm}/messages`, bob, { content: 'upgrade dm reply' })
  return { alice, bob, channel, root, dm }
}

async function readBack(api: string, s: Seeded) {
  const ready = await call<{ ok: boolean }>(api, '/ready')
  expect(ready.ok, '/ready is not ok')
  const me = await call<{ username: string; servers: { name: string }[] }>(api, '/me', s.alice)
  expect(me.username === 'alice', `/me is ${me.username}`)
  expect(
    me.servers.some(server => server.name === 'upgrade'),
    '/me lacks the upgrade server'
  )
  const has = (msgs: Msg[], ...want: string[]) => want.every(w => msgs.some(m => m.content === w))
  const history = await call<Msg[]>(api, `/channels/${s.channel}/messages`, s.alice)
  expect(has(history, 'upgrade root', 'upgrade second'), 'channel history lost messages')
  const thread = await call<Msg[]>(api, `/messages/${s.root}/thread`, s.alice)
  expect(has(thread, 'upgrade thread reply'), 'the thread reply is missing')
  const dm = await call<Msg[]>(api, `/dms/${s.dm}/messages`, s.bob)
  expect(has(dm, 'upgrade dm', 'upgrade dm reply'), 'DM history lost messages')
  await call<Auth>(api, '/auth/login', undefined, { username: 'bob', password: PASSWORD })
}

async function runCheck(db: 'sqlite' | 'postgres', target: string, statements: string[]) {
  const results: Checked[] = []
  if (db === 'sqlite') {
    const conn = new Database(target)
    for (const sql of statements)
      results.push({ sql, rows: conn.query(sql).values() as unknown[][] })
    conn.close()
  } else {
    const conn = new SQL(target)
    try {
      for (const sql of statements) {
        const rows = (await conn.unsafe(sql).values()) as unknown[][]
        if (Array.isArray(rows[0]?.[0]))
          throw new Error(`${sql}: nested rows (more than one statement or an array first column)`)
        results.push({ sql, rows })
      }
    } finally {
      await conn.close()
    }
  }
  return results
}

async function main() {
  const { values } = parseArgs({
    options: {
      old: { type: 'string' },
      new: { type: 'string' },
      db: { type: 'string' },
      'pg-url': { type: 'string' },
      check: { type: 'string' },
      wait: { type: 'string' },
    },
  })
  const { old: oldBin, new: newBin, db, 'pg-url': pgUrl, check } = values
  const wait = waitSeconds(values.wait)
  if (
    !oldBin ||
    !newBin ||
    wait === null ||
    (db !== 'sqlite' && db !== 'postgres') ||
    (db === 'postgres' && !pgUrl)
  ) {
    console.error(USAGE)
    process.exit(2)
  }
  const statements = check ? splitStatements(readFileSync(check, 'utf8')) : []
  const multi = multiStatements(statements)
  if (multi.length) {
    for (const sql of multi) console.error(`Check file: one statement per chunk: ${sql}`)
    process.exit(2)
  }
  const dir = mkdtempSync(join(tmpdir(), 'rchat-upgrade-'))
  const scratch = `rchat_upgrade_${process.pid}_${Date.now()}`
  const admin = db === 'postgres' && pgUrl ? new SQL(pgUrl) : null
  let target = join(dir, 'rchat.db')
  if (admin && pgUrl) {
    const url = new URL(pgUrl)
    url.pathname = '/' + scratch
    target = url.toString()
  }
  const [port, nextPort] = [await freePort(), await freePort()]
  const base = `http://127.0.0.1:${port}`
  const env = {
    DATABASE_URL: target,
    HOST: '127.0.0.1',
    SERVER_PORT: String(port),
    PORT: String(nextPort),
    APP_MODE: 'api-only',
    RUST_LOG: 'warn',
  }
  const servers: Server[] = []
  const start = async (bin: string, label: string) => {
    const logs = [join(dir, `${label}.out.log`), join(dir, `${label}.err.log`)]
    const proc = Bun.spawn([bin.includes('/') ? resolve(bin) : bin], {
      cwd: dir,
      env,
      stdout: Bun.file(logs[0]),
      stderr: Bun.file(logs[1]),
    })
    const server = { proc, logs }
    servers.push(server)
    const until = Date.now() + 180_000
    while (Date.now() < until) {
      if (!alive(proc))
        throw new Error(`${label} exited with ${proc.exitCode ?? proc.signalCode}\n${tail(logs)}`)
      const r = await fetch(base + '/api/ready').catch(() => null)
      if (r?.status === 200) return server
      await sleep(250)
    }
    throw new Error(`${label} was not ready within 180s\n${tail(logs)}`)
  }
  const stop = async ({ proc }: Server) => {
    proc.kill('SIGTERM')
    const exited = await Promise.race([proc.exited, sleep(30_000).then(() => null)])
    if (exited === null) {
      proc.kill('SIGKILL')
      await proc.exited
    }
  }
  let code = 0
  try {
    if (admin) await admin.unsafe(`CREATE DATABASE ${scratch}`)
    const old = await start(oldBin, 'old')
    const seeded = await seed(await apiOf(base))
    await stop(old)
    await stop(await start(newBin, 'new-1'))
    const second = await start(newBin, 'new-2')
    await readBack(await apiOf(base), seeded)
    const waited = wait ? await checkUntil(() => runCheck(db, target, statements), wait * 1000) : []
    await stop(second)
    if (check) {
      const results = wait ? waited : await runCheck(db, target, statements)
      for (const { sql, rows } of results)
        console.log(`${sql}\n  -> ${JSON.stringify(rows.map(r => r.map(String)))}`)
      const failed = failures(results)
      if (failed.length) throw new Error('Check failed:\n' + failed.join('\n'))
    }
    console.log(`upgrade ok: db=${db} old=${oldBin} new=${newBin}${check ? ` check=${check}` : ''}`)
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e))
    console.error(`Logs: ${dir}`)
    code = 1
  } finally {
    for (const server of servers) if (alive(server.proc)) await stop(server)
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => null)
      await admin.close()
    }
    if (!code) rmSync(dir, { recursive: true, force: true })
  }
  process.exit(code)
}

if (import.meta.main) await main()
