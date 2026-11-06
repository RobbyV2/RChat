import { finish, header, load, log, need, openMany, proc, sleep } from './lib'

const SOCKETS = Number(process.env.SOCKETS ?? 1000)
const FROM = Number(process.env.FROM ?? 2000)
const VIEW = process.env.VIEW || null
const HOLD = Number(process.env.HOLD ?? 0)
const PID = Number(need('SERVER_PID'))

header(`mem sockets=${SOCKETS} from=${FROM} view=${VIEW}`)
await sleep(1000)
const r0 = proc(PID).rss
const t0 = performance.now()
const { socks, fail } = await openMany(
  Array.from({ length: SOCKETS }, (_, k) => FROM + k),
  VIEW,
  1
)
const wall = performance.now() - t0
await sleep(3000)
const r1 = proc(PID).rss
const mib = (b: number) => (b / 1048576).toFixed(0)
log(
  `view=${VIEW} ${socks.length} idle sockets (fail=${fail}, ${wall.toFixed(0)}ms): rss ${mib(r0)} -> ${mib(r1)} MiB = ${((r1 - r0) / socks.length / 1024).toFixed(0)} KiB/socket ${load()}`
)
if (HOLD) {
  log(`holding ${socks.length} sockets for ${HOLD}s`)
  await sleep(HOLD * 1000)
}
for (const s of socks) s.ws.close()
finish()
