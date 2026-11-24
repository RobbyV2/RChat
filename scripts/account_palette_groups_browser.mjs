/* global URL, history, console */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Hosted two-instance fixture with --seed-servers. Both instances have the same server and channel.
export async function check({ actors, origins, fillCredentials, stages }) {
  const p = actors.get('Alpha/alice').page
  const search = p.getByRole('combobox', { name: 'Search or run a command' })
  const errors = []
  p.on('pageerror', e => errors.push(e.message))
  const host = label => new URL(origins[label]).host
  const at = label => p.waitForFunction(id => history.state?.acct === id, 'alice@' + host(label))
  async function query(text) {
    await p.keyboard.press('Control+k')
    await search.fill(text)
  }
  async function warm(label) {
    await query('#activity-fixture')
    const set = p.getByRole('group', { name: new RegExp('alice · ' + label) })
    const row = p.locator('[data-palette-item="server_activity-fixture"]')
    if (await set.count())
      await set.locator('[data-palette-item="server_activity-fixture"]').first().click()
    else await row.first().click()
    await p
      .getByText(/Fixture timeline/)
      .filter({ visible: true })
      .first()
      .waitFor()
  }
  let stage = 'warm Alpha'
  try {
    await warm('Alpha')
    await p.locator('[data-switcher-tile]:visible').click()
    await p
      .getByRole('dialog', { name: 'Switch account' })
      .getByRole('button', { name: 'Add an instance', exact: true })
      .click()
    const address = p.getByLabel('Instance address', { exact: true })
    await address.fill(origins.Beta)
    await address.press('Enter')
    await p.getByRole('button', { name: 'I trust this app' }).click()
    await fillCredentials(p, 'Beta', 'alice')
    await p.locator('[data-add-instance-step] form button[type=submit]').click()
    await at('Beta')
    stage = 'warm Beta'
    await warm('Beta')
    stage = 'same named channels'
    await query('#general')
    const alpha = p.getByRole('group', { name: /alice · Alpha/ })
    const beta = p.getByRole('group', { name: /alice · Beta/ })
    const betaId = stages.Beta.channel,
      alphaId = stages.Alpha.channel
    await beta.locator('[data-palette-item="channel_' + betaId + '"]').waitFor()
    await alpha.locator('[data-palette-item="channel_' + alphaId + '"]').waitFor()
    const evidence = await mkdtemp(join(tmpdir(), 'rchat-palette-accounts-'))
    await p
      .getByRole('listbox', { name: 'Results' })
      .screenshot({ path: join(evidence, 'grouped.png') })
    console.log('PASS grouped list screenshot', evidence)
    assert.match(
      await p
        .getByRole('listbox', { name: 'Results' })
        .getByRole('group')
        .first()
        .getAttribute('aria-label'),
      /Beta/
    )
    await alpha.locator('[data-palette-item="channel_' + alphaId + '"]').click()
    await at('Alpha')
    assert.match(new URL(p.url()).pathname, new RegExp('/s/activity-fixture/' + alphaId + '/$'))
    console.log(
      'PASS same-name channels survive under both account headings, actor first; Alpha selection switches account and route'
    )
    stage = 'actor commands'
    await query('>Open friends')
    const command = p.locator('[data-palette-item=friends]')
    assert.equal(await command.count(), 1)
    await command.click()
    await p.getByRole('tablist', { name: 'Friends' }).waitFor()
    await at('Alpha')
    await p.getByRole('button', { name: 'Close friends' }).click()
    await query('>Switch to alice on Beta')
    await p
      .getByRole('option', { name: /Switch to alice on Beta/ })
      .first()
      .click()
    await at('Beta')
    console.log('PASS actor-only Friends command and explicit Switch to Beta')
    stage = 'foreign typing stays local'
    const requests = []
    const record = r => {
      if (new URL(r.url()).origin === origins.Alpha && /\/api\//.test(new URL(r.url()).pathname))
        requests.push(new URL(r.url()).pathname)
    }
    await query('#general')
    p.on('request', record)
    await search.fill('#gener')
    await alpha.locator('[data-palette-item="channel_' + alphaId + '"]').waitFor()
    p.off('request', record)
    assert.deepEqual(
      requests.filter(x => /\/members|\/channels|\/openapi|\/search/.test(x)),
      []
    )
    const docs = []
    const watch = r => {
      if (new URL(r.url()).pathname.endsWith('/openapi.json')) docs.push(new URL(r.url()).origin)
    }
    p.on('request', watch)
    const loaded = p.waitForResponse(
      r =>
        new URL(r.url()).origin === origins.Beta &&
        new URL(r.url()).pathname.endsWith('/openapi.json') &&
        r.ok()
    )
    await search.fill('/')
    await loaded
    p.off('request', watch)
    assert.deepEqual(docs, [origins.Beta])
    console.log('PASS API mode loads only the invoking Beta account specification')
    assert.deepEqual(errors, [])
    console.log('PASS typing combines cached account sources without fetching foreign content')
  } catch (e) {
    console.error('Palette browser stage', stage, e.message.split('\n')[0])
    throw Error(stage, { cause: e })
  }
}
