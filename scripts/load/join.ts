import { finish, header, json, log, pool, req, stats } from './lib'

const CONC = Number(process.env.CONC ?? 200)

export const joinCode = (count: number, joined: number, attempted: number) =>
  joined === attempted && count === joined + 1 ? 0 : 1

async function main() {
  header(`join conc=${CONC}`)
  const name = 'join-' + Date.now().toString(36)
  const made = await req('/servers', { i: 0, body: { name } })
  if (made.status !== 200) {
    log(`create ${name}: ${made.status} ${made.text.slice(0, 200)}`)
    finish(1)
  }

  let joined = 0
  let attempted = 0
  for (const [label, conc, start, count] of [
    ['sequential', 1, 3000, 40],
    [`conc=${CONC}`, CONC, 3100, 200],
  ] as const) {
    const ids = Array.from({ length: count }, (_, k) => start + k)
    attempted += count
    const ms: number[] = []
    const codes: Record<number, number> = {}
    const t0 = performance.now()
    await pool(ids, conc, async i => {
      const r = await req(`/servers/${name}/join`, { i, body: {} })
      codes[r.status] = (codes[r.status] ?? 0) + 1
      if (r.status === 200) joined++
      ms.push(r.ms)
    })
    const rate = ids.length / ((performance.now() - t0) / 1000)
    log(stats(`join ${label}`, ms, `codes=${JSON.stringify(codes)} rate=${rate.toFixed(0)}/s`))
  }

  const count = json<{ member_count: number }>(await req(`/servers/${name}`, { i: 0 })).member_count
  log(`member_count=${count} expected=${joined + 1} joined=${joined}/${attempted}`)
  const gone = await req(`/servers/${name}`, { i: 0, method: 'DELETE' })
  if (gone.status !== 200) log(`delete ${name}: ${gone.status} ${gone.text.slice(0, 200)}`)
  finish(joinCode(count, joined, attempted))
}

if (import.meta.main) await main()
