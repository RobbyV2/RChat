/* global URL, console, history, location, document, setTimeout, window, localStorage, fetch */
// Hosted two-instance acceptance callback. The fixture supplies real users and databases.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function check({ actors, origins, fillCredentials, signIn }) {
  const evidence = await mkdtemp(join(tmpdir(), 'rchat-account-switcher-'))
  const p = actors.get('Alpha/alice').page
  const host = Object.fromEntries(Object.entries(origins).map(([k, v]) => [k, new URL(v).host]))
  const errors = []
  p.on('response', r => {
    if (r.url().includes('/auth/login'))
      console.log('Sign-in response', new URL(r.url()).host, r.status())
  })
  p.on('pageerror', e => errors.push(e.name + ': ' + e.message))
  const dialog = (page = p) =>
    page.getByRole('dialog', { name: /^(Switch account|Manage accounts)$/ })
  const row = (label, user, local = null, page = p) =>
    dialog(page)
      .locator('[data-account-row]')
      .filter({})
      .and(
        page.locator(
          '[data-account-row=' + JSON.stringify(JSON.stringify([origins[label], user, local])) + ']'
        )
      )
  async function open(page = p) {
    await page.locator('[data-switcher-tile]:visible').click()
    await dialog(page).waitFor()
  }
  async function at(label, user, page = p) {
    await page
      .waitForFunction(id => history.state?.acct === id, (user ?? '~guest') + '@' + host[label])
      .catch(async e => {
        console.log(
          'Expected actor',
          label,
          user,
          'actual',
          await page.evaluate(() => [
            history.state?.acct,
            location.pathname,
            document.querySelector('[data-switcher-tile]')?.title,
            [...document.querySelectorAll('[role=alert], [data-add-instance-step]')].map(el =>
              el.textContent?.slice(0, 500)
            ),
          ])
        )
        throw e
      })
  }
  async function add(label, user, foreign = false, page = p) {
    await open(page)
    if (foreign) {
      await dialog(page).getByRole('button', { name: 'Add an instance', exact: true }).click()
      const address = page.getByLabel('Instance address', { exact: true })
      await address.fill(origins[label])
      await address.press('Enter')
      await page.getByRole('button', { name: 'I trust this app' }).click()
    } else
      await dialog(page)
        .getByRole('button', { name: 'Add an account on ' + label, exact: true })
        .click()
    await fillCredentials(page, label, user)
    const submit = page.locator('[data-add-instance-step] form button[type=submit]')
    const send = () =>
      Promise.all([
        page.waitForResponse(r => r.url() === origins[label] + '/api/v1/auth/login'),
        submit.click(),
      ]).then(([res]) => res)
    const response = await send()
    if (response.status() === 429) {
      // Reusing Carol in two separate profiles can hit the server's per-user login interval.
      await new Promise(resolve => setTimeout(resolve, 3100))
      assert.equal((await send()).status(), 200)
    } else assert.equal(response.status(), 200)
    await at(label, user, page)
  }
  async function manage() {
    await open()
    await dialog().getByRole('button', { name: 'Manage accounts', exact: true }).click()
  }
  async function actions(label, user, local = null) {
    const r = row(label, user, local)
    const parent = r.locator('..')
    await parent.getByTitle('Account actions', { exact: true }).click()
    return parent.locator('..')
  }
  const shot = (page, file) => page.screenshot({ path: join(evidence, file + '.png') })
  let stage = 'two accounts on one instance'
  try {
    await p.evaluate(() => (window.switcherPage = 'kept'))
    await add('Alpha', 'alice2')
    await open()
    assert.equal(await dialog().locator('section').count(), 1)
    assert.equal(await dialog().locator('[data-account-row]').count(), 2)
    await shot(p, 'one-instance-two-accounts')
    await p.keyboard.press('1')
    await at('Alpha', 'alice')
    await p.keyboard.press('Control+Shift+l')
    await p.keyboard.press('ArrowDown')
    await p.keyboard.press('Enter')
    await at('Alpha', 'alice2')
    console.log('PASS actor tile, single group, keyboard shortcut, arrows, Enter and digits')

    stage = 'two single-account instances'
    const bob = (await signIn('Alpha', 'bob')).page
    await add('Beta', 'carol', true, bob)
    await open(bob)
    assert.equal(await dialog(bob).locator('section').count(), 2)
    assert.equal(await dialog(bob).locator('[data-account-row]').count(), 2)
    await shot(bob, 'two-instances')
    await bob.keyboard.press('Escape')

    stage = 'two by two accounts'
    await add('Beta', 'alice', true)
    await add('Beta', 'carol')
    await p.keyboard.press('Control+k')
    const search = p.getByRole('combobox', { name: 'Search or run a command' })
    await search.fill('>Switch to alice2 on Alpha')
    await p
      .getByRole('option', { name: /Switch to alice2 on Alpha/ })
      .first()
      .click()
    await at('Alpha', 'alice2')

    stage = 'identity creation'
    await manage()
    async function createPeer(name) {
      await (
        await actions('Alpha', 'alice2')
      )
        .getByRole('button', { name: 'Add a P2P identity' })
        .click()
      await dialog().getByRole('button', { name: 'I trust this app' }).click()
      await dialog().getByLabel('Identity name').fill(name)
      await dialog().getByRole('button', { name: 'Continue', exact: true }).click()
      await dialog().getByRole('button', { name: 'Create without a recovery phrase' }).click()
      await p.locator('[data-switcher-tile]:visible').filter({ hasText: name }).waitFor()
      await manage()
      return dialog().locator('[data-account-row]').filter({ hasText: name })
    }
    await (await createPeer('work')).waitFor()
    const games = await createPeer('games')
    await games.waitFor()
    const gamesLocal = JSON.parse(await games.getAttribute('data-account-row'))[2]
    // A25 opens each newly created identity. Leave games before disabling its background work.
    await dialog().locator('[data-account-row]').filter({ hasText: 'work' }).click()
    await p.locator('[data-switcher-tile]:visible').filter({ hasText: 'work' }).waitFor()
    await manage()
    const peerActions = await actions('Alpha', 'alice2', gamesLocal)
    const peerToggle = peerActions.getByRole('switch', { name: 'Run in the background' })
    await peerToggle.click()
    assert.equal(await peerToggle.getAttribute('aria-checked'), 'false')
    await dialog()
      .getByRole('button', { name: 'Drag games', exact: true })
      .dragTo(dialog().getByRole('button', { name: 'Drag work', exact: true }))
    await p.waitForFunction(
      origin =>
        JSON.parse(localStorage.rchat_book)
          .instances.find(i => i.origin === origin)
          .accounts.find(a => a.username === 'alice2').identities[0].name === 'games',
      origins.Alpha
    )
    const work = dialog().locator('[data-account-row]').filter({ hasText: 'work' })
    await work.waitFor()
    // Seed one outstanding request in the parked identity's database. The normal
    // P2P resume and Ignore action below load and resolve the stored request.
    const incoming = 'A'.repeat(43)
    await p.evaluate(
      async ({ local, ik }) => {
        const dbs = await window.indexedDB.databases()
        const name = dbs.find(
          db => db.name.startsWith('rchat-p2p:') && db.name.endsWith(':alice2~' + local)
        ).name
        await new Promise((resolve, reject) => {
          const open = window.indexedDB.open(name)
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction('contacts', 'readwrite')
            tx.objectStore('contacts').put({
              ik,
              name: 'Fixture sender',
              state: 'incoming',
              ignored: false,
              intros: [],
              certs: [],
              revocations: [],
              verified: false,
              added: 1,
              host: location.host,
            })
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onabort = () => {
              db.close()
              reject(tx.error)
            }
          }
        })
      },
      { local: gamesLocal, ik: incoming }
    )
    const badge = games.getByText('1', { exact: true })
    const tile = p.locator('[data-switcher-tile]:visible')
    await games.filter({ hasText: 'Paused' }).click()
    await tile.filter({ hasText: 'games' }).waitFor()
    const request = p.locator('[data-request="' + incoming + '"]:visible')
    await request.waitFor()
    await open()
    assert.equal(await games.getAttribute('aria-current'), 'true')
    await badge.waitFor()
    await work.click()
    await tile.filter({ hasText: 'work' }).waitFor()
    await tile.getByText('1', { exact: true }).waitFor()
    await open()
    await games.filter({ hasText: 'Paused' }).getByText('1', { exact: true }).waitFor()
    await p.keyboard.press('Escape')
    await p.keyboard.press('Control+k')
    await search.fill('>Switch to games on Alpha')
    await p
      .getByRole('option', { name: /Switch to games on Alpha/ })
      .first()
      .click()
    await request.getByRole('button', { name: 'Ignore' }).click()
    await request.waitFor({ state: 'detached' })
    await open()
    assert.equal(await games.getAttribute('aria-current'), 'true')
    assert.equal(await badge.count(), 0)
    await work.click()
    await tile.filter({ hasText: 'work' }).waitFor()
    assert.equal(await tile.getByText('1', { exact: true }).count(), 0)
    await open()
    await shot(p, 'two-by-two-identities')
    await dialog().getByRole('button', { name: 'Manage accounts', exact: true }).click()
    const gameMenu = await actions('Alpha', 'alice2', gamesLocal)
    await gameMenu.getByRole('button', { name: 'Remove identity' }).click()
    const warning = p.getByRole('dialog', { name: 'Remove P2P data from this browser?' })
    await warning.getByText(/Without a backup/).waitFor()
    await warning.getByRole('button', { name: 'Remove', exact: true }).click()
    await games.waitFor({ state: 'detached' })
    await work.waitFor()
    await p.keyboard.press('Escape')
    console.log(
      'PASS two-instance layouts, direct palette switch and P2P identity creation/selection'
    )

    stage = 'ordering and connection preference'
    await manage()
    await p.evaluate(() => {
      const book = JSON.parse(localStorage.rchat_book)
      book.instances.unshift({
        origin: 'https://discovery.test',
        id: 'public',
        name: 'Public',
        accounts: [],
        guest: false,
      })
      localStorage.rchat_book = JSON.stringify(book)
      window.dispatchEvent(new window.StorageEvent('storage', { key: 'rchat_book' }))
    })
    await dialog().getByRole('button', { name: 'Move Alpha down', exact: true }).click()
    await p.waitForFunction(
      origin =>
        JSON.parse(localStorage.rchat_book).instances.filter(i => i.guest || i.accounts.length)[0]
          .origin === origin,
      origins.Beta
    )
    await dialog().getByRole('button', { name: 'Move Alpha up', exact: true }).click()
    await p.waitForFunction(
      origin =>
        JSON.parse(localStorage.rchat_book).instances.filter(i => i.guest || i.accounts.length)[0]
          .origin === origin,
      origins.Alpha
    )
    const a2 = await actions('Alpha', 'alice2')
    const toggle = a2.getByRole('switch', { name: 'Keep connected' })
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await toggle.click()
    await dialog()
      .getByRole('button', { name: 'Drag Beta', exact: true })
      .dragTo(dialog().getByRole('button', { name: 'Drag Alpha', exact: true }))
    await p.waitForFunction(
      origin =>
        JSON.parse(localStorage.rchat_book).instances.filter(i => i.guest || i.accounts.length)[0]
          .origin === origin,
      origins.Beta
    )
    const group = dialog().getByRole('region', { name: 'Alpha', exact: true })
    const source = group.getByRole('button', { name: 'Drag alice2', exact: true })
    const target = group.getByRole('button', { name: 'Drag alice', exact: true })
    await source.dragTo(target)
    await p.waitForFunction(
      origin =>
        JSON.parse(localStorage.rchat_book).instances.find(i => i.origin === origin).accounts[0]
          .username === 'alice2',
      origins.Alpha
    )
    assert.equal(
      JSON.parse(
        await group.locator('[data-account-row]').first().getAttribute('data-account-row')
      )[1],
      'alice2'
    )
    await p.keyboard.press('Escape')

    stage = 'scoped settings'
    await p.getByTitle('Settings', { exact: true }).filter({ visible: true }).first().click()
    await p.locator('[data-settings-section=profile]:visible').click()
    await p.getByRole('combobox', { name: 'Settings for' }).selectOption({ label: 'alice · Beta' })
    await at('Beta', 'alice')
    await p
      .getByRole('dialog', { name: 'Settings' })
      .getByText('Accounts on this device', { exact: true })
      .waitFor()
    await p.keyboard.press('Escape')
    assert.equal(await p.evaluate(() => window.switcherPage), 'kept')
    console.log(
      'PASS persisted drag order, keep connected, scoped Settings and document continuity'
    )

    stage = 'mobile sheet'
    await p.setViewportSize({ width: 390, height: 844 })
    const menu = p
      .getByRole('button', {
        name: /Open navigation|Open menu|Open sidebar|Show navigation|^Menu$/i,
      })
      .first()
    if (!(await p.locator('[data-switcher-tile]:visible').count())) await menu.click()
    await open()
    const box = await dialog().boundingBox()
    assert(box && box.width === 390 && Math.abs(box.y + box.height - 844) < 2)
    for (const rr of await dialog().locator('[data-account-row]').all())
      assert((await rr.boundingBox()).height >= 48)
    await shot(p, 'mobile-sheet')
    const touch = await p.context().newCDPSession(p)
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true })
    const held = row('Alpha', 'alice2')
    await held.scrollIntoViewIfNeeded()
    const rect = await held.boundingBox()
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: rect.x + 30, y: rect.y + 20 }],
    })
    await dialog().getByRole('switch', { name: 'Keep connected' }).waitFor()
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await touch.detach()
    await at('Beta', 'alice')
    await p.keyboard.press('Escape')
    await p.setViewportSize({ width: 1280, height: 800 })

    stage = 'selective logout and reauthentication'
    const names = ['alice', 'alice2']
    const checkToken = async user =>
      p.evaluate(
        async ({ user, origin }) => {
          const token = window.fixtureCredentials[user]
          return (
            await fetch(origin + '/api/v1/me', { headers: { Authorization: 'Bearer ' + token } })
          ).status
        },
        { user, origin: origins.Alpha }
      )
    await p.evaluate(names => {
      window.fixtureCredentials = Object.fromEntries(
        names.map(u => [u, localStorage.getItem('rchat_token:' + u)])
      )
    }, names)
    assert.equal(await checkToken('alice2'), 200)
    await manage()
    await (
      await actions('Alpha', 'alice2')
    )
      .getByRole('button', { name: 'Sign out', exact: true })
      .click()
    await p
      .getByRole('dialog', { name: 'Sign out of this account?' })
      .getByRole('button', { name: 'Sign out', exact: true })
      .click()
    await row('Alpha', 'alice2').filter({ hasText: 'Signed out' }).waitFor()
    await p.waitForFunction(
      async origin =>
        (
          await fetch(origin + '/api/v1/me', {
            headers: { Authorization: 'Bearer ' + window.fixtureCredentials.alice2 },
          })
        ).status === 401,
      origins.Alpha
    )
    assert.equal(await checkToken('alice'), 200)
    await at('Beta', 'alice')
    await row('Alpha', 'alice2').click()
    const username = p.getByLabel('Username', { exact: true })
    assert.equal(await username.inputValue(), 'alice2')
    assert.equal(await username.isEditable(), false)
    await fillCredentials(p, 'Alpha', 'alice2')
    await p.locator('[data-add-instance-step] form button[type=submit]').click()
    await at('Alpha', 'alice2')
    console.log(
      'PASS 390px mobile sheet, signed-out row, pinned sign-in and isolated bearer revocation'
    )
    assert.equal(await p.locator('nextjs-portal [data-nextjs-dialog-overlay]').count(), 0)
    assert.deepEqual(errors, [])
    console.log('PASS screenshots', evidence)
  } catch (e) {
    console.error('Switcher stage', stage, e.name, String(e.message).split('\n')[0].slice(0, 160))
    throw Error(stage, { cause: e })
  }
}
