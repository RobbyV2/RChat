// Hosted two-instance callback using the same sign-in fixture as the account switcher.
import assert from 'node:assert/strict'
async function run({ actors, origins, fillCredentials, signIn }) {
  const p = actors.get('Alpha/alice').page
  const host = Object.fromEntries(
    Object.entries(origins).map(([name, url]) => [name, new globalThis.URL(url).host])
  )
  const rail = p
    .locator('nav')
    .filter({ has: p.locator('[data-rail=add-server]') })
    .filter({ visible: true })
    .first()
  const add = async (label, user) => {
    await rail.getByRole('button', { name: 'Add an instance', exact: true }).click()
    await p.getByLabel('Instance address').fill(origins[label])
    await p.getByLabel('Instance address').press('Enter')
    if (label === 'Beta') await p.getByRole('button', { name: 'I trust this app' }).click()
    else await p.getByRole('button', { name: 'Add another account on ' + host[label] }).click()
    await fillCredentials(p, label, user)
    const submit = async () => {
      const [response] = await Promise.all([
        p.waitForResponse(r => r.url() === origins[label] + '/api/v1/auth/login'),
        p.locator('[data-add-instance-step] form button[type=submit]').click(),
      ])
      return response.status()
    }
    let status = await submit()
    if (status === 429) {
      await new Promise(resolve => globalThis.setTimeout(resolve, 3100))
      status = await submit()
    }
    assert.equal(status, 200)
    await p.waitForFunction(id => globalThis.history.state?.acct === id, user + '@' + host[label])
  }
  const server = 'garden'
  const create = async () => {
    await rail.getByRole('button', { name: 'Add a server', exact: true }).click()
    const d = p.getByRole('dialog', { name: 'Add a server' })
    await d.getByLabel('Server name').fill(server)
    await d.getByRole('button', { name: 'Create', exact: true }).last().click()
    await d.waitFor({ state: 'hidden' })
  }
  await p.evaluate(() => {
    globalThis.window.railDocument = true
  })
  await create()
  assert.equal(await rail.locator('[data-account-section]').count(), 0)
  const sibling = await signIn('Alpha', 'bob')
  try {
    const page = sibling.page
    const localRail = page
      .locator('nav')
      .filter({ has: page.locator('[data-rail=add-server]') })
      .filter({ visible: true })
      .first()
    await localRail.getByRole('button', { name: 'Add an instance', exact: true }).click()
    await page.getByLabel('Instance address').fill(origins.Alpha)
    await page.getByLabel('Instance address').press('Enter')
    await page.getByRole('button', { name: 'Add another account on ' + host.Alpha }).click()
    await fillCredentials(page, 'Alpha', 'alice2')
    await page.locator('form button[type=submit]').click()
    await page.waitForFunction(id => globalThis.history.state?.acct === id, 'alice2@' + host.Alpha)
    assert.equal(await localRail.locator('[data-account-section]>button[aria-expanded]').count(), 2)
    assert.equal(await localRail.locator('button[title$="(' + host.Alpha + ')"]').count(), 0)
  } finally {
    await sibling.page.context().close()
  }
  globalThis.console.log(
    'PASS two accounts on Alpha show account headers without an instance header'
  )
  await add('Beta', 'alice')
  await create()
  const tiles = rail.locator('[data-rail=servers] button[title^="garden"]')
  assert.equal(await tiles.count(), 2)
  const instance = rail.locator('button[title$="(' + host.Alpha + ')"]')
  await instance.click()
  assert.equal(await tiles.count(), 1)
  await instance.click()
  await tiles.first().click()
  await p.waitForFunction(id => globalThis.history.state?.acct === id, 'alice@' + host.Alpha)
  assert.equal(await p.evaluate(() => globalThis.window.railDocument), true)
  globalThis.console.log(
    'PASS separate Alpha/Beta garden tiles, collapse and instant background server navigation'
  )
  await add('Alpha', 'alice2')
  await p.evaluate(async () => {
    const token = globalThis.localStorage.getItem('rchat_token:alice2')
    const api = async (method, path, body) => {
      const out = await globalThis.fetch('/api/v1' + path, {
        method,
        headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (!out.ok) throw new Error('fixture API ' + method + ' ' + out.status)
      return out.json()
    }
    await api('POST', '/servers/garden/join', {})
    const server = await api('GET', '/servers/garden')
    const channel = server.channels.find(c => c.kind === 'text')
    await api('POST', '/channels/' + channel.id + '/messages', { content: '@alice rail test' })
  })
  await rail
    .locator('[data-account-section] button[title^="garden"][title*="notification"]')
    .first()
    .waitFor()
  assert.equal(
    await rail
      .locator('[data-account-section] button[title^="garden"][title*="notification"]')
      .count(),
    1
  )
  globalThis.console.log('PASS same-named server badge updates on just its mentioned account')
  const headers = rail.locator('[data-account-section]>button[aria-expanded]')
  assert.equal(await headers.count(), 2)
  await headers.first().click({ button: 'right' })
  await p
    .getByText('Show this account', { exact: true })
    .filter({ visible: true })
    .first()
    .waitFor()
  const readRequest = p.waitForRequest(
    r => new globalThis.URL(r.url()).origin === origins.Alpha && r.url().endsWith('/read/batch')
  )
  await p.getByText('Mark all read', { exact: true }).filter({ visible: true }).first().click()
  const request = await readRequest
  assert(
    await p.evaluate(
      header => header === 'Bearer ' + globalThis.localStorage.getItem('rchat_token:alice'),
      request.headers().authorization
    )
  )
  assert.equal(await p.evaluate(() => globalThis.history.state.acct), 'alice2@' + host.Alpha)
  await headers.first().click({ button: 'right' })
  const kept = () =>
    p.evaluate(
      origin =>
        JSON.parse(globalThis.localStorage.getItem('rchat_book'))
          .instances.find(i => i.origin === origin)
          .accounts.find(a => a.username === 'alice').connect,
      origins.Alpha
    )
  const before = await kept()
  await p.getByText('Keep connected', { exact: true }).filter({ visible: true }).first().click()
  await p.waitForFunction(
    ({ origin, before }) =>
      JSON.parse(globalThis.localStorage.getItem('rchat_book'))
        .instances.find(i => i.origin === origin)
        .accounts.find(a => a.username === 'alice').connect !== before,
    { origin: origins.Alpha, before }
  )
  assert.equal(await p.evaluate(() => globalThis.history.state.acct), 'alice2@' + host.Alpha)
  for (const name of ['personal', 'work']) {
    await rail.locator('[data-switcher-tile]').click()
    const manage = p.getByRole('dialog', { name: /^(Switch account|Manage accounts)$/ })
    await manage.getByRole('button', { name: 'Manage accounts', exact: true }).click()
    const row = manage.locator(
      '[data-account-row=' + JSON.stringify(JSON.stringify([origins.Alpha, 'alice2', null])) + ']'
    )
    await row.locator('..').getByTitle('Account actions').click()
    await manage.getByRole('button', { name: 'Add a P2P identity' }).click()
    await manage.getByRole('button', { name: 'I trust this app' }).click()
    await manage.getByLabel('Identity name').fill(name)
    await manage.getByRole('button', { name: 'Continue', exact: true }).click()
    await manage.getByRole('button', { name: 'Create without a recovery phrase' }).click()
    await manage.waitFor({ state: 'hidden' })
  }
  await rail.getByRole('button', { name: 'Home', exact: true }).click()
  const work = rail
    .locator('[data-peer-home]')
    .and(p.getByRole('button', { name: /work, P2P as alice2 on Alpha/ }))
  await work.click()
  assert.match(await rail.locator('[data-switcher-tile]').innerText(), /work/i)
  globalThis.console.log('PASS sibling P2P identity tile selects its actor')
  await p.setViewportSize({ width: 390, height: 844 })
  if (!(await p.locator('[data-switcher-tile]:visible').count()))
    await p
      .getByRole('button', {
        name: /Open navigation|Open menu|Open sidebar|Show navigation|^Menu$/i,
      })
      .first()
      .click()
  const cdp = await p.context().newCDPSession(p)
  const header = headers.first()
  await header.scrollIntoViewIfNeeded()
  const box = await header.boundingBox()
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
  })
  await p
    .getByText('Show this account', { exact: true })
    .filter({ visible: true })
    .first()
    .waitFor()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
  await p.keyboard.press('Escape')
  await tiles.last().click()
  await p.waitForFunction(id => globalThis.history.state?.acct === id, 'alice@' + host.Beta)
  globalThis.console.log(
    'PASS same-origin sibling account headers, owned account menu and mobile cross-instance navigation'
  )
  await p.setViewportSize({ width: 1280, height: 800 })
  await p.evaluate(origin => {
    const store = globalThis.localStorage
    store.setItem('rchat_live_budget', '1')
    const account = JSON.parse(store.getItem('rchat_book'))
      .instances.find(i => i.origin === origin)
      .accounts.find(a => a.username === 'alice2')
    const { local } = account.identities.find(i => i.name === 'work')
    store.setItem(
      'rchat_counts:' + JSON.stringify([origin, 'alice2']),
      JSON.stringify({ instance: 0, unread: 0, peers: { [local]: 7 } })
    )
  }, origins.Alpha)
  await p.reload()
  const cold = rail.locator('[data-account-section]').filter({
    has: p.getByRole('button', { name: 'alice2 on Alpha', exact: true }),
  })
  await cold.getByRole('button', { name: 'Show alice2 on ' + host.Alpha, exact: true }).waitFor()
  assert.equal(await cold.locator('[data-rail=servers] button').count(), 0)
  await cold
    .getByRole('button', { name: 'alice2 on Alpha', exact: true })
    .click({ button: 'right' })
  const unavailable = p.getByRole('menuitem', { name: /Mark all read/ }).filter({ visible: true })
  assert(await unavailable.isDisabled())
  await p.keyboard.press('Escape')
  const personal = rail.getByRole('button', {
    name: 'personal, P2P as alice2 on Alpha',
    exact: true,
  })
  await personal.waitFor()
  await work.locator('[data-ping-badge="7"]').waitFor()
  await work.click()
  await p.waitForFunction(() =>
    globalThis.document
      .querySelector('[data-switcher-tile]')
      ?.title.startsWith('Acting as work on Alpha')
  )
  assert.equal(await p.evaluate(() => globalThis.history.state.acct), 'alice2@' + host.Alpha)
  assert.equal(await personal.getAttribute('aria-pressed'), 'false')
  assert.equal(await work.getAttribute('aria-pressed'), 'true')
  const siblingBlock = rail
    .locator('[data-account-section]')
    .filter({ has: p.getByRole('button', { name: 'alice on Alpha', exact: true }) })
  await siblingBlock
    .getByRole('button', { name: 'Show alice on ' + host.Alpha, exact: true })
    .waitFor()
  globalThis.console.log(
    'PASS cold header, disabled read action, parked identity badge and owner-scoped resumption'
  )
}

export async function check(args) {
  try {
    await run(args)
  } catch (e) {
    globalThis.console.error('Rail check: ' + String(e.message).split('\n')[0])
    throw e
  }
}
