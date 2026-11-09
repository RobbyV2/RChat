// P2P in Firefox, end to end against a running instance (full mode, PeerJS server up). It
// registers accounts: run it only against a scratch instance.
//
//   PLAYWRIGHT_BROWSERS_PATH=<dir with firefox and chromium for playwright-core 1.64.1> \
//     BASE=http://127.0.0.1:3000 bun scripts/p2p_firefox.ts
//
// Optional: UBO_XPI=<signed uBlock Origin .xpi> FIREFOX_BIN=<release Firefox binary> also runs
// Firefox with uBlock Origin and its default lists against Chromium. Exits 1 when a check fails.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chromium,
  firefox,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from 'playwright-core'

const BASE = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/+$/, '')
const PASSWORD = 'correct-horse-battery-9'
const FAKE_MEDIA = {
  'media.navigator.streams.fake': true,
  'media.navigator.permission.disabled': true,
}
// What uBlock Origin's WebRTC setting sets on Firefox for Android (privacy.network
// .webRTCIPHandlingPolicy = default_public_interface_only).
const HIDE_ADDRESS = {
  'media.peerconnection.ice.default_address_only': true,
  'media.peerconnection.ice.no_host': true,
}

type Kind = 'firefox' | 'chromium' | 'ubo'

const results: { name: string; ok: boolean; detail: string }[] = []
const closers: (() => Promise<unknown>)[] = []
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

const until = async (fn: () => Promise<boolean>, ms: number, every = 500) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true
    await new Promise(r => setTimeout(r, every))
  }
  return false
}

// Service workers are blocked: on a first visit the app reloads once its worker takes over,
// which would cut into the P2P start these checks time.
const launch = async (kind: Kind, prefs: Record<string, boolean> = {}): Promise<BrowserContext> => {
  const viewport = { width: 1280, height: 800 }
  if (kind === 'ubo') {
    const dir = mkdtempSync(join(tmpdir(), 'p2p-ubo-'))
    mkdirSync(join(dir, 'extensions'))
    await copyFile(process.env.UBO_XPI!, join(dir, 'extensions', 'uBlock0@raymondhill.net.xpi'))
    const ctx = await firefox.launchPersistentContext(dir, {
      channel: 'moz-firefox',
      executablePath: process.env.FIREFOX_BIN,
      headless: true,
      viewport,
      serviceWorkers: 'block',
      firefoxUserPrefs: {
        'extensions.autoDisableScopes': 0,
        'extensions.enabledScopes': 15,
        ...FAKE_MEDIA,
        ...prefs,
      },
    })
    closers.push(async () => {
      await ctx.close()
      rmSync(dir, { recursive: true, force: true })
    })
    // Its lists are in once it blocks a path on EasyPrivacy.
    const p = await pageOf(ctx)
    await p.goto(`${BASE}/login/`, { waitUntil: 'commit' })
    await p.getByRole('button', { name: 'Create account' }).first().waitFor()
    const blocking = await until(
      () =>
        p.evaluate(() =>
          fetch('/adstrack.js', { cache: 'no-store' }).then(
            () => false,
            () => true
          )
        ),
      60_000,
      1000
    )
    if (!blocking) throw new Error('uBlock Origin never started blocking')
    return ctx
  }
  const browser: Browser =
    kind === 'chromium'
      ? await chromium.launch({
          headless: true,
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        })
      : await firefox.launch({ headless: true, firefoxUserPrefs: { ...FAKE_MEDIA, ...prefs } })
  closers.push(() => browser.close())
  return browser.newContext({ viewport, serviceWorkers: 'block' })
}

const pageOf = async (ctx: BrowserContext) => ctx.pages()[0] ?? (await ctx.newPage())

// Typed, so React sees every change in every engine (WebDriver BiDi included).
const typeIn = async (loc: Locator, text: string) => {
  await loc.click()
  await loc.page().keyboard.press('Control+a')
  await loc.page().keyboard.press('Delete')
  await loc.pressSequentially(text)
}

