// Run with bun scripts/layout_audit_browser.ts [base url] against a fresh instance (it registers
// its own accounts; the first becomes the site admin) and Playwright Chromium installed. Opens every
// screen and dialog on a desktop and a phone, in the dark and the light theme, and fails on
// overflow, overlap and safe-area faults (lib/layout_check.ts) and on spacing faults: unevenly
// padded surfaces, gaps and padding off the spacing scale, centered rows whose children do not
// share one center line (lib/layout_audit.ts). SCENES=a,b runs only those scenes.
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { auditIssues, describeAudit, type AuditNode } from '../apps/web/app/lib/layout_audit'
import { describeIssue, layoutIssues, type LayoutNode } from '../apps/web/app/lib/layout_check'

const BASE = process.argv[2] ?? 'http://127.0.0.1:4670'
const PASSWORD = 'layout-audit-password-9'
const ONLY = (process.env.SCENES ?? '').split(',').filter(Boolean)

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

const account = async (username: string): Promise<string> => {
  try {
    return (
      await api('POST', '/auth/register', {
        username,
        password: PASSWORD,
        avatar_kind: 'identicon',
      })
    ).token
  } catch {
    return (await api('POST', '/auth/login', { username, password: PASSWORD })).token
  }
}

interface Seed {
  token: string
  club: string
  general: number
}

async function seed(): Promise<Seed> {
  const token = await account('audit-owner')
  await account('audit-friend')
  let club
  try {
    club = await api('POST', '/servers', { name: 'audit-club' }, token)
  } catch {
    club = await api('GET', '/servers/audit-club', undefined, token)
  }
  const general = club.channels.find((c: { kind: string }) => c.kind === 'text').id
  const hello = await api(
    'POST',
    `/channels/${general}/messages`,
    { content: 'Audit hello' },
    token
  )
  await api('PUT', `/messages/${hello.id}/reactions/${encodeURIComponent('👍')}`, undefined, token)
  await api('PATCH', `/channels/${general}`, { topic: 'Audit topic line' }, token)
  return { token, club: club.name, general }
}

interface Frame {
  name: string
  width: number
  height: number
  theme: 'dark' | 'light'
  phone: boolean
}

const FRAMES: Frame[] = [
  { name: 'desktop-dark', width: 1280, height: 800, theme: 'dark', phone: false },
  { name: 'desktop-light', width: 1280, height: 800, theme: 'light', phone: false },
  { name: 'phone-dark', width: 390, height: 844, theme: 'dark', phone: true },
  { name: 'phone-light', width: 390, height: 844, theme: 'light', phone: true },
]

type Scene = (page: Page, s: Seed, f: Frame) => Promise<void | 'skip'>

const settle = (page: Page, ms = 700) => page.waitForTimeout(ms)

const openMenu = async (page: Page) => {
  const menu = page.locator('[aria-label="Menu"]:visible').first()
  if (await menu.count()) {
    await menu.click()
    await settle(page, 500)
  }
}

const channel: Scene = async (page, s) => {
  await page.goto(`${BASE}/s/${s.club}/${s.general}/`, { waitUntil: 'domcontentloaded' })
  await page.getByText('Audit hello').first().waitFor({ timeout: 30000 })
  await settle(page)
}

const press = async (page: Page, f: Frame, target: ReturnType<Page['locator']>) => {
  if (f.phone) {
    const box = await target.boundingBox()
    if (!box) throw new Error('nothing to press')
    const cdp = await page.context().newCDPSession(page)
    const points = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points })
    await page.waitForTimeout(900)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  } else await target.click({ button: 'right' })
  await settle(page)
}

const settings =
  (section?: string): Scene =>
  async (page, s) => {
    await channel(page, s, FRAMES[0])
    await openMenu(page)
    await page.locator('button[title="Settings"]:visible').first().click()
    await page.getByRole('dialog').last().waitFor({ timeout: 15000 })
    if (section) await page.locator(`[data-settings-section="${section}"]:visible`).first().click()
    await settle(page)
  }

const admin =
  (path = ''): Scene =>
  async page => {
    await page.goto(`${BASE}/admin/${path}`, { waitUntil: 'domcontentloaded' })
    await settle(page, 2500)
  }

