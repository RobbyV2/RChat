import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, type CDPSession, type Page } from 'playwright-core'
import {
  baseUrl,
  channels,
  findChrome,
  finish,
  header,
  load,
  log,
  openMany,
  req,
  sleep,
  tok,
  type Sock,
} from './lib'

const USER = 1000
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright')
const chrome = findChrome(browsers)
if (!chrome) {
  console.error(
    `No chromium-*/chrome-linux64/chrome or chromium-*/chrome-linux/chrome in ${browsers}`
  )
  process.exit(2)
}

type Metrics = Record<string, number>
type Win = Window & { __lt?: number[] }

const metrics = async (cdp: CDPSession): Promise<Metrics> =>
  Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
const mib = (b: number) => (b / 1048576).toFixed(1)
const shot = async (page: Page, name: string) => {
  const out = process.env.OUT
  if (out) await page.screenshot({ path: `${out.replace(/\.[^./]*$/, '')}-${name}.png` })
}

header('client')
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
})
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  colorScheme: 'dark',
})
await ctx.addInitScript(token => {
  if (location.protocol.startsWith('http')) localStorage.setItem('rchat_token', token)
}, tok(USER))
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send('Performance.enable')
page.on('console', m => {
  if (m.type() === 'error') console.log('console:', m.text().slice(0, 160))
})
page.on('pageerror', e => console.log('pageerror:', String(e).slice(0, 160)))

const t0 = Date.now()
const booted = await page
  .goto(baseUrl() + '/', { waitUntil: 'domcontentloaded' })
  .then(() =>
    page.waitForFunction(() => document.querySelectorAll('[title]').length > 50, null, {
      timeout: 60000,
    })
  )
  .then(() => true)
  .catch(() => false)
if (!booted) {
  log('boot: the app did not render within 60s')
  await shot(page, 'boot')
  await browser.close()
  finish(1)
}
await page.waitForTimeout(4000)
const m0 = await metrics(cdp)
log(
  `boot to idle: ${Date.now() - t0}ms script=${m0.ScriptDuration.toFixed(2)}s task=${m0.TaskDuration.toFixed(2)}s layout=${m0.LayoutDuration.toFixed(2)}s heap=${mib(m0.JSHeapUsedSize)}MiB nodes=${m0.Nodes} ${load()}`
)
await shot(page, 'boot')

const chans = await channels()
const t1 = Date.now()
await page.goto(`${baseUrl()}/s/big/${chans[0]}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)
const m1 = await metrics(cdp)
log(
  `open big: ${Date.now() - t1}ms (incl 6s idle) script=${m1.ScriptDuration.toFixed(2)}s task=${m1.TaskDuration.toFixed(2)}s heap=${mib(m1.JSHeapUsedSize)}MiB nodes=${m1.Nodes} ${load()}`
)
await shot(page, 'big')

await page.evaluate(() => {
  const w = window as Win
  w.__lt = []
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) w.__lt?.push(e.duration)
  }).observe({ type: 'longtask', buffered: false })
})

async function phase(name: string, events: number, drive: () => Promise<void>) {
  const before = await metrics(cdp)
  await page.evaluate(() => {
    ;(window as Win).__lt = []
  })
  await drive()
  await page.waitForTimeout(1500)
  const after = await metrics(cdp)
  const lt = await page.evaluate(() => (window as Win).__lt ?? [])
  const d = (key: string) => (after[key] - before[key]).toFixed(2)
  const per = ((after.ScriptDuration - before.ScriptDuration) * 1000) / events
  const sum = lt.reduce((a, b) => a + b, 0)
  log(
    `browser during ${name}: script=+${d('ScriptDuration')}s (${per.toFixed(2)}ms per event, ${events} events) task=+${d('TaskDuration')}s layout=+${d('LayoutDuration')}s style=+${d('RecalcStyleDuration')}s longtasks=${lt.length} (${sum.toFixed(0)}ms, max ${Math.max(0, ...lt).toFixed(0)}ms) heap=${mib(after.JSHeapUsedSize)}MiB nodes=${after.Nodes} ${load()}`
  )
}

const send = async (cid: (m: number) => number, label: string) => {
  for (let m = 0; m < 100; m++) {
    await req(`/channels/${cid(m)}/messages`, {
      i: USER + 1 + (m % 50),
      body: { content: `${label} ${m}` },
    })
    await sleep(50)
  }
}

let socks: Sock[] = []
await phase('storm (1000 users come online)', 1000, async () => {
  const t = performance.now()
  const opened = await openMany(
    Array.from({ length: 1000 }, (_, k) => USER + 1 + k),
    'big'
  )
  socks = opened.socks
  log(
    `storm: ${socks.length} sockets in ${(performance.now() - t).toFixed(0)}ms fail=${opened.fail} ${load()}`
  )
  await sleep(2000)
})
await shot(page, 'storm')
await phase('msgs-other (100 messages in other channels of big)', 100, () =>
  send(m => chans[3 + (m % 20)], 'other channel')
)
await phase('msgs-view (100 messages in the open channel)', 100, () =>
  send(() => chans[0], 'viewed channel')
)
for (const s of socks) s.ws.close()
await browser.close()
finish()