const status = (p: Page) =>
  p
    .locator('[data-p2p-status]')
    .first()
    .getAttribute('data-p2p-status', { timeout: 1000 })
    .catch(() => null)

// The app may still move to Home after signing up: then this opens the P2P view again.
const waitStatus = (p: Page, want: string, ms: number) =>
  until(async () => {
    const now = await status(p)
    const rail = p.getByRole('button', { name: 'Peer-to-peer' })
    if (now === null && (await rail.getAttribute('aria-pressed')) !== 'true') await rail.click()
    return now === want
  }, ms)

// The login page is prerendered: input before it hydrates is lost, so this tries again, with
// a new name each time (a random one can trip the instance's profanity filter).
const register = async (p: Page, base: string) => {
  const rail = p.getByRole('button', { name: 'Peer-to-peer' })
  await p.goto(`${BASE}/`, { waitUntil: 'commit' })
  for (let tries = 0; tries < 3; tries += 1) {
    const name = `${base}${Math.random().toString(36).slice(2, 8)}`
    await p.getByRole('button', { name: 'Create account' }).first().click()
    await typeIn(p.getByRole('textbox', { name: 'Username' }), name)
    await typeIn(p.getByRole('textbox', { name: 'Password' }), PASSWORD)
    await p.getByRole('button', { name: 'Create account' }).last().click()
    if (await until(() => rail.isVisible(), 10_000)) return
  }
  throw new Error(`couldn't register ${base}`)
}

// Opens the P2P view until `ready` shows: the app may still move to Home after signing up.
const openP2p = async (p: Page, ready: Locator) => {
  const rail = p.getByRole('button', { name: 'Peer-to-peer' })
  const shown = await until(async () => {
    if (await ready.first().isVisible()) return true
    if ((await rail.getAttribute('aria-pressed')) !== 'true') await rail.click()
    return false
  }, 30_000)
  if (!shown) throw new Error('the P2P view never opened')
}

const turnOn = async (p: Page, name: string) => {
  const off = p.getByRole('button', { name: 'Turn on P2P' })
  await openP2p(p, off)
  await off.click()
  await typeIn(p.getByRole('textbox', { name: 'P2P display name' }), name)
  await p.getByRole('button', { name: 'Turn on', exact: true }).click()
  await openP2p(p, p.locator('[data-p2p-status]'))
}

const user = async (kind: Kind, name: string, prefs: Record<string, boolean> = {}) => {
  const p = await pageOf(await launch(kind, prefs))
  const peerjs: string[] = []
  p.on('websocket', ws => {
    if (ws.url().includes('/peerjs?')) peerjs.push(ws.url())
  })
  await register(p, name.toLowerCase())
  await turnOn(p, name)
  return { p, peerjs }
}

// Home's Peer-to-peer card names the state and says what it means, like the P2P page.
const homeCardSays = async (p: Page, state: string, text: string, note: string) => {
  await p.getByRole('button', { name: 'Home' }).first().click()
  const card = p.locator('[data-p2p-home]')
  const line = card.locator(`[data-p2p-home-status="${state}"]`)
  const shown = await until(
    async () =>
      (await line.count()) > 0 &&
      ((await line.textContent()) ?? '').includes(text) &&
      ((await card.locator('[data-p2p-home-note]').textContent()) ?? '').includes(note),
    15_000
  )
  return shown || `the Home card shows ${await card.textContent().catch(() => 'nothing')}`
}

const check = async (name: string, fn: () => Promise<string | true>) => {
  log('...', name)
  let detail: string | true
  try {
    detail = await fn()
  } catch (e) {
    detail = String(e).split('\n')[0]
  }
  // Each check closes the browsers it opened.
  for (const close of closers.splice(0)) await close().catch(() => {})
  results.push({ name, ok: detail === true, detail: detail === true ? '' : detail })
  log(detail === true ? 'ok  ' : 'FAIL', name, detail === true ? '' : detail)
}