const SCENES: Record<string, Scene> = {
  home: async page => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await settle(page, 2500)
  },
  channel,
  drawer: async (page, s, f) => {
    if (!f.phone) return 'skip'
    await channel(page, s, f)
    await openMenu(page)
  },
  settings: settings(),
  ...Object.fromEntries(
    ['general', 'notifications', 'privacy', 'palette', 'sync', 'p2p'].map(section => [
      `settings-${section}`,
      settings(section),
    ])
  ),
  inbox: async (page, s, f) => {
    await channel(page, s, f)
    await page.locator('[data-inbox-button]:visible').first().click()
    await settle(page, 1000)
  },
  switcher: async page => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await settle(page, 1500)
    await openMenu(page)
    await page.locator('[data-switcher-tile]:visible').first().click()
    await settle(page)
  },
  palette: async (page, s, f) => {
    await channel(page, s, f)
    await openMenu(page)
    await page.locator('[data-palette-button]:visible').first().click()
    await settle(page)
  },
  'context-menu': async (page, s, f) => {
    await channel(page, s, f)
    await press(page, f, page.getByText('Audit hello').first())
  },
  reactions: async (page, s, f) => {
    await channel(page, s, f)
    await press(page, f, page.locator('[data-reaction]:visible').first())
  },
  emoji: async (page, s, f) => {
    await channel(page, s, f)
    await page.locator('[aria-label="Emoji"]:visible').first().click()
    await settle(page, 1000)
  },
  topic: async (page, s, f) => {
    await channel(page, s, f)
    await page
      .locator('button[aria-haspopup="dialog"]:has-text("Audit topic line"):visible')
      .first()
      .click()
    await settle(page)
  },
  poll: async (page, s, f) => {
    await channel(page, s, f)
    await page.locator('[aria-label="Create poll"]:visible').first().click()
    await page.getByRole('dialog').last().waitFor({ timeout: 15000 })
    await settle(page)
  },
  'server-settings': async (page, s, f) => {
    await channel(page, s, f)
    await openMenu(page)
    await page.locator('[aria-label="Server settings"]:visible').first().click()
    await page.getByRole('dialog').last().waitFor({ timeout: 15000 })
    await settle(page)
  },
  'add-server': async (page, s, f) => {
    await channel(page, s, f)
    await openMenu(page)
    await page.locator('[title="Add a server"]:visible').first().click()
    await page.getByRole('dialog').last().waitFor({ timeout: 15000 })
    await settle(page)
  },
  invite: async (page, s) => {
    await page.goto(`${BASE}/invite/${s.club}/`, { waitUntil: 'domcontentloaded' })
    await settle(page, 2500)
  },
  admin: admin(),
  ...Object.fromEntries(
    ['features', 'branding', 'users', 'servers', 'audit', 'config', 'danger', 'encryption'].map(
      section => [`admin-${section}`, admin(`${section}/`)]
    )
  ),
}

