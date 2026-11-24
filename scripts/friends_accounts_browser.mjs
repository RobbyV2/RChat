/* global console, localStorage, history, URL, fetch */
import assert from 'node:assert/strict'

export async function check({ actors, origins, fillCredentials, signIn }) {
  const p = actors.get('Alpha/alice').page
  const host = Object.fromEntries(Object.entries(origins).map(([k, v]) => [k, new URL(v).host]))
  const errors = []
  p.on('pageerror', e => errors.push(e.message))
  async function at(label, user) {
    await p.waitForFunction(owner => history.state?.acct === owner, user + '@' + host[label])
  }
  async function add(label, user, foreign = false) {
    await p.locator('[data-switcher-tile]:visible').click()
    if (foreign) {
      await p
        .getByRole('dialog', { name: 'Switch account' })
        .getByRole('button', { name: 'Add an instance', exact: true })
        .click()
      const field = p.getByLabel('Instance address', { exact: true })
      await field.fill(origins[label])
      await field.press('Enter')
      await p.getByRole('button', { name: 'I trust this app' }).click()
    } else
      await p
        .getByRole('dialog', { name: 'Switch account' })
        .getByRole('button', { name: 'Add an account on ' + label, exact: true })
        .click()
    await fillCredentials(p, label, user)
    await p.locator('[data-add-instance-step] form button[type=submit]').click()
    await at(label, user)
  }
  async function api(page, origin, name, path, method = 'GET', body) {
    const result = await page.evaluate(
      async ({ origin, name, path, method, body, appOrigin }) => {
        const key = 'rchat_token:' + name + (origin === appOrigin ? '' : '@' + origin)
        const token =
          localStorage.getItem(key) ??
          localStorage.getItem('rchat_token:' + name + '@' + new URL(origin).host)
        if (!token) throw Error('Missing scoped fixture credential')
        const response = await fetch(origin + '/api/v1' + path, {
          method,
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: body && JSON.stringify(body),
        })
        return {
          status: response.status,
          relation: path.endsWith('/friendship') ? (await response.json()).status : undefined,
        }
      },
      { origin, name, path, method, body, appOrigin: origins.Alpha }
    )
    assert.equal(result.status, 200, method + ' ' + path)
    return result.relation
  }
  let stage = 'authenticated participants'
  try {
    const bob = (await signIn('Alpha', 'bob')).page
    const carol = (await signIn('Beta', 'carol')).page
    await add('Beta', 'alice', true)
    await add('Alpha', 'alice2')
    for (const name of ['alice', 'alice2']) {
      await api(bob, origins.Alpha, 'bob', '/friends/requests', 'POST', { username: name })
      await api(p, origins.Alpha, name, '/friends/requests/bob/accept', 'POST')
    }
    await api(carol, origins.Beta, 'carol', '/friends/requests', 'POST', { username: 'alice' })
    stage = 'open grouped Friends'
    await p.keyboard.press('Control+k')
    const search = p.getByRole('combobox', { name: 'Search or run a command' })
    await search.fill('>Open friends')
    await search.press('Enter')
    await p.getByRole('tab', { name: /Pending/ }).click()
    const beta = p
      .getByRole('region', { name: 'alice on Beta', exact: true })
      .filter({ visible: true })
      .last()
    const acceptUrl = origins.Beta + '/api/v1/friends/requests/carol/accept'
    const accept = beta.getByRole('button', { name: /Accept carol/i })
    const [accepted] = await Promise.all([
      p.waitForResponse(r => r.url() === acceptUrl && r.request().method() === 'POST'),
      accept.click(),
    ])
    assert.equal(accepted.status(), 200)
    await accept.waitFor({ state: 'hidden' })
    await at('Alpha', 'alice2')
    assert.equal(await api(p, origins.Beta, 'alice', '/users/carol/friendship'), 'friend')
    console.log('PASS Beta/alice accepted Carol while Alpha/alice2 stayed shown')
    stage = 'coincident Alpha friends and filtering'
    await p.getByRole('tab', { name: 'All', exact: true }).click()
    const panel = p.getByRole('tablist', { name: 'Friends' }).locator('..')
    for (const name of ['alice', 'alice2'])
      await panel
        .getByRole('region', { name: name + ' on Alpha', exact: true })
        .locator('[data-friend=bob]')
        .waitFor()
    const alphaAlice = panel.getByRole('region', { name: 'alice on Alpha', exact: true })
    await alphaAlice
      .locator('[data-friend=bob]')
      .getByRole('button', { name: /More for bob/i })
      .click()
    await p.getByText('Remove friend', { exact: true }).filter({ visible: true }).last().click()
    await p
      .getByRole('dialog', { name: 'Remove friend' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click()
    await alphaAlice.locator('[data-friend=bob]').waitFor({ state: 'detached' })
    assert.equal(await api(p, origins.Alpha, 'alice', '/users/bob/friendship'), 'none')
    assert.equal(await api(p, origins.Alpha, 'alice2', '/users/bob/friendship'), 'friend')
    await at('Alpha', 'alice2')
    console.log('PASS background remove affects only Alpha/alice')
    await panel
      .getByRole('group', { name: 'Filter by account' })
      .getByRole('button', { name: 'alice on Beta' })
      .click()
    assert.equal(await panel.locator('[data-friend=bob]').count(), 0)
    await panel.locator('[data-friend=carol]').waitFor()
    console.log(
      'PASS Bob is independently listed for both Alpha accounts; Beta filter shows only Carol'
    )
    stage = 'qualified add'
    await p.getByRole('tab', { name: 'Add friend', exact: true }).click()
    const picker = panel.getByRole('combobox', { name: 'As' })
    await picker.selectOption({ label: 'alice2 · Alpha' })
    const field = panel.getByRole('textbox', { name: 'Usernames to add' })
    await field.fill('carol@' + host.Beta)
    await field.press('Enter')
    await panel
      .getByText('carol is on ' + host.Beta + '. Send as your account there.', { exact: true })
      .waitFor()
    assert.equal(await picker.locator('option:checked').textContent(), 'alice · Beta')
    await at('Alpha', 'alice2')
    const relation = p.waitForResponse(
      r => r.url() === origins.Beta + '/api/v1/users/carol/friendship' && r.ok()
    )
    await field.press('Enter')
    await relation
    const preview = p.getByRole('dialog', { name: 'Add friend', exact: true })
    await preview.getByText('There is no one to send a request to.', { exact: true }).waitFor()
    await preview.getByRole('button', { name: 'Cancel' }).click()
    await at('Alpha', 'alice2')
    await field.fill('zed@unknown.example')
    await field.press('Enter')
    await panel.getByRole('button', { name: 'Add unknown.example' }).waitFor()
    console.log(
      'PASS qualified name selects the target sender for review and unknown host offers Add'
    )
    await p.getByRole('tab', { name: 'All', exact: true }).click()
    await panel
      .locator('[data-friend=carol]')
      .getByRole('button', { name: /Message carol/i })
      .click()
    await at('Beta', 'alice')
    assert.deepEqual(errors, [])
    console.log('PASS Message switches to the friend row owner')
    stage = 'cross-account profile'
    await p.keyboard.press('Control+k')
    await search.fill('>Open friends')
    await search.press('Enter')
    await p.getByRole('tab', { name: 'All', exact: true }).click()
    const alpha2 = panel.getByRole('region', { name: 'alice2 on Alpha', exact: true })
    await alpha2.locator('[data-friend=bob] [role=button]').first().click()
    await at('Alpha', 'alice2')
    await p.getByRole('dialog', { name: /bob/i }).waitFor()
    assert.deepEqual(errors, [])
    console.log('PASS Profile opens on the selected row owner')
  } catch (e) {
    console.error('Friends browser stage', stage, e.message.split('\n')[0])
    throw Error(stage, { cause: e })
  }
}
