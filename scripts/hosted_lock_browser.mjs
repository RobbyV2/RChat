/* global URL, history, localStorage, fetch, console */
import assert from 'node:assert/strict'

// Runs against the isolated two-instance fixture. Alpha/alice is its first registered user.
export async function check({ actors, origins, fillCredentials }) {
  const page = actors.get('Alpha/alice').page
  const menu = page.getByRole('dialog', { name: 'Switch account' })
  const tile = page.locator('[data-switcher-tile]:visible')
  const host = label => new URL(origins[label]).host
  const row = (label, user) =>
    page.locator(
      '[data-account-row=' + JSON.stringify(JSON.stringify([origins[label], user, null])) + ']'
    )
  async function add(label, user) {
    await tile.click()
    if (label === 'Beta') {
      await menu.getByRole('button', { name: 'Add an instance', exact: true }).click()
      const input = page.getByLabel('Instance address', { exact: true })
      await input.fill(origins[label])
      await input.press('Enter')
      await page.getByRole('button', { name: 'I trust this app' }).click()
    } else await menu.getByRole('button', { name: 'Add an account on Alpha', exact: true }).click()
    await fillCredentials(page, label, user)
    await page.locator('[data-add-instance-step] form button[type=submit]').click()
    await page.waitForFunction(id => history.state?.acct === id, user + '@' + host(label))
  }
  async function toggle(enabled) {
    const code = await page.evaluate(async value => {
      const token = localStorage.getItem('rchat_token:alice') ?? localStorage.getItem('rchat_token')
      return (
        await fetch('/api/v1/admin/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ client_other_instances: value }),
        })
      ).status
    }, enabled)
    assert.equal(code, 200, 'operator PATCH /admin/settings')
  }
  const message = `This site's app only connects to ${host('Alpha')}. Use the RChat app or another web app for other instances.`
  const betaPath = '/@alice@' + host('Beta') + '/'
  let step = 'add Alpha/alice2 and Beta/alice'
  try {
    await add('Alpha', 'alice2')
    await add('Beta', 'alice')
    const before = await page.evaluate(() => localStorage.getItem('rchat_book'))
    step = 'invalidate a pending Beta join lookup while Add a server stays on Alpha'
    await page.goto(origins.Alpha + '/')
    const addServer = page
      .getByRole('button', { name: 'Add a server', exact: true })
      .filter({ visible: true })
      .first()
    await addServer.click()
    const serverDialog = page.getByRole('dialog', { name: 'Add a server' })
    await serverDialog
      .getByLabel('As', { exact: true })
      .selectOption({ label: 'alice · ' + host('Beta') })
    await serverDialog
      .getByRole('button', { name: /^join$/i })
      .first()
      .click()
    const query = url =>
      url.origin === origins.Beta &&
      url.pathname.endsWith('/server_search') &&
      url.searchParams.get('q') === 'policyfixture'
    const releaseLookup = Promise.withResolvers()
    const delayed = async route => {
      await releaseLookup.promise
      await route
        .fulfill({ json: [{ name: 'retired-result', display_name: 'Retired result' }] })
        .catch(() => {})
    }
    await page.evaluate(() => {
      const original = globalThis.fetch
      globalThis.fetch = (input, init) => {
        if (String(input).includes('/server_search?q=policyfixture'))
          globalThis.window.fixtureServerLookup = init?.signal
        return original(input, init)
      }
    })
    await page.route(query, delayed)
    try {
      await Promise.all([
        page.waitForRequest(request => query(new URL(request.url()))),
        serverDialog.getByLabel('Server name or invite link').fill('policyfixture'),
      ])
      await toggle(false)
      await serverDialog.waitFor({ state: 'hidden' })
      await page.waitForFunction(() => globalThis.window.fixtureServerLookup?.aborted === true)
    } finally {
      releaseLookup.resolve()
      await page.unroute(query, delayed)
    }
    await addServer.click()
    await serverDialog.getByLabel('Server name', { exact: true }).waitFor()
    assert.equal(await serverDialog.getByText('Retired result').count(), 0)
    assert.equal(
      await serverDialog
        .getByLabel('As', { exact: true })
        .locator('option')
        .filter({ hasText: host('Beta') })
        .count(),
      0
    )
    await page.keyboard.press('Escape')
    await toggle(true)
    await tile.click()
    await row('Beta', 'alice').click()
    await page.waitForFunction(id => history.state?.acct === id, 'alice@' + host('Beta'))
    step = 'drop a file while Beta is shown'
    await page.evaluate(() => {
      const transfer = new globalThis.DataTransfer()
      transfer.items.add(new globalThis.File(['fixture'], 'lock-test.txt'))
      globalThis.document.body.dispatchEvent(
        new globalThis.DragEvent('drop', {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        })
      )
    })
    const picker = page.getByRole('dialog', { name: 'Share to RChat' })
    const as = picker.getByRole('combobox', { name: 'As', exact: true })
    const betaChoice = JSON.stringify([origins.Beta, 'alice', null])
    await as.selectOption(betaChoice)
    step = 'disable while Beta is shown'
    await toggle(false)
    await page.waitForFunction(value => {
      const select = globalThis.document.querySelector('[role="dialog"] select[aria-label="As"]')
      return select && !Array.from(select.options).some(o => o.value === value)
    }, betaChoice)
    assert.equal(await as.inputValue(), '')
    await as.selectOption(JSON.stringify([origins.Alpha, 'alice', null]))
    assert.equal(await picker.getByRole('button', { name: 'Open draft' }).isDisabled(), true)
    await picker.getByRole('button', { name: 'Cancel' }).click()
    await page.getByText(message, { exact: true }).waitFor()
    step = 'cold Beta route'
    const betaRequests = []
    page.on('request', r => {
      if (new URL(r.url()).origin === origins.Beta) betaRequests.push(r.method())
    })
    // A first visit may have no cached lock; the page must ask Alpha before contacting Beta.
    await page.evaluate(
      origin => localStorage.removeItem('rchat_hosted_lock@' + origin),
      origins.Alpha
    )
    const storageTab = await page.context().newPage()
    const settings = url => url.origin === origins.Alpha && url.pathname === '/api/v1/settings'
    const releaseSettings = Promise.withResolvers()
    const holdSettings = async route => {
      await releaseSettings.promise
      await route.continue().catch(() => {})
    }
    try {
      await storageTab.route('**/fixture-storage-tab', route =>
        route.fulfill({ contentType: 'text/html', body: '<title>Storage fixture</title>' })
      )
      await storageTab.goto(origins.Alpha + '/fixture-storage-tab')
      await page.route(settings, holdSettings)
      await Promise.all([
        page.waitForRequest(request => settings(new URL(request.url()))),
        page.reload({ waitUntil: 'domcontentloaded' }),
      ])
      // A second tab sees the setting after this page created its initial book projection.
      await storageTab.evaluate(
        origin => localStorage.setItem('rchat_hosted_lock@' + origin, '1'),
        origins.Alpha
      )
      releaseSettings.resolve()
      await page.getByText(message, { exact: true }).waitFor()
    } finally {
      releaseSettings.resolve()
      await page.unroute(settings, holdSettings)
      await storageTab.close()
    }
    assert.equal(betaRequests.length, 0)
    await page.getByRole('link', { name: 'Back to home' }).click()
    await tile.click()
    await row('Alpha', 'alice2').waitFor()
    assert.equal(await row('Beta', 'alice').count(), 0)
    assert.equal(
      await menu.getByRole('button', { name: 'Add an instance', exact: true }).count(),
      0
    )
    await menu.getByRole('button', { name: 'Add an account on Alpha', exact: true }).waitFor()
    await menu.getByRole('button', { name: 'Manage accounts', exact: true }).click()
    await page.getByText(message, { exact: true }).waitFor()
    const after = await page.evaluate(() => localStorage.getItem('rchat_book'))
    assert.deepEqual(
      JSON.parse(after).instances.find(i => i.origin === origins.Beta),
      JSON.parse(before).instances.find(i => i.origin === origins.Beta)
    )
    step = 'rail, Home, palette, Friends and login return'
    await page.goto(origins.Alpha + '/')
    const rail = page
      .locator('nav')
      .filter({ has: page.locator('[data-home-button]') })
      .filter({ visible: true })
      .first()
    await rail.getByRole('button', { name: 'Home', exact: true }).click()
    const home = page.locator('[data-home]:visible')
    await home.waitFor()
    assert.equal(await rail.getByRole('button', { name: 'Add an instance' }).count(), 0)
    assert(!((await rail.innerText()) + ' ' + (await home.innerText())).includes('Beta'))
    await page.keyboard.press('Control+k')
    const search = page.getByRole('combobox', { name: 'Search or run a command' })
    await search.fill('>Switch to')
    const results = page.getByRole('listbox')
    await results.waitFor()
    assert(!(await results.innerText()).includes('Beta'))
    await search.fill('>Open friends')
    await search.press('Enter')
    const friends = page.getByRole('tablist', { name: 'Friends' }).locator('..')
    await friends.getByRole('button', { name: 'alice2 on Alpha' }).waitFor()
    assert.equal(await friends.getByRole('button', { name: 'alice on Beta' }).count(), 0)
    await page.goto(origins.Alpha + '/login/?next=' + encodeURIComponent(betaPath))
    await page.getByText(message, { exact: true }).waitFor()
    assert.equal(betaRequests.length, 0)
    await page.getByRole('link', { name: 'Back to home' }).click()
    await tile.click()
    step = 'enable and restore'
    await toggle(true)
    await row('Beta', 'alice').waitFor()
    // The restored manager may already be fetching Beta in this document. Observe the new page's bootstrap.
    await page.goto('about:blank')
    const me = page.waitForResponse(r => r.ok() && r.url() === origins.Beta + '/api/v1/me')
    await page.goto(origins.Alpha + betaPath)
    assert.equal((await (await me).json()).username, 'alice')
    await page.waitForFunction(id => history.state?.acct === id, 'alice@' + host('Beta'))
    await tile.waitFor()
    console.log(
      'PASS operator lock cancels the selected Beta server lookup, reconciles first settings after a cross-tab cache change; locked reload sends zero Beta requests, preserves Beta book entry, removes Beta from the open share picker, rail, Home, palette, Friends and login returns, keeps own logins and same-instance add, then restores authenticated Beta'
    )
  } catch (e) {
    console.error('Hosted lock failed at', step, String(e).slice(0, 450))
    throw e
  }
}
