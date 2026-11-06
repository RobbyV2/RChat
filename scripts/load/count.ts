import {
  PASSWORD,
  channels,
  finish,
  header,
  json,
  load,
  log,
  openMany,
  openSock,
  psql,
  req,
  resetStatements,
  sleep,
  topStatements,
} from './lib'

const totals = () =>
  psql(
    "SELECT COALESCE(sum(calls), 0), round(COALESCE(sum(total_exec_time), 0)::numeric, 1) FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%'"
  )

async function op(label: string, fn: () => Promise<unknown>) {
  await resetStatements()
  await fn()
  await sleep(300)
  log(`\n## ${label}: statements(calls|ms)=${await totals()} ${load()}`)
  log(await topStatements())
}

header('count')
await op('GET /me heavy', () => req('/me', { i: 5 }))
await op('GET /me/servers page heavy', async () => {
  const me = json<{ servers_cursor: string }>(await req('/me', { i: 5 }))
  await resetStatements()
  await req('/me/servers?cursor=' + encodeURIComponent(me.servers_cursor), { i: 5 })
})
await op('GET /unreads heavy', () => req('/unreads', { i: 5 }))
await op('GET /servers/big', () => req('/servers/big', { i: 5 }))
await op('GET /servers/big/members first page', () =>
  req('/servers/big/members?limit=50', { i: 5 })
)
await op('search heavy kubernetes', () => req('/search?q=kubernetes', { i: 5 }))
await op('login', () =>
  req('/auth/login', { body: { username: 'u04900', password: PASSWORD }, ipn: 777 })
)
await op('WS connect heavy user (auth + viewing big)', async () => {
  const heavy = await openSock(6, 'big')
  await sleep(500)
  heavy.sock.ws.close()
})
const viewers = await openMany(
  Array.from({ length: 200 }, (_, k) => 1000 + k),
  'big'
)
await sleep(1000)
const chans = await channels()
await op('send 1 message big/#chan-000 with 200 sockets (warm)', async () => {
  await req(`/channels/${chans[0]}/messages`, { i: 5, body: { content: 'count probe warm' } })
  await sleep(1000)
})
await op('send 1 message to a channel nobody received before (cold), 200 sockets', async () => {
  await req(`/channels/${chans[7]}/messages`, { i: 5, body: { content: 'count probe cold' } })
  await sleep(1000)
})
await op('user comes online in big with 200 viewers', async () => {
  const x = await openSock(2700, 'big')
  await sleep(800)
  x.sock.ws.close()
})
let probe = 0
await op('create a channel in big with 200 sockets', async () => {
  const r = await req('/servers/big/channels', { i: 0, body: { name: 'probe-' + Date.now() } })
  if (r.status === 200) probe = json<{ id: number }>(r).id
  else log(`create ${r.status} ${r.text.slice(0, 120)}`)
  await sleep(1500)
})
await op('member timeout in big with 200 sockets', async () => {
  const r = await req('/servers/big/timeouts/u04999', {
    i: 0,
    method: 'PUT',
    body: { seconds: 60 },
  })
  if (r.status !== 200) log(`timeout ${r.status} ${r.text.slice(0, 100)}`)
  await sleep(1500)
})
for (const s of viewers.socks) s.ws.close()
await req('/servers/big/timeouts/u04999', { i: 0, method: 'DELETE' })
if (probe) await req(`/channels/${probe}`, { i: 0, method: 'DELETE' })
finish()
