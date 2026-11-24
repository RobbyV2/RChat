// Two-instance fixture callback; accepts only the test users created by the launcher.
import { URL } from 'node:url'
import { log } from 'node:console'
import assert from 'node:assert/strict'

async function checkDms({ actors, origins, dms, fillCredentials, signIn }) {
  const page = actors.get('Alpha/alice').page
  const dialog = page.getByRole('dialog', { name: 'Switch account' })
  const at = (label, user) =>
    page.waitForFunction(
      id => globalThis.history.state?.acct === id,
      user + '@' + new URL(origins[label]).host
    )
  async function add(label, user) {
    await page.locator('[data-switcher-tile]:visible').click()
    if (label === 'Beta') {
      await dialog.getByRole('button', { name: 'Add an instance', exact: true }).click()
      await page.getByLabel('Instance address').fill(origins.Beta)
      await page.getByLabel('Instance address').press('Enter')
      await page.getByRole('button', { name: 'I trust this app' }).click()
    } else
      await dialog.getByRole('button', { name: 'Add an account on Alpha', exact: true }).click()
    await fillCredentials(page, label, user)
    await page.locator('[data-add-instance-step] form button[type=submit]').click()
    await at(label, user)
  }
  log('Checking three hosted account entries')
  await add('Alpha', 'alice2')
  await add('Beta', 'alice')
  const beta = dms.Beta[0]
  await page.goto(origins.Alpha + '/@alice@' + new URL(origins.Beta).host + '/dm/' + beta.id + '/')
  await page.getByText(beta.marker, { exact: true }).first().waitFor()
  const block = (label, user) =>
    page.locator(
      '[data-dm-account="' + user + '"][data-dm-origin="' + origins[label] + '"]:visible'
    )
  const target = (label, user, peer) =>
    block(label, user).locator('[data-dm]').filter({ hasText: peer })
  const alpha = dms.Alpha.find(d => d.user === 'alice')
  const second = dms.Alpha.find(d => d.user === 'alice2')
  await target('Alpha', 'alice', 'bob').waitFor()
  await target('Alpha', 'alice2', 'bob').waitFor()
  assert.equal(await page.getByRole('button', { name: /^Friends(?:\s*\d+)?$/ }).count(), 1)
  log('Checking duplicate-name DMs and separate unread')
  await target('Alpha', 'alice', 'bob').click()
  await page.getByText(alpha.marker, { exact: true }).first().waitFor()
  const bob = (await signIn('Alpha', 'bob')).page
  await bob.goto(origins.Alpha + '/dm/' + second.id + '/')
  const marker = 'A27 independent unread for alice2'
  await bob.locator('textarea:visible').last().fill(marker)
  await bob.getByRole('button', { name: 'Send', exact: true }).click()
  await target('Alpha', 'alice2', 'bob')
    .locator('[title="Unread"], [aria-label*="ping" i], [data-ping-badge]')
    .first()
    .waitFor()
  assert.equal(await target('Alpha', 'alice', 'bob').locator('[title="Unread"]').count(), 0)
  await target('Alpha', 'alice2', 'bob').click()
  await page.getByText(marker, { exact: true }).first().waitFor()
  log('Checking cross-account Back navigation')
  const before = await page.evaluate(() => globalThis.history.length)
  await target('Beta', 'alice', 'carol').click()
  await at('Beta', 'alice')
  await page.getByText(beta.marker, { exact: true }).first().waitFor()
  assert.equal(await page.evaluate(() => globalThis.history.length), before + 1)
  await page.goBack()
  await at('Alpha', 'alice2')
  log('Checking qualified recipient')
  const from = block('Alpha', 'alice2')
  await from.getByRole('button', { name: 'New direct message' }).click()
  const pending = page.waitForResponse(
    r =>
      r.request().method() === 'POST' &&
      r.url().startsWith(origins.Beta + '/api/') &&
      /\/dms?\/?$/.test(new URL(r.url()).pathname)
  )
  await from
    .getByPlaceholder('username or username@host')
    .fill('carol@' + new URL(origins.Beta).host)
  await from.getByRole('button', { name: 'Start message' }).click()
  assert.ok((await pending).ok())
  await at('Beta', 'alice')
  await page.getByText(beta.marker, { exact: true }).first().waitFor()
  log('Checking drag highlights across owners')
  const ownBlock = block('Alpha', 'alice')
  const pinned = ownBlock.locator('[data-drop-zone="pinned"]')
  const row = target('Alpha', 'alice', 'bob')
  await row.scrollIntoViewIfNeeded()
  const source = await row.boundingBox()
  const point = await pinned.boundingBox()
  assert.ok(source && point)
  await page.mouse.move(source.x + 12, source.y + source.height / 2)
  await page.mouse.down()
  try {
    await page.mouse.move(point.x + 12, point.y + point.height / 2, { steps: 12 })
    await ownBlock.locator('[data-drop-zone="pinned"][class*="bg-primary-container"]').waitFor()
    assert.equal(
      await page
        .locator(
          '[data-dm-account]:visible [data-drop-zone="pinned"][class*="bg-primary-container"]'
        )
        .count(),
      1
    )
  } finally {
    await page.mouse.up()
  }
  await pinned.locator('[data-dm]').filter({ hasText: 'bob' }).waitFor()

  const tile = page.locator('[data-switcher-tile]:visible')
  const actorRow = (label, user, local) =>
    page.locator(
      '[data-account-row=' + JSON.stringify(JSON.stringify([origins[label], user, local])) + ']'
    )
  const manage = async () => {
    await tile.click()
    await page.getByRole('button', { name: 'Manage accounts', exact: true }).click()
  }
  async function enroll(name) {
    await manage()
    await actorRow('Beta', 'alice', null).locator('..').getByTitle('Account actions').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Add a P2P identity' }).click()
    await page.getByRole('button', { name: 'I trust this app' }).click()
    await page.getByLabel('Identity name').fill(name)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Create without a recovery phrase' }).click()
    await page
      .getByRole('button', { name: 'Acting as ' + name + ' on Beta', exact: false })
      .first()
      .waitFor()
  }
  await enroll('Personal')
  await enroll('Work')
  await tile.click()
  await actorRow('Alpha', 'alice2', null).click()
  await page.getByText(marker, { exact: true }).first().waitFor()
  const previous = await page.evaluate(() => globalThis.history.length)
  await target('Beta', 'alice', 'carol').click()
  await page.getByText(beta.marker, { exact: true }).first().waitFor()
  assert.equal(await page.evaluate(() => globalThis.history.length), previous + 1)
  await page.goBack()
  await page.getByText(marker, { exact: true }).first().waitFor()
  log('PASS selecting the underlying Beta DM dismisses its P2P home and Back restores Alpha')
  await manage()
  const workRow = page.locator('[data-account-row]').filter({ hasText: 'Work' })
  await workRow.locator('..').getByTitle('Account actions').click()
  await page.getByRole('switch', { name: 'Run in the background' }).click()
  await actorRow('Beta', 'alice', 'main').click()
  await tile.click()
  await actorRow('Alpha', 'alice2', null).click()
  const workSection = block('Beta', 'alice')
    .getByRole('region', { name: 'P2P direct messages' })
    .filter({ hasText: 'Work' })
  await workSection.getByRole('button', { name: /Work/ }).waitFor()
  assert.equal(await workSection.getByRole('button', { name: 'Add contact' }).count(), 0)
  await workSection.getByRole('button', { name: /Work/ }).click()
  await at('Beta', 'alice')
  await page
    .getByRole('button', { name: /Acting as Work on Beta/ })
    .first()
    .waitFor()
  await page.locator('[data-p2p-status]:visible').first().waitFor()
  log('PASS parked sibling DM section resumes Work on Beta')

  await tile.click()
  await actorRow('Beta', 'alice', null).click()
  await manage()
  await actorRow('Alpha', 'alice', null).locator('..').getByTitle('Account actions').click()
  await page.getByRole('switch', { name: 'Keep connected' }).click()
  await actorRow('Alpha', 'alice', null).getByText('Paused').waitFor()
  await page.keyboard.press('Escape')
  const status = await bob.evaluate(async () => {
    const result = await globalThis.fetch('/api/v1/friends/requests', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + globalThis.localStorage.getItem('rchat_token:bob'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ username: 'alice' }),
    })
    return result.status
  })
  assert.ok(status >= 200 && status < 300)
  const poll = page.waitForResponse(
    r => r.url().startsWith(origins.Alpha + '/api/') && r.url().endsWith('/friends/summary')
  )
  await page.clock.setFixedTime(new Date(Date.now() + 6 * 60_000))
  await page.evaluate(() =>
    globalThis.dispatchEvent(new globalThis.StorageEvent('storage', { key: 'rchat_live_budget' }))
  )
  assert.ok((await poll).ok())
  await page
    .getByRole('button', { name: /^Friends/ })
    .locator('[data-ping-badge="1"]')
    .waitFor()
  const incoming = await page.evaluate(
    origins =>
      Object.values(origins).map(
        origin =>
          JSON.parse(
            globalThis.localStorage.getItem('rchat_counts:' + JSON.stringify([origin, 'alice']))
          )?.incoming
      ),
    origins
  )
  assert.deepEqual(incoming, [1, 0])
  log('PASS parked Alpha friend request appears in the grouped badge with Beta counts unchanged')
  log(
    'PASS separate Alpha Bob DMs/unreads, Beta owner and native Back, qualified Beta recipient via hosted browser'
  )
}

export async function check(rig) {
  try {
    await checkDms(rig)
  } catch (error) {
    log('DM acceptance failed', error.name, error.message.split('\n')[0])
    throw error
  }
}