const openDm = async (p: Page, name: string) => {
  const dialog = p.getByRole('dialog', { name: 'P2P contact' })
  if (await dialog.count())
    await dialog.getByRole('button', { name: 'Message', exact: true }).click()
  else {
    await p
      .locator('section[aria-label="Contacts"]')
      .getByText(name, { exact: true })
      .first()
      .click({ button: 'right' })
    await p.getByRole('menuitem', { name: 'Message' }).first().click()
  }
  await p.locator('textarea[data-p2p-composer]').waitFor({ timeout: 15_000 })
}

const send = async (p: Page, text: string) => {
  await typeIn(p.locator('textarea[data-p2p-composer]'), text)
  await p.keyboard.press('Enter')
}

const sees = (p: Page, text: string, ms = 30_000) =>
  until(async () => (await p.getByText(text).count()) > 0, ms)

// Contact request, DMs both ways and a call, between a user of `a` and one of `b`.
const pair = async (a: Kind, b: Kind) => {
  const A = await user(a, 'Alice')
  const B = await user(b, 'Bob')
  if (!(await waitStatus(A.p, 'online', 30_000))) return `${a} not online: ${await status(A.p)}`
  if (!(await waitStatus(B.p, 'online', 30_000))) return `${b} not online: ${await status(B.p)}`
  await B.p.getByRole('button', { name: 'Show my code' }).first().click()
  const code = await B.p.locator('textarea[data-p2p-card]').inputValue()
  await B.p.keyboard.press('Escape')
  await A.p.getByRole('button', { name: 'Add contact' }).first().click()
  await typeIn(A.p.getByRole('textbox', { name: 'Contact code' }), code)
  await A.p.getByRole('button', { name: 'Send request' }).click()
  const accepted = await until(async () => {
    const accept = B.p.locator('section[aria-label="Message requests"]').getByRole('button', {
      name: 'Accept',
    })
    if (!(await accept.count())) return false
    await accept.first().click()
    return true
  }, 45_000)
  if (!accepted) return 'the contact request never arrived'
  if (
    !(await until(async () => (await A.p.locator('[data-presence="online"]').count()) > 0, 30_000))
  )
    return 'the contacts never connected'
  await openDm(A.p, 'Bob')
  await send(A.p, `hello from ${a}`)
  await openDm(B.p, 'Alice')
  if (!(await sees(B.p, `hello from ${a}`))) return 'the DM from A never arrived'
  await send(B.p, `hello from ${b}`)
  if (!(await sees(A.p, `hello from ${b}`))) return 'the DM from B never arrived'
  await A.p.getByRole('button', { name: 'Call, direct (P2P)' }).first().click()
  const rang = await until(async () => {
    const accept = B.p.locator('[data-p2p-incoming]').getByRole('button', { name: 'Accept' })
    if (!(await accept.count())) return false
    await accept.click()
    return true
  }, 30_000)
  if (!rang) return 'the call never rang'
  const connected = async (p: Page) => {
    const text = await p.locator('body').ariaSnapshot()
    return /Voice Connected/.test(text) && /In call with/.test(text) && !/Connecting…/.test(text)
  }
  if (!(await until(() => connected(A.p), 30_000))) return 'the call never connected for A'
  if (!(await until(() => connected(B.p), 30_000))) return 'the call never connected for B'
  return true
}

