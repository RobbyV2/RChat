import { SQL } from 'bun'
import { need, stats } from './lib'

const primary = new SQL(need('DATABASE_URL'))
const replica = new SQL(need('REPLICA_URL'))
const samples = Number(process.env.SAMPLES ?? 100)
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10000)
  throw new Error('SAMPLES must be between 1 and 10000')

const table = 'replica_probe_' + crypto.randomUUID().replaceAll('-', '')
let created = false
try {
  await primary`CREATE TABLE ${primary(table)} (id integer PRIMARY KEY)`
  created = true
  const wait = async (visible: () => Promise<boolean>) => {
    const start = performance.now()
    while (!(await visible())) {
      if (performance.now() - start > 60000) throw new Error('Replica did not catch up in 60s')
      await Bun.sleep(1)
    }
  }
  await wait(
    async () => (await replica`SELECT to_regclass(${table}) IS NOT NULL AS ready`)[0].ready
  )
  const waits: number[] = []
  let misses = 0
  for (let id = 0; id < samples; id++) {
    await primary`INSERT INTO ${primary(table)} (id) VALUES (${id})`
    const start = performance.now()
    const visible = async () =>
      (await replica`SELECT id FROM ${replica(table)} WHERE id = ${id}`).length !== 0
    if (!(await visible())) {
      misses++
      await wait(visible)
    }
    waits.push(performance.now() - start)
    await Bun.sleep(20)
  }
  console.log(stats('replica visibility', waits, `stale_on_first_read=${misses}/${samples}`))
} finally {
  try {
    if (created) await primary`DROP TABLE ${primary(table)}`
  } finally {
    await Promise.all([primary.close(), replica.close()])
  }
}
