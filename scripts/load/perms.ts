import {
  channels,
  finish,
  header,
  json,
  log,
  openMany,
  req,
  resetStatements,
  sleep,
  statements,
  stats,
} from './lib'

const SOCKETS = Number(process.env.SOCKETS ?? 1000)

header(`perms sockets=${SOCKETS}`)
const { socks, fail } = await openMany(
  Array.from({ length: SOCKETS }, (_, k) => 1000 + k),
  'big'
)
if (fail) log(`sockets failed to open: ${fail}`)
await sleep(3000)
const chans = await channels()

async function measure(label: string, cid: number, before?: () => Promise<unknown>) {
  if (before) await before()
  await sleep(1500)
  await resetStatements()
  const content = 'perm probe ' + Math.random()
  const lat: number[] = []
  let t0 = 0
  for (const s of socks)
    s.onFrame = (ev, at) => {
      if (ev.type === 'message' && ev.message?.content === content) lat.push(at - t0)
    }
  t0 = performance.now()
  const r = await req(`/channels/${cid}/messages`, { i: 0, body: { content } })
  const deadline = performance.now() + 30000
  while (lat.length < socks.length && performance.now() < deadline) await sleep(20)
  await sleep(300)
  log(
    stats(
      label,
      lat,
      `post=${r.status}/${r.ms.toFixed(0)}ms delivered=${lat.length}/${socks.length} db_statements=${await statements()}`
    )
  )
}

const restricted = chans[50]
await measure('public channel, warm caches', chans[1])
await measure('public channel again', chans[1])
await measure('after per-user rule on chan (restricted, every conn re-checks)', restricted, () =>
  req(`/channels/${restricted}/perms`, {
    i: 0,
    method: 'PUT',
    body: { subject: 'u:u04997', can_view: false, can_send: false, can_read_history: false },
  })
)
await measure('restricted channel again (cached)', restricted)
let role = 0
await measure('after creating a role (roles_changed)', restricted, async () => {
  const r = await req('/servers/big/roles', {
    i: 0,
    body: { name: 'probe', color: '#112233', perms: 0 },
  })
  role = json<{ id: number }>(r).id
})
await measure('public channel after roles_changed', chans[2])
await measure('restricted channel after roles_changed', restricted)

const timeouts: number[] = []
let t0 = 0
for (const s of socks)
  s.onFrame = (ev, at) => {
    if (ev.type === 'member_timeout') timeouts.push(at - t0)
  }
await resetStatements()
t0 = performance.now()
const put = await req('/servers/big/timeouts/u04998', {
  i: 0,
  method: 'PUT',
  body: { seconds: 60 },
})
await sleep(5000)
log(
  stats(
    'member timeout event',
    timeouts,
    `put=${put.status}/${put.ms.toFixed(0)}ms received_by=${timeouts.length} (moderators only) db_statements=${await statements()}`
  )
)

await req(`/channels/${restricted}/perms/${encodeURIComponent('u:u04997')}`, {
  i: 0,
  method: 'DELETE',
})
if (role) await req(`/servers/big/roles/${role}`, { i: 0, method: 'DELETE' })
await req('/servers/big/timeouts/u04998', { i: 0, method: 'DELETE' })
for (const s of socks) s.ws.close()
finish()