const main = async () => {
  const doc = (await (await fetch(`${BASE}/.well-known/rchat`)).json()) as { peerjs_url: string }
  const advertised = new URL(doc.peerjs_url)

  // Firefox answers navigator.storage.persist() only through its doorhanger, which a headless
  // browser never answers, like a user who doesn't notice it.
  await check('Firefox turns P2P on, with no notice', async () => {
    const { p } = await user('firefox', 'Fox')
    if (!(await waitStatus(p, 'online', 30_000))) return `status ${await status(p)}`
    // The address check takes a moment.
    await p.waitForTimeout(6000)
    for (const notice of ['unreachable', 'unsupported', 'address-hidden'])
      if (await p.locator(`[data-p2p-${notice}]`).count()) return `the ${notice} notice shows`
    return true
  })
  // Behind a proxy, PUBLIC_PEERJS_URL or PEERJS_PORT says where PeerJS is.
  await check('the PeerJS socket goes where the instance says', async () => {
    const { p, peerjs } = await user('chromium', 'Port')
    await until(async () => peerjs.length > 0, 30_000)
    const url = peerjs[0]
    if (!url) return `no PeerJS socket, status ${await status(p)}`
    const got = new URL(url)
    const port = advertised.port || (advertised.protocol === 'https:' ? '443' : '80')
    return got.host === `${advertised.hostname}:${port}` &&
      got.pathname.startsWith(advertised.pathname)
      ? true
      : `${got.host}${got.pathname}, advertised ${doc.peerjs_url}`
  })
  await check('Firefox with Chromium', () => pair('firefox', 'chromium'))
  await check('Firefox with Firefox', () => pair('firefox', 'firefox'))
  await check('a stalled PeerJS server times out into a notice, and Retry connects', async () => {
    const p = await pageOf(await launch('firefox'))
    let stalled = true
    await p.routeWebSocket(/\/peerjs\/peerjs/, ws => {
      if (!stalled) ws.connectToServer()
    })
    await register(p, 'stall')
    await turnOn(p, 'Stall')
    if (!(await waitStatus(p, 'unreachable', 40_000))) return `status ${await status(p)}`
    const notice = p.locator('[data-p2p-unreachable]')
    if (!(await notice.isVisible())) return 'no notice'
    const home = await homeCardSays(
      p,
      'unreachable',
      "Can't reach the P2P server",
      "contacts can't reach you"
    )
    if (home !== true) return home
    await p.getByRole('button', { name: 'Peer-to-peer' }).click()
    stalled = false
    await notice.getByRole('button', { name: 'Retry' }).click()
    return (await waitStatus(p, 'online', 30_000)) || `status ${await status(p)}`
  })
  await check('a browser that hides its address is told what to change', async () => {
    const { p } = await user('firefox', 'Hidden', HIDE_ADDRESS)
    if (!(await waitStatus(p, 'online', 30_000))) return `status ${await status(p)}`
    const notice = p.locator('[data-p2p-address-hidden]')
    return (await until(() => notice.isVisible(), 20_000)) || 'no notice'
  })
  // Firefox with media.peerconnection.enabled off (also Tor Browser): no server helps.
  await check('a browser with WebRTC off is told so, with no Retry', async () => {
    const { p } = await user('firefox', 'NoRtc', { 'media.peerconnection.enabled': false })
    if (!(await waitStatus(p, 'unsupported', 30_000))) return `status ${await status(p)}`
    const notice = p.locator('[data-p2p-unsupported]')
    if (!(await notice.isVisible())) return 'no notice'
    if (await p.getByRole('button', { name: 'Retry' }).count()) return 'a Retry button shows'
    await p.waitForTimeout(3000)
    if ((await status(p)) !== 'unsupported') return `status ${await status(p)}`
    return homeCardSays(p, 'unsupported', 'WebRTC is off', 'WebRTC turned off')
  })
  if (process.env.UBO_XPI && process.env.FIREFOX_BIN)
    await check('Firefox with uBlock Origin, with Chromium', () => pair('ubo', 'chromium'))

  for (const close of closers) await close().catch(() => {})
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  for (const r of failed) console.log(`FAIL ${r.name}: ${r.detail}`)
  process.exit(failed.length ? 1 : 0)
}

void main()
