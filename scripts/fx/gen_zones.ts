// Records what Chromium (V8 and its ICU, as in Chrome, Edge, WebView2 and Android WebView)
// reports as the page's time zone for each zone the hemisphere test covers: the device zone is
// set through CDP's override (what Playwright's `timezoneId` uses). Bun (JSC) keeps IANA names;
// V8 reports CLDR's legacy ones. Run by hand or by the browser checks, never by the unit gate.
//   bun scripts/fx/gen_zones.ts          records the vector
//   bun scripts/fx/gen_zones.ts --check  compares a new recording with the committed vector
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { NORTH_IANA, SOUTH_IANA } from '../../apps/web/app/lib/__tests__/fx_zones_list'
import { findChrome } from '../load/lib'

export const VECTOR = join(
  import.meta.dir,
  '../../apps/web/app/lib/__tests__/fixtures/fx_v8_zones.json'
)

type Names = Record<string, string>

export const vectorText = (engine: string, recorded: string, reported: Names) =>
  `${JSON.stringify({ engine, recorded, reported }, null, 2)}\n`

export const zoneDiff = (committed: Names, reported: Names) =>
  [...new Set([...Object.keys(committed), ...Object.keys(reported)])]
    .sort()
    .filter(zone => committed[zone] !== reported[zone])
    .map(
      zone =>
        `${zone}: ${committed[zone] ?? '(not recorded)'} -> ${reported[zone] ?? '(not recorded)'}`
    )

const fromChromium = async (exe: string, zones: string[]) => {
  const browser = await chromium.launch({ headless: true, executablePath: exe })
  const page = await (await browser.newContext()).newPage()
  const cdp = await page.context().newCDPSession(page)
  const reported: Names = {}
  for (const zone of zones) {
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: zone })
    reported[zone] = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  }
  const engine = `chromium ${browser.version()}`
  await browser.close()
  return { engine, reported }
}

// Node runs the same V8 time-zone canonicalization (on 2026-11-09 both reported the same names
// for every zone here).
const fromNode = (zones: string[]) => {
  const script = `const z=${JSON.stringify(zones)};const o={};for(const n of z)o[n]=new Intl.DateTimeFormat('en',{timeZone:n}).resolvedOptions().timeZone;console.log(JSON.stringify({v:process.versions,o}))`
  const out = Bun.spawnSync(['node', '-e', script])
  if (out.exitCode !== 0) throw new Error('no Chromium installed and node failed')
  const { v, o } = JSON.parse(out.stdout.toString()) as {
    v: Record<string, string>
    o: Names
  }
  return { engine: `node ${v.node} (V8 ${v.v8}, ICU ${v.icu})`, reported: o }
}

async function main(args: string[]) {
  const zones = [...SOUTH_IANA, ...NORTH_IANA]
  const browsers =
    process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright')
  const exe = findChrome(browsers)
  const { engine, reported } = exe ? await fromChromium(exe, zones) : fromNode(zones)
  console.log(engine, Object.keys(reported).length)
  if (!args.includes('--check')) {
    writeFileSync(VECTOR, vectorText(engine, new Date().toISOString().slice(0, 10), reported))
    return
  }
  const committed = JSON.parse(readFileSync(VECTOR, 'utf8')) as { reported: Names }
  const diff = zoneDiff(committed.reported, reported)
  for (const line of diff) console.error(line)
  if (diff.length) process.exit(1)
  console.log('The committed vector matches.')
}

if (import.meta.main) await main(process.argv.slice(2))
