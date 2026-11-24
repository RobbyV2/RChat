/* global URL, console */
// Two-instance acceptance callback. Both participants and the posted links exist on real servers.
import assert from 'node:assert/strict'

export async function check({ actors, origins, dms, fillCredentials, signIn }) {
  const page = actors.get('Alpha/alice').page
  const dm = dms.Alpha[0].id
  const link = origins.Beta + '/invite/rchat/?via=AlphaDM'
  const betaHost = new URL(origins.Beta).host
  const home = origins.Alpha + '/dm/' + dm + '/'
  const alpha = async () => {
    await page.goto(home)
    await page.getByText(dms.Alpha[0].marker, { exact: true }).first().waitFor()
  }
  const invite = async name => {
    await page.waitForURL(
      u =>
        u.origin === origins.Alpha &&
        u.searchParams.get('via') === 'AlphaDM' &&
        u.pathname === '/@' + name + '@' + betaHost + '/invite/rchat/'
    )
    await page.getByTitle('Close invite').first().waitFor()
  }
  const addLogin = async name => {
    await fillCredentials(page, 'Beta', name)
    await page.locator('[data-add-instance-step] form button[type=submit]').click()
  }
  const clickLink = () => page.getByRole('link', { name: link, exact: true }).first().click()
  let stage = 'Alpha DM'
  try {
    await page.getByPlaceholder(/Message @bob/).fill(link)
    await page.getByPlaceholder(/Message @bob/).press('Enter')
    stage = 'explicitly load remote invite and open the card'
    await page.getByRole('button', { name: 'Load preview' }).first().click()
    await page
      .getByRole('button', { name: 'Open on ' + betaHost })
      .first()
      .click()
    const trust = page.getByRole('button', { name: 'I trust this app' })
    await trust.waitFor()
    assert.equal(await page.getByLabel('Password', { exact: true }).count(), 0)
    await trust.click()
    await addLogin('carol')
    await invite('carol')
    console.log('PASS remote card requires trust and resumes the invite after sign-in')
    stage = 'direct single-account link'
    await alpha()
    await clickLink()
    await invite('carol')
    assert.equal(await page.getByRole('dialog', { name: 'Choose an account' }).count(), 0)
    console.log('PASS one Beta account opens without a chooser')
    stage = 'add second Beta account'
    await page.getByTitle('Close invite').first().click()
    await page.locator('[data-switcher-tile]:visible').click()
    await page.getByRole('button', { name: 'Add an account on Beta', exact: true }).click()
    await addLogin('alice')
    await page.waitForURL(u => u.pathname.startsWith('/@alice@' + betaHost + '/'))
    // Switch to Alpha in place so the last-shown Beta account is still known.
    await page.locator('[data-switcher-tile]:visible').click()
    const alphaRow = JSON.stringify([origins.Alpha, 'alice', null])
    await page.locator('[data-account-row=' + JSON.stringify(alphaRow) + ']').click()
    await page.getByText(dms.Alpha[0].marker, { exact: true }).first().waitFor()
    stage = 'chooser, recency and remembered preference'
    await clickLink()
    const chooser = page.getByRole('dialog', { name: 'Choose an account' })
    const account = chooser.getByRole('combobox')
    assert.equal(await account.inputValue(), 'alice')
    await account.selectOption('carol')
    await chooser.getByRole('checkbox').check()
    await chooser.getByRole('button', { name: 'Open', exact: true }).click()
    await invite('carol')
    await alpha()
    await clickLink()
    await invite('carol')
    console.log(
      'PASS multiple Beta accounts offer the recent default and remember the chosen account across reload'
    )
    stage = 'cross-instance message link into the previously shown DM'
    const betaDm = dms.Beta[0]
    const betaPrefix = '/@carol@' + betaHost
    await page.goto(origins.Alpha + betaPrefix + '/dm/' + betaDm.id + '/')
    const marker = page.getByText(betaDm.marker, { exact: true }).first()
    const mid = await marker.locator('xpath=ancestor::*[@data-row][1]').getAttribute('data-mid')
    await alpha()
    const msgUrl = origins.Beta + '/dm/' + betaDm.id + '/' + mid + '/'
    await page.getByPlaceholder(/Message @bob/).fill(msgUrl)
    await page.getByPlaceholder(/Message @bob/).press('Enter')
    for (let visit = 0; visit < 2; visit++) {
      await page.getByRole('link', { name: msgUrl, exact: true }).first().click()
      await page.waitForURL(u => u.pathname === betaPrefix + '/dm/' + betaDm.id + '/')
      await marker.waitFor()
      await page.goBack()
      await page.waitForURL(u => u.href === home)
    }
    console.log('PASS a Beta message opens its previously shown room in one history entry')
    stage = 'guest availability in a fresh profile'
    const { page: bob } = await signIn('Alpha', 'bob')
    await bob.goto(home)
    const card = bob
      .locator('[data-row]')
      .filter({ has: bob.getByRole('link', { name: link, exact: true }) })
      .first()
    await card.getByRole('button', { name: 'Load preview' }).click()
    const settings = bob.waitForResponse(r => r.url() === origins.Beta + '/api/v1/settings')
    await card.getByRole('button', { name: 'Open on ' + betaHost }).click()
    const guests = (await (await settings).json()).guests_enabled
    await bob.getByRole('button', { name: 'I trust this app' }).click()
    await bob.getByLabel('Password', { exact: true }).waitFor()
    const guest = bob.getByRole('button', { name: 'Browse as a guest' })
    assert.equal(await guest.count(), guests ? 1 : 0)
    if (guests) {
      await guest.click()
      await bob.waitForURL(
        u =>
          u.pathname === '/@' + betaHost + '/invite/rchat/' &&
          u.searchParams.get('via') === 'AlphaDM'
      )
    }
    console.log('PASS trusted add flow honors the instance guest setting (' + guests + ')')
  } catch (e) {
    console.error('Failed at ' + stage, e.message, new URL(page.url()).pathname)
    throw e
  }
}
