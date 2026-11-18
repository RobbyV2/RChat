/* global URL, URLSearchParams, fetch, process, window, location, navigator, DOMException, WebSocket, console, setTimeout, clearTimeout, localStorage, document, getComputedStyle, Event */
// Run against a disposable local instance with its web client running. The first registered
// account can configure the site, or provide RCHAT_TEST_ADMIN_TOKEN for an existing instance.
// RCHAT_TEST_URL, WIDGET_HOST_PORT and CHROMIUM_PATH select the instance, host and browser.
// Supply RCHAT_TEST_SQLITE_PATH to age one fixture message immediately. Otherwise the test waits for the channel grouping window.
import { identiconBackground, identiconSvg } from '../apps/web/app/lib/identicon.ts'
import { GROUP_WINDOW } from '../apps/web/app/lib/message_groups.ts'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'

const base = new URL(process.env.RCHAT_TEST_URL || 'http://127.0.0.1:3000').origin
assert.equal(new URL(base).hostname, '127.0.0.1', 'Use a disposable loopback instance')
const hostPort = Number(process.env.WIDGET_HOST_PORT || 4406)
const host = 'http://localhost:' + hostPort
const deniedHost = 'http://localhost:' + (hostPort + 1)
const suffix = Date.now().toString(36)
const password = 'browser-fixture-password'
async function request(method, path, body, token, extra = {}) {
  const res = await fetch(base + '/api/v1' + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  })
  const data = await res.text()
  return {
    status: res.status,
    data: data.startsWith('{') || data.startsWith('[') ? JSON.parse(data) : data,
  }
}
async function ok(...args) {
  const r = await request(...args)
  assert.ok(
    r.status >= 200 && r.status < 300,
    `${args[0]} ${args[1]} ${r.status}: ${JSON.stringify(r.data.error ?? '')}`
  )
  return r.data
}
const signup = async username =>
  (await ok('POST', '/auth/register', { username, password, avatar_kind: 'identicon' })).token
