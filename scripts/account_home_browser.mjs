// Callback for the local two-instance fixture used by the account switcher.
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
export async function check({ actors, origins, dms, signIn, fillCredentials }) {
  const p = actors.get('Alpha/alice').page
  const host = label => new globalThis.URL(origins[label]).host
  const rail = () =>
    p
      .locator('nav')
      .filter({ has: p.locator('[data-home-button]') })
      .filter({ visible: true })
      .first()
  const actor = label => JSON.stringify([origins[label], 'alice', null])
  const api = (page, origin, user, path, body) =>
    page.evaluate(
      async ({ origin, user, path, body }) => {
        const host = new globalThis.URL(origin).host
        const token = globalThis.localStorage.getItem(
          'rchat_token:' + user + (origin === globalThis.location.origin ? '' : '@' + host)
        )
        if (!token) throw Error('Fixture account credential missing')
        const r = await globalThis.fetch(origin + '/api/v1' + path, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        if (!r.ok) throw Error('Fixture API returned ' + r.status)
        return r.json()
      },
      { origin, user, path, body }
    )
  const senderA = await signIn('Alpha', 'bob'),
    senderB = await signIn('Beta', 'carol')
  let stage = 'Home'
  try {
    const home = p.locator('[data-home]').filter({ visible: true })
    const openHome = () => rail().getByRole('button', { name: 'Home', exact: true }).click()
    const message = async recipient => {
      await home.getByRole('button', { name: 'Message someone' }).click()
      await home.getByLabel('Username', { exact: true }).fill(recipient)
      await home.getByRole('button', { name: 'Message', exact: true }).click()
    }
    await openHome()
    const created = p.waitForResponse(
      r => r.url() === origins.Alpha + '/api/v1/dms' && r.request().method() === 'POST'
    )
    await message('bob@' + host('Alpha'))
    const response = await created
    assert.ok(response.ok())
    assert.equal(response.request().postDataJSON().username, 'bob')
    await p.getByText(dms.Alpha[0].marker, { exact: true }).first().waitFor()
    await openHome()
    const wrongSends = []
    const recordDm = req => {
      if (req.method() === 'POST' && new globalThis.URL(req.url()).pathname === '/api/v1/dms')
        wrongSends.push(req.url())
    }
    p.on('request', recordDm)
    await message('carol@' + host('Beta'))
    await home.getByRole('button', { name: 'Add ' + host('Beta'), exact: true }).click()
    await p.getByRole('button', { name: 'I trust this app' }).waitFor()
    p.off('request', recordDm)
    assert.deepEqual(wrongSends, [])
    globalThis.console.log('PASS single-account qualified local DM and foreign instance trust flow')
    stage = 'cancel foreign-host prompt and add Beta'
    await p.getByRole('button', { name: 'Cancel', exact: true }).click()
    await home.getByRole('button', { name: 'Message someone' }).click()
    await rail().getByRole('button', { name: 'Add an instance', exact: true }).click()
    await p.getByLabel('Instance address').fill(origins.Beta)
    await p.getByLabel('Instance address').press('Enter')
    await p.getByRole('button', { name: 'I trust this app' }).click()
    await fillCredentials(p, 'Beta', 'alice')
    await p.locator('form button[type=submit]').click()
    await p.waitForFunction(id => globalThis.history.state?.acct === id, 'alice@' + host('Beta'))
    await rail().getByRole('button', { name: 'Home', exact: true }).click()
    const betaDm = dms.Beta[0]
    stage = 'pin Beta DM from its sidebar'
    await p.goto(origins.Alpha + '/@alice@' + host('Beta') + '/dm/' + betaDm.id + '/')
    await p.getByText(betaDm.marker, { exact: true }).first().waitFor()
    const betaSidebar = p.locator('[data-dm-origin="' + origins.Beta + '"]:visible')
    await betaSidebar.locator('[data-dm="' + betaDm.id + '"]').click({ button: 'right' })
    await p.getByRole('menuitem', { name: 'Pin DM', exact: true }).click()
    await openHome()
    stage = 'mark Beta unread from Alpha'
    const strip = home.getByLabel('Accounts', { exact: true })
    await strip.getByRole('button').filter({ hasText: 'Alpha' }).first().click()
    await rail().getByRole('button', { name: 'Home', exact: true }).click()
    await home.getByText(/notifications across 2 accounts/).waitFor()
    for (const [label, sender, username] of [
      ['Alpha', senderA, 'bob'],
      ['Beta', senderB, 'carol'],
    ]) {
      const dm = dms[label].find(d => d.user === 'alice' || d.peer === 'alice')
      await api(sender.page, origins[label], username, '/dms/' + dm.id + '/messages', {
        content: '@alice new unread on ' + label,
      })
    }
    const group = label =>
      home.locator('[data-home-unread-owner=' + JSON.stringify(actor(label)) + ']')
    const read = label =>
      api(p, origins[label], 'alice', '/unreads').then(r =>
        r.items.find(x => x.scope === 'd' + dms[label][0].id)
      )
    await group('Alpha').getByRole('button', { name: 'Mark direct messages as read' }).waitFor()
    const mark = group('Beta').getByRole('button', { name: 'Mark direct messages as read' })
    await mark.waitFor()
    const a = await read('Alpha'),
      b = await read('Beta')
    assert.ok(a.latest > a.last_read && b.latest > b.last_read)
    const reply = p.waitForResponse(
      r => r.url() === origins.Beta + '/api/v1/read/batch' && r.request().method() === 'POST'
    )
    await mark.click()
    assert.ok((await reply).ok())
    await mark.waitFor({ state: 'hidden' })
    assert.equal(await p.evaluate(() => globalThis.history.state.acct), 'alice@' + host('Alpha'))
    const afterB = await read('Beta'),
      afterA = await read('Alpha')
    assert.ok(!afterB || afterB.last_read >= b.latest)
    assert.equal(afterA.last_read, a.last_read)
    globalThis.console.log(
      'PASS Home marks background Beta DM read through Beta POST; Alpha remains shown and its unread is unchanged'
    )
    for (const title of ['Jump back in', 'Inbox', 'Pinned DMs']) {
      const card = home.getByRole('region', { name: title, exact: true })
      await card.getByRole('button').filter({ hasText: 'Beta' }).first().click()
      assert.equal(await p.evaluate(() => globalThis.history.state.acct), 'alice@' + host('Alpha'))
    }
    const pinned = home.getByRole('region', { name: 'Pinned DMs' })
    await pinned.locator('[data-pinned-dm="' + betaDm.id + '"]').click({ button: 'right' })
    assert.equal(await p.evaluate(() => globalThis.history.state.acct), 'alice@' + host('Alpha'))
    await p.getByRole('menuitem', { name: 'Open', exact: true }).click()
    await p.getByText(betaDm.marker, { exact: true }).first().waitFor()
    assert.equal(await p.evaluate(() => globalThis.history.state.acct), 'alice@' + host('Beta'))
    await openHome()
    await strip.getByRole('button').filter({ hasText: 'Alpha' }).first().click()
    await openHome()
    globalThis.console.log('PASS background pinned DM menu opens Beta’s conversation')
    await home.getByRole('combobox', { name: 'As', exact: true }).selectOption(actor('Beta'))
    await home.getByRole('button', { name: 'Join server', exact: true }).click()
    await p.getByRole('dialog', { name: 'Add a server' }).waitFor()
    assert.equal(await p.evaluate(() => globalThis.history.state.acct), 'alice@' + host('Beta'))
    await p.keyboard.press('Escape')
    await p.setViewportSize({ width: 390, height: 844 })
    await home.getByRole('combobox', { name: 'As', exact: true }).waitFor()
    assert.ok(await home.evaluate(el => el.scrollWidth <= el.clientWidth))
    globalThis.console.log(
      'PASS owner-specific history/inbox/pinned chips, As action routing, and mobile width'
    )
    await p.setViewportSize({ width: 1280, height: 800 })
    for (const name of ['main-home', 'work-home', 'third-home']) {
      stage = 'open switcher for ' + name
      await rail().locator('[data-switcher-tile]').click()
      const manage = p.getByRole('dialog', { name: /^(Switch account|Manage accounts)$/ })
      await manage.getByRole('button', { name: 'Manage accounts', exact: true }).click()
      const account = manage.locator('[data-account-row=' + JSON.stringify(actor('Beta')) + ']')
      await account.locator('..').getByTitle('Account actions').click()
      stage = 'create ' + name
      await manage.getByRole('button', { name: 'Add a P2P identity' }).click()
      const trust = manage.getByRole('button', { name: 'I trust this app' })
      if (await trust.count()) await trust.click()
      await manage.getByLabel('Identity name').fill(name)
      await manage.getByRole('button', { name: 'Continue', exact: true }).click()
      await manage.getByRole('button', { name: 'Create without a recovery phrase' }).click()
      await manage.waitFor({ state: 'hidden' })
      await openHome()
      await home
        .getByRole('combobox', { name: 'As' })
        .getByRole('option')
        .filter({ hasText: name })
        .waitFor({ state: 'attached' })
    }
    stage = 'expand work identity'
    const work = home
      .locator('details')
      .filter({ has: p.locator('summary').filter({ hasText: 'work-home' }) })
    await work.locator('summary').click()
    stage = 'show identity code'
    await work.getByRole('button', { name: 'Show my code' }).click()
    const card = await p.locator('textarea[data-p2p-card]:visible').inputValue()
    const payload = JSON.parse(
      inflateRawSync(Buffer.from(card.slice('rcp1.'.length), 'base64url')).toString()
    )
    assert.equal(payload.name, 'work-home')
    globalThis.console.log(
      'PASS three real P2P identities collapse separately; opening work’s code uses its own card'
    )

    stage = 'register from a background Beta guest'
    const guestPage = senderA.page
    const guestHome = guestPage.locator('[data-home]:visible')
    const guestRail = guestPage
      .locator('nav:visible')
      .filter({ has: guestPage.locator('[data-home-button]') })
      .first()
    await guestRail.getByRole('button', { name: 'Add an instance', exact: true }).click()
    await guestPage.getByLabel('Instance address').fill(origins.Beta)
    await guestPage.getByLabel('Instance address').press('Enter')
    await guestPage.getByRole('button', { name: 'I trust this app' }).click()
    await guestPage.getByRole('button', { name: 'Browse as a guest' }).click()
    await guestPage.waitForFunction(
      id => globalThis.history.state?.acct === id,
      '~guest@' + host('Beta')
    )
    await guestRail.getByRole('button', { name: 'Home', exact: true }).click()
    await guestHome
      .getByLabel('Accounts', { exact: true })
      .getByRole('button')
      .filter({ hasText: 'Alpha' })
      .first()
      .click()
    await guestRail.getByRole('button', { name: 'Home', exact: true }).click()
    await guestHome
      .getByRole('combobox', { name: 'As' })
      .selectOption(JSON.stringify([origins.Beta, null, null]))
    assert.equal(
      await guestPage.evaluate(() => globalThis.history.state.acct),
      'bob@' + host('Alpha')
    )
    await guestHome.getByRole('button', { name: 'Sign up', exact: true }).click()
    await guestPage.getByLabel('Username', { exact: true }).fill('homeguest')
    await guestPage.getByLabel('Password', { exact: true }).fill(randomUUID())
    const registration = guestPage.waitForResponse(
      r => r.request().method() === 'POST' && r.url() === origins.Beta + '/api/v1/auth/register'
    )
    await guestPage.locator('form button[type=submit]').click()
    assert.ok((await registration).ok())
    assert.equal((await api(guestPage, origins.Alpha, 'bob', '/me')).username, 'bob')
    globalThis.console.log(
      'PASS Beta guest registration posts to Beta and Alpha’s session still authenticates'
    )
  } catch (e) {
    globalThis.console.error('Home check ' + stage + ': ' + String(e.message).slice(0, 900))
    throw e
  } finally {
    await senderA.context.close()
    await senderB.context.close()
  }
}