// Every visible element, measured for both checkers.
const measure = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
    document.body.appendChild(probe)
    const ps = getComputedStyle(probe)
    const safe = {
      top: parseFloat(ps.paddingTop) || 0,
      right: parseFloat(ps.paddingRight) || 0,
      bottom: parseFloat(ps.paddingBottom) || 0,
      left: parseFloat(ps.paddingLeft) || 0,
    }
    probe.remove()
    const ids = new Map<Element, number>()
    const layout: unknown[] = []
    const audit: unknown[] = []
    const ownText = (el: Element) =>
      [...el.childNodes]
        .filter(n => n.nodeType === 3)
        .map(n => (n.textContent ?? '').trim())
        .join(' ')
        .trim()
    const describe = (el: Element) => {
      const tag = el.tagName.toLowerCase()
      const role = el.getAttribute('role')
      const name =
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        ''
      const t = ((el as HTMLElement).innerText || el.textContent || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 30)
      return `${tag}${role ? `[${role}]` : ''}${name ? `(${name.slice(0, 40)})` : ''}${t ? ` "${t}"` : ''}`
    }
    const visible = (el: Element) =>
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    // What only a screen reader gets (clipped to one pixel), with everything in it.
    const unseen = new WeakSet<Element>()
    for (const el of document.querySelectorAll('body *')) {
      if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'contents' || !visible(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (
        (el.parentElement && unseen.has(el.parentElement)) ||
        (cs.position === 'absolute' && r.width <= 1 && r.height <= 1 && cs.overflowX !== 'visible')
      ) {
        unseen.add(el)
        continue
      }
      let p = el.parentElement
      while (p && !ids.has(p)) p = p.parentElement
      ids.set(el, layout.length)
      const neg = (v: string) => Math.max(0, -parseFloat(v) || 0)
      const label = describe(el)
      layout.push({
        id: layout.length,
        parent: p ? ids.get(p) : null,
        label,
        box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        flow: cs.position !== 'absolute' && cs.position !== 'fixed',
        inline: cs.display === 'inline',
        clipX: cs.overflowX !== 'visible',
        clipY: cs.overflowY !== 'visible',
        scrollX: cs.overflowX === 'auto' || cs.overflowX === 'scroll',
        scrollY: cs.overflowY === 'auto' || cs.overflowY === 'scroll',
        ellipsis: cs.textOverflow === 'ellipsis',
        content:
          !!ownText(el) || el.matches('button,input,textarea,select,img,svg,a[href],[role=button]'),
        bleed: {
          left: neg(cs.marginLeft),
          top: neg(cs.marginTop),
          right: neg(cs.marginRight),
          bottom: neg(cs.marginBottom),
        },
      })
      if (el.matches('button,input,textarea,select,a,[role=button]')) continue
      const bg = cs.backgroundColor
      const painted = bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)
      const ringed = ['Top', 'Right', 'Bottom', 'Left'].every(
        side => parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0
      )
      const flex = cs.display === 'flex' || cs.display === 'inline-flex'
      const grid = cs.display === 'grid' || cs.display === 'inline-grid'
      const kids = [...el.children].filter(c => {
        const k = getComputedStyle(c)
        return visible(c) && k.position !== 'absolute' && k.position !== 'fixed'
      })
      const centered =
        flex && cs.flexDirection === 'row' && cs.alignItems === 'center' && kids.length > 1
      const gapOf = (v: string) => (v === 'normal' ? 0 : parseFloat(v) || 0)
      audit.push({
        label,
        // A bottom sheet pads its bottom for the home indicator, under its grip.
        surface: (painted || ringed) && !el.hasAttribute('data-sheet'),
        padding: {
          top: parseFloat(cs.paddingTop) || 0,
          right: parseFloat(cs.paddingRight) || 0,
          bottom: parseFloat(cs.paddingBottom) || 0,
          left: parseFloat(cs.paddingLeft) || 0,
        },
        gap:
          (flex || grid) && kids.length > 1
            ? { row: gapOf(cs.rowGap), column: gapOf(cs.columnGap) }
            : null,
        centers:
          centered && cs.flexWrap === 'nowrap'
            ? kids.map(c => {
                const b = c.getBoundingClientRect()
                return (b.top + b.bottom) / 2
              })
            : null,
        wrapped:
          centered && cs.flexWrap !== 'nowrap'
            ? kids.map(c => {
                const b = c.getBoundingClientRect()
                return { top: b.top, bottom: b.bottom }
              })
            : null,
      })
    }
    return { layout, audit, frame: { width: innerWidth, height: innerHeight, safe } }
  })

async function context(browser: Awaited<ReturnType<typeof chromium.launch>>, f: Frame) {
  const ctx = await browser.newContext({
    viewport: { width: f.width, height: f.height },
    hasTouch: f.phone,
    isMobile: f.phone,
    colorScheme: f.theme,
    serviceWorkers: 'block',
  })
  await ctx.addInitScript(theme => localStorage.setItem('rchat_theme', theme), f.theme)
  return ctx
}

async function signIn(ctx: BrowserContext) {
  const page = await ctx.newPage()
  await page.goto(`${BASE}/login/`, { waitUntil: 'domcontentloaded' })
  for (let tries = 0; tries < 4 && page.url().includes('/login'); tries++) {
    await page.getByRole('textbox', { name: 'Username' }).fill('audit-owner')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.locator('form button[type=submit]').last().click()
    await page
      .waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 15000 })
      .catch(() => {})
  }
  await settle(page, 1500)
  return page
}

const s = await seed()
const browser = await chromium.launch()
let faults = 0
try {
  for (const f of FRAMES) {
    const ctx = await context(browser, f)
    const page = await signIn(ctx)
    for (const [name, run] of Object.entries(SCENES)) {
      if (ONLY.length && !ONLY.includes(name)) continue
      const tag = `${f.name} ${name}`
      try {
        for (let i = 0; i < 4 && (await page.getByRole('dialog').count()); i++) {
          await page.keyboard.press('Escape')
          await settle(page, 250)
        }
        if ((await run(page, s, f)) === 'skip') continue
        const m = await measure(page)
        const found = [
          ...layoutIssues(m.layout as LayoutNode[], m.frame).map(describeIssue),
          ...auditIssues(m.audit as AuditNode[]).map(describeAudit),
        ]
        faults += found.length
        console.log(
          `${found.length ? 'FAIL' : 'ok  '} ${tag}${found.map(x => `\n     ${x}`).join('')}`
        )
      } catch (e) {
        faults++
        console.log(`FAIL ${tag}: could not open (${String(e).split('\n')[0]})`)
      }
    }
    await ctx.close()
  }
} finally {
  await browser.close()
}
console.log(faults ? `${faults} layout faults` : 'No layout faults.')
process.exit(faults ? 1 : 0)