const admin = process.env.RCHAT_TEST_ADMIN_TOKEN || (await signup('admin' + suffix))
const account = 'manager' + suffix
const manager = await signup(account)
const site = body => ok('PATCH', '/admin/settings', body, admin)
const saved = await ok('GET', '/settings')
const controls = {
  guest_chat_enabled: true,
  guest_voice_enabled: true,
  widget_chat: true,
  widgets: true,
  widget_read_links: true,
  guests_enabled: true,
  calls: true,
}
async function hostPage(port) {
  const server = createServer((req, res) => {
    const query = new URL(req.url, 'http://localhost').searchParams
    const id = query.get('id') ?? ''
    if (!/^[a-f0-9]{32}$/.test(id)) {
      res.writeHead(400).end()
      return
    }
    const widget = new URL('/widget/', base)
    widget.searchParams.set('id', id)
    widget.searchParams.set('theme', query.get('theme') === 'light' ? 'light' : 'dark')
    if (query.has('send')) widget.searchParams.set('send', query.get('send'))
    if (query.has('key')) widget.hash = new URLSearchParams({ key: query.get('key') }).toString()
    res.setHeader(
      'Permissions-Policy',
      query.has('block') ? 'microphone=()' : `microphone=(self "${base}")`
    )
    res.setHeader('Content-Type', 'text/html')
    res.end(
      `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><iframe title="Embedded channel" src="${widget}" ${query.has('delegate') ? 'allow="microphone"' : ''} style="width:100%;max-width:440px;height:480px;border:0"></iframe>`
    )
  })
  await new Promise(resolve => server.listen(port, resolve))
  return server
}
async function until(check, message, ms = 90000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await check()) return
    await delay(150)
  }
  throw Error(message)
}
const servers = []
const contexts = []
// A busy machine can take far longer than the browser's default waits.
const patient = ctx => {
  ctx.setDefaultTimeout(120000)
  ctx.setDefaultNavigationTimeout(120000)
  return ctx
}
let browser, voicePeer
const on = (el, text) => el.getByRole('button', { name: text, exact: true })
try {
  await site(controls)
  servers.push(await hostPage(hostPort), await hostPage(hostPort + 1))
  const server = 'frames' + suffix
  const path = '/servers/' + server
  const config = body => ok('PATCH', path, body, manager)
  const detail = await ok('POST', '/servers', { name: server }, manager)
  const text = detail.channels.find(c => c.kind === 'text').id
  const channel = async (name, kind) =>
    (await ok('POST', path + '/channels', { name, kind }, manager)).id
  const voice = await channel('lounge', 'voice'),
    other = await channel('outside', 'text')
  const widget = (channel_id, mode, changes = {}) =>
    ok(
      'POST',
      path + '/widgets',
      { channel_id, mode, enabled: true, composer: true, origins: [host], ...changes },
      manager
    )
  const [chat, call, read, link, withoutComposer] = await Promise.all([
    widget(text, 'public_chat'),
    widget(voice, 'voice'),
    widget(text, 'public_read'),
    widget(other, 'read_link'),
    widget(text, 'public_chat', { composer: false }),
  ])
  await config({ guest_chat_opt_in: true, guest_voice_opt_in: true })
  await ok('POST', `/channels/${other}/messages`, { content: 'Only in the other channel' }, manager)
  const earlier = await ok(
    'POST',
    `/channels/${text}/messages`,
    { content: 'Earlier from the manager' },
    manager
  )
  if (process.env.RCHAT_TEST_SQLITE_PATH) {
    const { Database } = await import('bun:sqlite')
    const db = new Database(process.env.RCHAT_TEST_SQLITE_PATH, { readwrite: true, create: false })
    try {
      const aged = db
        .query(
          'UPDATE messages SET created_at=created_at-? WHERE id=? AND channel_id=? AND author=? AND content=?'
        )
        .run(GROUP_WINDOW + 1, earlier.id, text, account, earlier.content)
      assert.equal(aged.changes, 1, 'The test SQLite file must belong to the instance under test')
    } finally {
      db.close()
    }
  } else await delay((GROUP_WINDOW + 1) * 1000)
  const recent = await ok(
    'POST',
    `/channels/${text}/messages`,
    { content: 'Selected channel history' },
    manager
  )
  assert.equal(
    (await fetch(base + '/login/')).headers.get('content-security-policy'),
    "frame-ancestors 'none'"
  )
  assert.match(
    (await fetch(base + '/widget/?id=' + call.id)).headers.get('content-security-policy'),
    new RegExp(host)
  )
  const browserOptions = {
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-fake-device-for-media-stream'],
  }
  browser = await chromium.launch(browserOptions)
  async function frame(w, params = {}, origin = host, options = {}) {
    const shared = options.context
    const ctx =
      shared ??
      (await (options.browser ?? browser).newContext({
        hasTouch: !!options.touch,
        isMobile: !!options.touch,
        viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
      }))
    if (!shared) contexts.push(patient(ctx))
    // Track capture and real peer statistics inside the frame. No production instrumentation.
    if (!shared)
      await ctx.addInitScript(
        ({ base, storageDenied }) => {
          if (location.origin !== base) return
          if (storageDenied)
            Object.defineProperty(window, 'localStorage', {
              get() {
                throw new DOMException('Storage unavailable', 'SecurityError')
              },
            })
          window.widgetTestMedia = { tracks: [], peers: [], requests: 0 }
          const state = window.widgetTestMedia
          const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
          navigator.mediaDevices.getUserMedia = async constraints => {
            state.requests++
            const stream = await get(constraints)
            state.tracks.push(...stream.getAudioTracks())
            return stream
          }
          const Peer = window.RTCPeerConnection
          window.RTCPeerConnection = class extends Peer {
            constructor(...args) {
              super(...args)
              state.peers.push(this)
            }
          }
        },
        { base, storageDenied: !!options.storageDenied }
      )
    const p = await ctx.newPage()
    const content = []
    const lookups = []
    p.on('request', req => {
      const url = new URL(req.url())
      if (url.origin === base && url.pathname.endsWith('/locations'))
        lookups.push({ path: url.pathname, ids: req.postDataJSON()?.ids })
      if (
        url.origin === base &&
        /\/(view|locations|messages|media|uploads|voice)(\/|$)/.test(url.pathname)
      )
        content.push(url.pathname)
    })
    let name
    p.on('websocket', socket => {
      if (!new URL(socket.url()).searchParams.has('widget')) return
      content.push('socket')
      socket.on('framereceived', ({ payload }) => {
        const event = JSON.parse(payload)
        if (event.type === 'widget_ready') name = event.name
      })
    })
    let releaseDiscovery, metadata, handledDiscovery
    if (options.holdDiscovery) {
      const paused = new Promise(resolve => {
        releaseDiscovery = resolve
      })
      let handled
      handledDiscovery = new Promise(resolve => {
        handled = resolve
      })
      await ctx.route(
        '**/widgets/' + w.id + '/room',
        async route => {
          try {
            const response = await route.fetch()
            assert.equal(response.status(), 200)
            metadata = await response.json()
            await paused
            await route.fulfill({ response }).catch(() => {})
          } finally {
            handled()
          }
        },
        { times: 1 }
      )
    }
    const cdp = await ctx.newCDPSession(p)
    const { targetInfo } = await cdp.send('Target.getTargetInfo')
    await cdp.send('Browser.setPermission', {
      permission: { name: 'microphone' },
      setting: params.denyDevice ? 'denied' : 'granted',
      origin,
      embeddedOrigin: base,
      browserContextId: targetInfo.browserContextId,
    })
    const remote = new URL(origin)
    remote.search = new URLSearchParams({ id: w.id, ...params }).toString()
    await p.goto(remote.href, { waitUntil: 'domcontentloaded' })
    if (origin === deniedHost) {
      await p.waitForLoadState('load')
      return { p, ctx }
    }
    const f = p.frameLocator('iframe')
    await f.getByRole('main', { name: 'Channel widget' }).waitFor()
    const document = () => p.frames().find(frame => frame.url().startsWith(base + '/widget/'))
    return {
      p,
      ctx,
      f,
      document,
      content,
      lookups,
      name: () => name,
      metadata: () => metadata,
      releaseDiscovery: async () => {
        releaseDiscovery()
        await handledDiscovery
      },
    }
  }
  async function discovery(w, channel_id, kind, cancel = false) {
    const x = await frame(w, kind === 'voice' ? { delegate: '1' } : {}, host, {
      holdDiscovery: true,
    })
    await until(() => x.metadata(), kind + ' room discovery did not complete', 45000)
    assert.deepEqual(x.metadata(), { server, channel_id, kind })
    assert.deepEqual(x.content, [])
    assert.equal(await x.f.locator('article, audio, [aria-label="Voice room"]').count(), 0)
    assert.equal(await x.document().evaluate(() => window.widgetTestMedia.requests), 0)
    if (cancel) {
      await x.p.locator('iframe').evaluate(el => el.remove())
      await x.releaseDiscovery()
      assert.deepEqual(x.content, [])
    } else {
      await x.releaseDiscovery()
      await until(
        () => x.content.some(url => url.endsWith('/view')) && x.content.includes('socket'),
        'Room did not open after discovery'
      )
      assert.equal(await x.document().evaluate(() => window.widgetTestMedia.requests), 0)
    }
    await x.ctx.close()
  }
  await discovery(chat, text, 'text', true)
  await discovery(chat, text, 'text')
  await discovery(call, voice, 'voice', true)
  await discovery(call, voice, 'voice')
  console.log(
    'PASS authorized metadata precedes history, roster, content socket and media in chat and voice frames'
  )
  const denied = await frame(chat, {}, deniedHost)
  assert.equal(
    denied.p.frames().some(f => f.url().startsWith(base + '/widget/')),
    false
  )
  const poll = await ok(
    'POST',
    `/channels/${text}/messages`,
    {
      content: '',
      poll: { kind: 'yes_no', question: 'Meet at noon?' },
    },
    manager
  )
  const a = await frame(chat, { theme: 'light' }, host, { mobile: true, storageDenied: true })
  const b = await frame(chat)
  const editor = x => x.f.getByRole('textbox', { name: 'Message as a guest' })
  await a.f.getByText('Selected channel history').waitFor()
  assert.equal(await a.f.getByText('Only in the other channel').count(), 0)
  await a.f.getByText(/only while it is open/).waitFor()
  await editor(a).fill('From the external chat frame')
  await editor(a).press('Enter')
  await b.f.getByText('From the external chat frame').waitFor()
  await editor(a).fill('Another message in memory')
  await editor(a).press('Enter')
  await b.f.getByText('Another message in memory').waitFor()
  const history = await ok('GET', `/channels/${text}/messages`)
  const posts = history.filter(
    m => m.content === 'From the external chat frame' || m.content === 'Another message in memory'
  )
  assert.equal(posts.length, 2)
  assert.match(posts[0].author.username, /^@guest:/)
  assert.equal(posts[0].author.username, posts[1].author.username)
  const article = (f, message) => f.locator('article[data-mid="' + message.id + '"]')
  const senderTime = async (f, message) => {
    const row = article(f, message)
    assert.ok(await row.getAttribute('aria-labelledby'))
    const [sender, time] = await row.evaluate(el =>
      el
        .getAttribute('aria-labelledby')
        .split(' ')
        .map(id => document.getElementById(id)?.textContent)
    )
    assert.equal(sender, message.author.display_name)
    assert.ok(time)
    return row
  }
  const compact = async x => {
    await x.p.locator('iframe').evaluate(el => {
      el.style.width = '280px'
    })
    await x.document().waitForFunction(() => window.innerWidth === 280)
  }
  await compact(a)
  let textLeft
  for (const message of [earlier, recent, posts[0], posts[1]]) {
    const row = await senderTime(a.f, message)
    const x = (await row.getByText(message.content, { exact: true }).boundingBox()).x
    textLeft ??= x
    assert.equal(x, textLeft, 'Every message body starts in the same column at 280px')
    const avatar = row.locator('[data-author-avatar]')
    const first = message.id !== posts[1].id
    assert.equal(await avatar.count(), first ? 1 : 0)
    assert.equal(await row.locator('[data-group-header]').count(), first ? 1 : 0)
    if (first) {
      const { username, avatar_kind, avatar_color } = message.author
      const picture = avatar.locator('img')
      assert.equal(await picture.getAttribute('alt'), username)
      const background = identiconBackground(avatar_kind, avatar_color)
      assert.equal(
        await picture.getAttribute('src'),
        'data:image/svg+xml;utf8,' + encodeURIComponent(identiconSvg(username, background))
      )
      const box = await picture.boundingBox()
      assert.equal(box.width, 36)
      assert.equal(box.height, 36)
    }
    assert.equal(await row.getByRole('button', { name: 'Reply', exact: true }).count(), 1)
  }
  const consecutive = await senderTime(b.f, posts[1])
  for (const message of [earlier, recent, posts[0]]) {
    const row = await senderTime(b.f, message)
    assert.equal(await row.locator('[data-group-header]').count(), 1)
  }
  assert.equal(await consecutive.locator('[data-group-header]').count(), 0)
  assert.equal(
    await b.f.locator('article').filter({ hasText: 'Another message in memory' }).count(),
    1
  )
  const reply = consecutive.getByRole('button', { name: 'Reply', exact: true })
  for (const x of [a, b]) {
    await compact(x)
    const row = article(x.f, posts[1])
    const gutter = row.locator('[data-group-time] time')
    await article(x.f, posts[0]).hover()
    assert.equal(await gutter.evaluate(el => getComputedStyle(el).opacity), '0')
    await row.hover()
    assert.equal(await gutter.evaluate(el => getComputedStyle(el).opacity), '1')
    const label = await gutter.textContent()
    assert.ok(label.trim())
    const timeBox = await gutter.boundingBox()
    const body = await row.getByText(posts[1].content, { exact: true }).boundingBox()
    assert.ok(timeBox.x + timeBox.width <= body.x, 'Time stays in its own column')
    await article(x.f, posts[0]).hover()
    await row.getByRole('button', { name: 'Reply', exact: true }).focus()
    assert.equal(await gutter.evaluate(el => getComputedStyle(el).opacity), '1')
  }
  for (const w of [chat, read]) {
    for (const theme of ['light', 'dark']) {
      const x = await frame(w, { theme }, host, { mobile: true, touch: true })
      await compact(x)
      const row = article(x.f, posts[1])
      const target = w === chat ? on(row, 'Reply') : row
      const gutter = row.locator('[data-group-time] time')
      await gutter.waitFor({ state: 'attached' })
      assert.equal(
        await x.document().evaluate(() => window.matchMedia('(pointer: coarse)').matches),
        true
      )
      const pollRow = article(x.f, poll)
      assert.equal(await on(pollRow, 'Reply').count(), 0)
      for (const [stop, time] of [
        [pollRow, pollRow.locator('[data-group-time] time')],
        [target, gutter],
      ]) {
        for (let i = 0; i < 30 && !(await stop.evaluate(el => el === document.activeElement)); i++)
          await x.p.keyboard.press('Tab')
        assert.equal(await stop.evaluate(el => el === document.activeElement), true)
        assert.equal(await time.evaluate(el => getComputedStyle(el).opacity), '1')
      }
      await x.ctx.close()
    }
  }
  assert.equal(await reply.evaluate(el => getComputedStyle(el).opacity), '1')
  await consecutive.getByText(posts[1].content, { exact: true }).click({ button: 'right' })
  await b.f.getByRole('menuitem', { name: 'Reply', exact: true }).click()
  await editor(b).fill('A reply to the continuation')
  await editor(b).press('Enter')
  await a.f.getByText('A reply to the continuation', { exact: true }).waitFor()
  const answer = (await ok('GET', `/channels/${text}/messages`)).find(
    m => m.content === 'A reply to the continuation'
  )
  assert.equal(answer.reply_to.id, posts[1].id)
  assert.notEqual(answer.author.username, posts[1].author.username)
  const managerContext = patient(await browser.newContext())
  contexts.push(managerContext)
  const managerPage = await managerContext.newPage()
  await managerPage.goto(base + '/login/')
  await managerPage.getByRole('textbox', { name: 'Username' }).fill(account)
  await managerPage.locator('input[type=password]').fill(password)
  await on(managerPage, 'Log in').last().click()
  await on(managerPage, 'Settings').filter({ visible: true }).first().waitFor()
  await managerPage.goto(base + '/s/' + server + '/' + text + '/')
  await on(managerPage, 'Server settings').filter({ visible: true }).first().waitFor()
  await managerPage.keyboard.press('Control+k')
  const streamerPalette = managerPage.getByRole('dialog', { name: 'Command palette' })
  await streamerPalette.getByRole('combobox').fill('>streamer')
  await streamerPalette.getByRole('option', { name: /Turn on streamer mode/i }).click()
  await on(managerPage, 'Server settings').filter({ visible: true }).first().click()
  const settings = managerPage.getByRole('dialog')
  await settings.getByLabel('Widget', { exact: true }).selectOption(chat.id)
  await on(settings, 'Preview widget').click()
  const preview = managerPage.frameLocator('iframe[title="Widget preview"]')
  const quotedRow = article(preview, answer)
  const masked = [quotedRow.locator('strong'), quotedRow.locator('.border-l-2 .streamer')]
  for (const [i, label] of masked.entries()) {
    assert.equal(await label.textContent(), [answer, posts[1]][i].author.display_name)
    assert.equal(await label.evaluate(el => getComputedStyle(el).filter), 'blur(5px)')
  }
  await on(preview, 'Sign in').waitFor()
  await preview.getByRole('textbox', { name: 'Message as a guest' }).waitFor()
  const originalFrame = managerPage.frames().find(f => f.url().includes(chat.id))
  for (const enabled of [false, true]) {
    await managerPage.keyboard.press('Control+k')
    const palette = managerPage.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox').fill('>streamer')
    await palette
      .getByRole('option', {
        name: new RegExp('Turn ' + (enabled ? 'on' : 'off') + ' streamer mode', 'i'),
      })
      .click()
    for (const label of masked)
      await until(
        async () =>
          (await label.evaluate(el => getComputedStyle(el).filter)) ===
          (enabled ? 'blur(5px)' : 'none'),
        'Open preview did not follow streamer mode'
      )
    assert.ok(!originalFrame.isDetached())
    await preview.getByRole('textbox', { name: 'Message as a guest' }).waitFor()
  }
  await managerContext.close()
  console.log('PASS Streamer mode masks the message and quote authors in the manager preview')
  assert.equal(await article(a.f, answer).locator('[data-group-header]').count(), 1)
  const returning = await ok(
    'POST',
    `/channels/${text}/messages`,
    { content: 'Another sender starts here' },
    manager
  )
  await article(a.f, returning).locator('[data-group-header]').waitFor()
  console.log(
    'PASS 280px grouped chat: full account and guest avatars at group starts and sender/time breaks, aligned continuation without a picture, accessible articles and independent reply targets'
  )
  const scoped = async (w, readKey) => {
    const { ticket } = await ok('POST', '/widgets/' + w.id + '/session', {
      parent: host,
      read_key: readKey,
    })
    return { 'x-widget-parent': host, 'x-widget-session': ticket }
  }
  if (process.env.RCHAT_TEST_SQLITE_PATH) {
    const { Database } = await import('bun:sqlite')
    const db = new Database(process.env.RCHAT_TEST_SQLITE_PATH, { readwrite: true, create: false })
    try {
      const aged = db
        .query('UPDATE guest_chat_sessions SET last_used=last_used-? WHERE server=? AND author=?')
        .run(31 * 86400, server, posts[0].author.username)
      assert.equal(aged.changes, 1)
    } finally {
      db.close()
    }
    const attempts = []
    const match = 'Back after a month'
    a.p.on('response', res => {
      const req = res.request()
      if (
        req.method() !== 'POST' ||
        !new URL(res.url()).pathname.endsWith('/widgets/' + chat.id + '/messages')
      )
        return
      if (!req.postDataJSON()?.content.startsWith(match)) return
      const headers = req.headers()
      attempts.push({
        code: res.status(),
        credential: !!headers['x-guest-session'],
        scoped: !!headers['x-widget-session'] && headers['x-widget-parent'] === host,
      })
    })
    for (const content of [match, match + ' again']) {
      await editor(a).fill(content)
      await editor(a).press('Enter')
      await b.f.getByText(content, { exact: true }).waitFor()
    }
    const saved = (await ok('GET', `/channels/${text}/messages`)).filter(m =>
      m.content.startsWith(match)
    )
    assert.deepEqual(
      saved.map(m => m.content),
      [match, match + ' again']
    )
    assert.notEqual(saved[0].author.username, posts[0].author.username)
    assert.equal(saved[0].author.username, saved[1].author.username)
    assert.deepEqual(attempts, [
      { code: 401, credential: true, scoped: true },
      { code: 200, credential: false, scoped: true },
      { code: 200, credential: true, scoped: true },
    ])
    console.log(
      'PASS returning frame guest renews an inactive session and each message is stored once'
    )
  }
  const previews = await channel('programme', 'text')
  const post = (id, content) => ok('POST', `/channels/${id}/messages`, { content }, manager)
  const root = await post(previews, 'Programme for Saturday')
  const replyTarget = await ok(
    'POST',
    '/messages/' + root.id + '/thread',
    { content: 'Meet at the east entrance' },
    manager
  )
  const sibling = await post(other, 'Sunday afternoon meetup')
  const inRoom = `${base}/s/${server}/${previews}/t/${root.id}/${replyTarget.id}/`
  const outOfRoom = `${base}/s/${server}/${other}/${sibling.id}/`
  const programme = await post(previews, inRoom + '\n' + outOfRoom)
  for (const mode of ['public_read', 'public_chat', 'members', 'read_link']) {
    const w = await widget(previews, mode)
    const headers = await scoped(w, w.read_key)
    const path = '/widgets/' + w.id + '/locations'
    const body = { ids: [replyTarget.id, sibling.id] }
    assert.deepEqual(
      (await ok('POST', path, body, mode === 'members' ? manager : null, headers)).map(
        card => card.id
      ),
      [replyTarget.id]
    )
    if (mode === 'members')
      assert.equal((await request('POST', path, body, null, headers)).status, 404)
    assert.equal(
      (await request('POST', path, body, null, { ...headers, 'x-widget-parent': deniedHost }))
        .status,
      404
    )
    const x = await frame(w, w.read_key ? { key: w.read_key } : {})
    if (mode === 'members') {
      await on(x.f, 'Sign in').click()
      await x.f.getByLabel('Username').fill(account)
      await x.f.getByLabel('Password', { exact: true }).fill(password)
      await on(x.f, 'Sign in to widget').click()
    }
    const row = article(x.f, programme)
    const card = row.locator('[data-link-card]')
    await card.getByText(replyTarget.content, { exact: true }).waitFor()
    assert.equal(await card.count(), 1)
    assert.equal(await row.getByText(sibling.content, { exact: true }).count(), 0)
    const link = row.getByRole('link', { name: outOfRoom, exact: true })
    assert.equal(await link.getAttribute('href'), outOfRoom)
    assert.equal(await link.getAttribute('target'), '_blank')
    assert.ok(x.lookups.length > 0)
    for (const lookup of x.lookups) {
      assert.ok(lookup.path.endsWith(path))
      assert.deepEqual(lookup.ids, [replyTarget.id])
    }
    await x.ctx.close()
  }
  console.log(
    'PASS same-channel thread previews and plain sibling links in all four chat access modes'
  )
  const scope = await scoped(chat)
  assert.equal(
    (await request('POST', '/widgets/' + chat.id + '/session', { parent: deniedHost })).status,
    404
  )
  assert.equal(
    (
      await request(
        'POST',
        '/widgets/' + chat.id + '/messages',
        { content: 'Other channel', channel_id: other },
        null,
        scope
      )
    ).status,
    422
  )
  assert.equal((await request('GET', path + '/widgets')).status, 401)
  const outsider = await signup('viewer' + suffix)
  assert.ok(
    [403, 404].includes((await request('GET', path + '/widgets', undefined, outsider)).status)
  )

  assert.equal(
    (await request('GET', '/widgets/' + read.id + '/view', undefined, null, scope)).status,
    404
  )
  assert.equal(
    (
      await request('GET', '/widgets/' + chat.id + '/view', undefined, null, {
        ...scope,
        'x-widget-parent': deniedHost,
      })
    ).status,
    404
  )
  for (const w of [read, link, withoutComposer]) {
    const embed = await frame(w, { send: 'on', ...(w.read_key ? { key: w.read_key } : {}) })
    await embed.f.getByText('Read-only chat').waitFor()
    assert.equal(
      (
        await request(
          'POST',
          '/widgets/' + w.id + '/messages',
          { content: 'Read only' },
          undefined,
          await scoped(w, w.read_key)
        )
      ).status,
      404
    )
    if (w === link) await embed.f.getByText('Only in the other channel').waitFor()
    await embed.ctx.close()
  }
  const hidden = await frame(chat, { send: 'off' })
  await hidden.f.getByText('Read-only chat').waitFor()
  await hidden.ctx.close()
  await article(a.f, earlier).getByText(earlier.content, { exact: true }).click({ button: 'right' })
  const openReply = a.f.getByRole('menuitem', { name: 'Reply', exact: true })
  await openReply.waitFor()
  await config({ guest_chat_opt_in: false })
  await openReply.waitFor({ state: 'hidden' })
  await a.f.getByText('Read-only chat').waitFor()
  assert.equal(
    (await request('POST', '/widgets/' + chat.id + '/messages', { content: 'Closed' }, null, scope))
      .status,
    404
  )
  await on(b.f, 'Sign in').click()
  await b.f.getByRole('textbox', { name: 'Username' }).fill(account)
  await b.f.getByLabel('Password', { exact: true }).fill(password)
  await on(b.f, 'Sign in to widget').click()
  await b.f.getByRole('textbox', { name: 'Message', exact: true }).fill('Account inside the frame')
  await b.f.getByRole('textbox', { name: 'Message', exact: true }).press('Enter')
  await a.f.getByText('Account inside the frame').waitFor()
  const accountRows = (await ok('GET', `/channels/${text}/messages`)).filter(
    m => m.content === 'Account inside the frame'
  )
  assert.deepEqual(
    accountRows.map(m => m.author.username),
    [account]
  )
  await site({ widget_chat: false })
  await b.f.getByText('Read-only chat').waitFor()
  assert.equal(
    (
      await request(
        'POST',
        '/widgets/' + chat.id + '/messages',
        { content: 'Closed' },
        manager,
        scope
      )
    ).status,
    404
  )
  await site({ widget_chat: true })
  console.log(
    'PASS cross-origin chat, storage denial, read links, history, live delivery, signed-in rights, origin and channel isolation'
  )
  const copyist = 'copyist' + suffix,
    renewed = 'renewed-' + password
  const copyistToken = await signup(copyist)
  await ok('POST', path + '/join', {}, copyistToken)
  await config({ guest_chat_opt_in: true })
  const copies = await widget(text, 'public_chat')
  const signIn = async (x, secret = password) => {
    await on(x.f, 'Sign in').click()
    await x.f.getByRole('textbox', { name: 'Username' }).fill(copyist)
    await x.f.getByLabel('Password', { exact: true }).fill(secret)
    // Password checks wait in a bounded server queue that can ask a busy client to retry.
    for (let attempt = 1; ; attempt++) {
      const [response] = await Promise.all([
        x.p.waitForResponse(r => new URL(r.url()).pathname.endsWith('/auth/login')),
        on(x.f, 'Sign in to widget').click(),
      ])
      if (response.status() !== 429 || attempt === 5) break
      await delay(1000 * (Number(response.headers()['retry-after']) || 3))
    }
    await on(x.f, 'Sign out').waitFor()
  }
  const field = (x, guest) =>
    x.f.getByRole('textbox', { name: guest ? 'Message as a guest' : 'Message', exact: true })
  const stored = async content =>
    (await ok('GET', `/channels/${text}/messages`)).filter(m => m.content === content)
  const first = await frame(copies),
    second = await frame(copies, {}, host, { context: first.ctx })
  await signIn(first)
  await on(second.f, 'Sign out').waitFor()
  const unsent = 'Typed while the other copy signs out'
  await field(second, false).fill(unsent)
  await on(first.f, 'Sign out').click()
  // The sign-out reaches the other copy as a storage event or as its revoked sign-in.
  await second.f
    .getByText(/^Your sign-in (changed|expired)\. Your unsent text is still here\.$/)
    .waitFor()
  assert.deepEqual(await stored(unsent), [])
  await on(second.f, 'Restore draft').click()
  assert.equal(await field(second, true).inputValue(), unsent)
  await field(second, true).press('Enter')
  await second.f.locator('article').getByText(unsent, { exact: true }).waitFor()
  const asGuest = await stored(unsent)
  assert.equal(asGuest.length, 1)
  assert.notEqual(asGuest[0].author.username, copyist)
  await signIn(first)
  const revoked = 'Typed before the sign-in was revoked'
  await field(second, false).fill(revoked)
  const unauthorized = []
  second.p.on('response', r => {
    if (r.status() === 401) unauthorized.push(new URL(r.url()).pathname)
  })
  // Hold signed-in room checks so the send is the request that meets the revoked sign-in.
  const held = Promise.withResolvers()
  const hold = async route => {
    if (route.request().headers().authorization) await held.promise
    await route.continue().catch(() => {})
  }
  await first.ctx.route('**/widgets/' + copies.id + '/room', hold)
  try {
    await ok(
      'POST',
      '/me/password',
      { current: { password }, new: { password: renewed } },
      copyistToken
    )
    await field(second, false).press('Enter')
    await second.f.getByText('Your sign-in expired.').waitFor()
  } finally {
    held.resolve()
    await first.ctx.unroute('**/widgets/' + copies.id + '/room', hold)
  }
  assert.ok(unauthorized.some(url => url.endsWith('/widgets/' + copies.id + '/messages')))
  await on(first.f, 'Sign in').waitFor()
  assert.deepEqual(await stored(revoked), [])
  await signIn(second, renewed)
  await on(second.f, 'Restore draft').click()
  assert.equal(await field(second, false).inputValue(), revoked)
  await field(second, false).press('Enter')
  await second.f.locator('article').getByText(revoked, { exact: true }).waitFor()
  assert.deepEqual(
    (await stored(revoked)).map(m => m.author.username),
    [copyist]
  )
  await first.p.close()
  await second.p.close()
  await delay(3200)
  await ok(
    'POST',
    '/me/password',
    { current: { password: renewed }, new: { password } },
    copyistToken
  )
  const reopened = await frame(copies, {}, host, { context: first.ctx })
  await field(reopened, true).waitFor()
  await on(reopened.f, 'Sign in').waitFor()
  assert.equal(await on(reopened.f, 'Sign out').count(), 0)
  await first.ctx.close()
  await config({ guest_chat_opt_in: false })
  console.log(
    'PASS copies of a widget follow sign-in changes, a revoked sign-in keeps the unsent text for an explicit send, and a reopened frame drops a revoked saved sign-in'
  )
  for (const query of [{}, { delegate: '1', block: '1' }, { delegate: '1', denyDevice: '1' }]) {
    const denied = await frame(call, query)
    await on(denied.f, 'Join voice').click()
    await denied.f.getByRole('main').getByRole('alert').waitFor()
    assert.equal(await denied.document().evaluate(() => window.widgetTestMedia.tracks.length), 0)
    await denied.ctx.close()
  }
  voicePeer = await chromium.launch(browserOptions)
  const one = await frame(call, { delegate: '1', theme: 'light' }),
    two = await frame(call, { delegate: '1' }, host, { mobile: true, browser: voicePeer })
  const capture = x =>
    x
      .document()
      .evaluate(() => window.widgetTestMedia.tracks.filter(t => t.readyState === 'live').length)
  for (const x of [one, two]) {
    await until(() => on(x.f, 'Join voice').isEnabled(), 'Voice socket did not open')
    assert.equal(await x.document().evaluate(() => window.widgetTestMedia.requests), 0)
    await on(x.f, 'Join voice').click()
    await on(x.f, 'Leave voice').waitFor()
  }
  const stats = x =>
    x.document().evaluate(async () => {
      let energy = 0,
        packets = 0
      for (const pc of window.widgetTestMedia.peers) {
        if (pc.connectionState === 'closed') continue
        for (const stat of (await pc.getStats()).values())
          if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
            energy += stat.totalAudioEnergy ?? 0
            packets += stat.packetsReceived ?? 0
          }
      }
      return { energy, packets }
    })
  for (const x of [one, two]) {
    await until(async () => {
      const s = await stats(x)
      return s.packets > 5 && s.energy > 0
    }, 'No inbound microphone audio')
    const start = await stats(x)
    await until(async () => (await stats(x)).energy > start.energy, 'Audio stopped arriving')
    await until(
      () =>
        x
          .document()
          .evaluate(() =>
            Array.from(document.querySelectorAll('audio')).some(
              a =>
                !a.paused &&
                a.currentTime > 0 &&
                a.srcObject?.getAudioTracks().some(t => t.readyState === 'live')
            )
          ),
      'Remote audio did not play'
    )
    console.log('PASS received and played microphone RTP', await stats(x))
    assert.equal(await x.f.getByRole('listitem').count(), 2)
  }
  await on(one.f, 'Mute').click()
  assert.equal(
    await one.document().evaluate(() => window.widgetTestMedia.tracks.at(-1).enabled),
    false
  )
  await on(one.f, 'Unmute').click()
  assert.equal(
    await one.document().evaluate(() => window.widgetTestMedia.tracks.at(-1).enabled),
    true
  )
  const callScope = await scoped(call)
  const voiceView = () => ok('GET', '/widgets/' + call.id + '/view', undefined, manager, callScope)
  const guests = (await voiceView()).users
  assert.equal(guests.length, 2)
  const name = one.name()
  assert.ok(guests.includes(name))
  await ok('PUT', path + '/voice/' + encodeURIComponent(name) + '/mute', undefined, manager)
  await until(
    async () => (await on(one.f, 'Mute').isDisabled()) || (await on(two.f, 'Mute').isDisabled()),
    'Staff mute not applied'
  )
  await ok('DELETE', path + '/voice/' + encodeURIComponent(name) + '/mute', undefined, manager)
  // Hold one real peer status update until the other guest has left the room.
  await two.document().evaluate(to => {
    const send = WebSocket.prototype.send
    WebSocket.prototype.send = function (data) {
      const msg = JSON.parse(data)
      if (msg.type === 'rtc_signal' && msg.to === to && msg.payload.muted === true) {
        WebSocket.prototype.send = send
        window.releasePeerStatus = () => send.call(this, data)
      } else send.call(this, data)
    }
  }, name)
  await on(two.f, 'Mute').click()
  await until(
    () => two.document().evaluate(() => !!window.releasePeerStatus),
    'No mute update for peer'
  )
  await on(one.f, 'Leave voice').click()
  await until(async () => (await capture(one)) === 0, 'Leave kept the microphone')
  const remaining = guests.filter(user => user !== name)
  await until(
    async () => (await two.f.getByRole('listitem').count()) === 1,
    'Peer departure missing'
  )
  assert.deepEqual((await voiceView()).users, remaining)
  await two.document().evaluate(() => window.releasePeerStatus())
  await on(two.f, 'Unmute').click()
  await on(one.f, 'Join voice').click()
  await on(one.f, 'Leave voice').waitFor()
  await until(async () => (await two.f.getByRole('listitem').count()) === 2, 'Peer rejoin missing')
  assert.ok((await voiceView()).users.includes(remaining[0]))
  for (const x of [one, two]) {
    const start = await stats(x)
    await until(
      async () => (await stats(x)).energy > start.energy,
      'Audio did not resume with the returning peer'
    )
  }
  assert.equal(await two.document().evaluate(() => window.widgetTestMedia.requests), 1)
  assert.equal(await two.f.getByRole('main').getByRole('alert').count(), 0)
  await on(one.f, 'Leave voice').click()
  await until(async () => (await voiceView()).users.length === 1, 'Returning guest did not leave')
  assert.equal(await capture(two), 1)
  console.log(
    'PASS late peer signal after Leave preserves the remaining seat and microphone, with two-way audio on rejoin'
  )
  await one.p.locator('iframe').evaluate(e => e.remove())
  // A same-origin observer keeps a reference to the track across removal of its document.
  // The external host receives neither this reference nor device information.
  await two.p.evaluate(
    url => {
      const observer = document.createElement('iframe')
      observer.title = 'Capture observer'
      observer.src = url
      document.body.append(observer)
    },
    base + '/widget/?id=' + read.id
  )
  const observer = two.p.frameLocator('iframe[title="Capture observer"]')
  await observer.getByText('Read-only chat').waitFor()
  const capturing = two.document()
  await capturing.evaluate(() => {
    window.parent.frames[1].observedTrack = window.widgetTestMedia.tracks.at(-1)
  })
  await two.p.locator('iframe[title="Embedded channel"]').evaluate(e => e.remove())
  const witness = two.p.frames().find(f => f.url().includes(read.id))
  await until(
    () => witness.evaluate(() => window.observedTrack.readyState === 'ended'),
    'Removing the iframe kept its microphone track live'
  )
  await until(async () => (await voiceView()).users.length === 0, 'Frame removal left a voice seat')
  console.log(
    'PASS microphone delegation, no capture on open, two audio participants, roster, mute, staff mute, leave and frame removal'
  )
  const live = await frame(call, { delegate: '1' })
  await on(live.f, 'Join voice').click()
  await on(live.f, 'Leave voice').waitFor()
  await config({ guest_voice_opt_in: false })
  await live.f.getByText('Voice participation is unavailable.').waitFor()
  assert.equal(await capture(live), 0)
  const refused = await live.document().evaluate(
    async ({ id, ticket, parent, voice }) => {
      const ws = new WebSocket(location.origin.replace('http', 'ws') + '/api/v1/ws?widget=' + id)
      return await new Promise(resolve => {
        const timer = setTimeout(() => {
          ws.close()
          resolve(false)
        }, 6000)
        ws.onopen = () => ws.send(JSON.stringify({ ticket, parent }))
        ws.onmessage = e => {
          const event = JSON.parse(e.data)
          if (event.type === 'widget_ready')
            ws.send(JSON.stringify({ type: 'voice_join', channel_id: voice }))
          if (event.type === 'voice_state') {
            clearTimeout(timer)
            resolve(false)
            ws.close()
          }
        }
        ws.onclose = () => {
          clearTimeout(timer)
          resolve(true)
        }
      })
    },
    { id: call.id, ticket: callScope['x-widget-session'], parent: host, voice }
  )
  assert.equal(refused, true)
  console.log('PASS live guest voice revocation, capture release and socket refusal')
  const restoredAt = Date.now()
  await config({ guest_voice_opt_in: true })
  // Once its socket closes, the open widget rechecks the room every 30 seconds.
  await on(live.f, 'Join voice').click({ timeout: 60000 })
  await on(live.f, 'Leave voice').waitFor()
  console.log('PASS open voice frame rejoins after access returns', Date.now() - restoredAt, 'ms')
  const moderated = live.name()
  assert.deepEqual((await voiceView()).users, [moderated])
  await ok(
    'POST',
    path + '/voice/' + encodeURIComponent(moderated) + '/disconnect',
    undefined,
    manager
  )
  await until(async () => (await capture(live)) === 0, 'Staff disconnect kept the microphone')
  assert.deepEqual((await voiceView()).users, [])
  await config({ guest_voice_opt_in: false })
  console.log('PASS staff disconnect removes the guest and releases capture')
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  contexts.push(patient(phone))
  await phone.addInitScript(s => {
    localStorage.setItem('rchat_guest', '1')
    localStorage.setItem('rchat_guest_servers', JSON.stringify([s]))
  }, server)
  const screen = await phone.newPage(),
    emulation = await phone.newCDPSession(screen)
  await emulation.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  })
  await emulation.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'display-mode', value: 'standalone' }],
  })
  await screen.goto(base + '/s/' + server + '/' + text + '/')
  for (const enabled of [true, false]) {
    await config({ guest_chat_opt_in: enabled })
    const bar = screen.locator(enabled ? '[data-guest-editor]' : '[data-guest-notice]').first()
    await bar.waitFor()
    for (const keyboard of [false, true]) {
      if (enabled && keyboard) await bar.getByRole('textbox').focus()
      await screen.evaluate(open => {
        const viewport = window.visualViewport
        Object.defineProperty(viewport, 'height', {
          configurable: true,
          value: (window.innerHeight - (open ? 300 : 0)) / viewport.scale,
        })
        viewport.dispatchEvent(new Event('resize'))
      }, keyboard)
      await screen.waitForFunction(
        open => document.documentElement.hasAttribute('data-keyboard') === open,
        keyboard
      )
      const gap = await bar.evaluate(
        (el, enabled) =>
          parseFloat(
            enabled ? getComputedStyle(el).paddingBottom : getComputedStyle(el).marginBottom
          ),
        enabled
      )
      assert.equal(gap, keyboard ? 12 : 34)
    }
    if (enabled) {
      const field = bar.getByRole('textbox')
      await field.fill('Guest main screen on a phone')
      await field.press('Enter')
      await b.f.getByText('Guest main screen on a phone').waitFor()
    }
  }
  await phone.close()
  console.log(
    'PASS main guest editor, stored message, notice and phone bottom inset with keyboard open and closed'
  )
  await config({ guest_chat_opt_in: true })
  await editor(a).waitFor()
  const moderation = await ok('POST', `/channels/${text}/guest-messages`, {
    content: 'Guest message for moderation',
  })
  await ok('POST', `/messages/${moderation.message.id}/pause-guest`, undefined, manager)
  await a.f.getByText('Read-only chat').waitFor()
  assert.ok(
    (await ok('GET', `/channels/${text}/guest-messages`, undefined, null, {
      'x-guest-session': moderation.session,
    })) >
      Date.now() / 1000
  )
  assert.equal(
    (await request('POST', `/channels/${text}/guest-messages`, { content: 'Moderated guest' }))
      .status,
    403
  )
  await ok('DELETE', '/messages/' + moderation.message.id, undefined, manager)
  assert.ok(
    !(await ok('GET', `/channels/${text}/messages`)).some(m => m.id === moderation.message.id)
  )
  console.log('PASS moderator pause, live read-only frame and message deletion')
  const privateName = 'private' + suffix,
    privatePath = '/servers/' + privateName
  const vault = await ok('POST', '/servers', { name: privateName, password }, manager)
  const privateText = vault.channels.find(c => c.kind === 'text').id
  const privateVoice = (
    await ok('POST', privatePath + '/channels', { name: 'private-voice', kind: 'voice' }, manager)
  ).id
  await ok('PATCH', privatePath, { guest_chat_opt_in: true, guest_voice_opt_in: true }, manager)
  const privateConfig = {
    channel_id: privateVoice,
    mode: 'voice',
    enabled: true,
    composer: false,
    origins: [host],
  }
  const privateCall = await ok('POST', privatePath + '/widgets', privateConfig, manager)
  const privateFrame = await frame(privateCall, { delegate: '1' })
  await on(privateFrame.f, 'Use server password').waitFor()
  assert.equal(await privateFrame.f.getByText('private-voice').count(), 0)
  const limit = await ok(
    'POST',
    privatePath + '/passwords',
    { password: 'guest-password-one', max_uses: 1 },
    manager
  )
  const tempGrant = (await ok('POST', privatePath + '/guest_access', { password }, null)).grant
  const limited = (
    await ok('POST', privatePath + '/guest_access', { password: 'guest-password-one' })
  ).grant
  const pathText = '/channels/' + privateText + '/guest-messages'
  assert.equal((await request('POST', pathText, { content: 'Missing grant' })).status, 404)
  assert.equal(
    (await request('POST', privatePath + '/guest_access', { password: 'guest-password-one' }))
      .status,
    404
  )
  const permitted = await ok('POST', pathText, { content: 'Text with a limited grant' }, null, {
    'x-guest-grant': limited,
  })
  assert.ok(permitted.message.author.username.startsWith('@guest:'))
  await ok('DELETE', privatePath + '/passwords/' + limit.id, undefined, manager)
  assert.equal(
    (
      await request('POST', pathText, { content: 'After revocation' }, null, {
        'x-guest-grant': limited,
        'x-guest-session': permitted.session,
      })
    ).status,
    404
  )
  const privateScope = await scoped(privateCall)
  const metaPath = '/widgets/' + privateCall.id + '/room'
  assert.equal((await request('GET', metaPath, undefined, null, privateScope)).status, 404)
  assert.equal(
    (await request('GET', metaPath, undefined, null, { ...privateScope, 'x-guest-grant': limited }))
      .status,
    404
  )
  assert.deepEqual(
    await ok('GET', metaPath, undefined, null, { ...privateScope, 'x-guest-grant': tempGrant }),
    { server: privateName, channel_id: privateVoice, kind: 'voice' }
  )
  assert.deepEqual(await ok('GET', metaPath, undefined, manager, privateScope), {
    server: privateName,
    channel_id: privateVoice,
    kind: 'voice',
  })
  assert.deepEqual(privateFrame.content, [])
  console.log(
    'PASS private room discovery checks grants, revocation and membership before disclosing identity'
  )
  assert.equal(
    (await request('GET', '/widgets/' + privateCall.id + '/view', undefined, null, privateScope))
      .status,
    404
  )
  assert.equal(
    (
      await ok('GET', '/widgets/' + privateCall.id + '/view', undefined, null, {
        ...privateScope,
        'x-guest-grant': tempGrant,
      })
    ).channel_id,
    privateVoice
  )
  const existing = await ok(
    'POST',
    privatePath + '/passwords',
    { password: 'voice-password-one', max_uses: 1 },
    manager
  )
  await on(privateFrame.f, 'Use server password').click()
  await privateFrame.f.getByLabel('Password', { exact: true }).fill('voice-password-one')
  await on(privateFrame.f, 'Open room').click()
  await on(privateFrame.f, 'Join voice').click()
  await on(privateFrame.f, 'Leave voice').waitFor()
  await ok('DELETE', privatePath + '/passwords/' + existing.id, undefined, manager)
  await on(privateFrame.f, 'Use server password').waitFor()
  assert.equal(await capture(privateFrame), 0)
  // A member signs into the same room with ordinary credentials and remains in it when guest participation ends.
  await on(privateFrame.f, 'Sign in').click()
  await privateFrame.f.getByRole('textbox', { name: 'Username' }).fill(account)
  await privateFrame.f.getByLabel('Password', { exact: true }).fill(password)
  await on(privateFrame.f, 'Sign in to widget').click()
  await on(privateFrame.f, 'Join voice').click()
  await on(privateFrame.f, 'Leave voice').waitFor()
  await site({ guest_voice_enabled: false })
  await until(
    async () =>
      (
        await ok('GET', '/widgets/' + privateCall.id + '/view', undefined, manager, privateScope)
      ).users.includes(account),
    'Member left voice'
  )
  await delay(3300)
  assert.equal(await capture(privateFrame), 1)
  const replacement = await frame(privateCall, { delegate: '1' })
  await on(replacement.f, 'Sign in').click()
  await replacement.f.getByRole('textbox', { name: 'Username' }).fill(account)
  await replacement.f.getByLabel('Password', { exact: true }).fill(password)
  await on(replacement.f, 'Sign in to widget').click()
  await on(replacement.f, 'Join voice').click()
  await on(replacement.f, 'Leave voice').waitFor()
  await until(async () => (await capture(privateFrame)) === 0, 'Replaced seat kept its microphone')
  assert.equal(await capture(replacement), 1)
  assert.deepEqual(
    (await ok('GET', '/widgets/' + privateCall.id + '/view', undefined, manager, privateScope))
      .users,
    [account]
  )
  console.log('PASS signed-in seat replacement releases only the displaced connection')
  await ok(
    'PUT',
    privatePath + '/widgets/' + privateCall.id,
    { ...privateConfig, enabled: false },
    manager
  )
  await replacement.f.getByText('This widget is unavailable.').waitFor()
  assert.equal(await capture(replacement), 0)
  assert.equal(
    (await request('GET', '/widgets/' + privateCall.id + '/view', undefined, manager, privateScope))
      .status,
    404
  )
  console.log(
    'PASS protected chat and voice, limited-use grant, revocation, signed-in voice and widget shutdown'
  )
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => {})
  if (voicePeer) await voicePeer.close()
  if (browser) await browser.close()
  for (const server of servers) {
    server.closeAllConnections()
    server.close()
  }
  await site(Object.fromEntries(Object.keys(controls).map(k => [k, saved[k]])))
}
