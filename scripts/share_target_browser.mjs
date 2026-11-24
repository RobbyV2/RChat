// Local hosted acceptance callback. A form navigation exercises the installed PWA POST handler.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import process from 'node:process'
export async function check({ actors, origins, fillCredentials, signIn, dms }) {
  const browser = actors.get('Alpha/alice').page.context().browser()
  const ctx = await browser.newContext({ serviceWorkers: 'allow' })
  const { page } = await signIn('Alpha', 'alice', ctx)
  const host = new globalThis.URL(origins.Beta).host
  let stage = 'service worker registration'
  try {
    await page.evaluate(() => globalThis.navigator.serviceWorker.ready.then(() => true))
    await page.waitForFunction(() => !!globalThis.navigator.serviceWorker.controller)
    const manifest = await page.evaluate(async () =>
      (await globalThis.fetch('/manifest.webmanifest')).json()
    )
    assert.equal(manifest.share_target.action, '/share-target/')
    const h = p => p.getByRole('dialog', { name: 'Share to RChat' })
    stage = 'add second account'
    await page
      .getByRole('button', { name: 'Add an instance', exact: true })
      .filter({ visible: true })
      .first()
      .click()
    await page.getByLabel('Instance address').fill(origins.Beta)
    await page.getByLabel('Instance address').press('Enter')
    await page.getByRole('button', { name: 'I trust this app' }).click()
    await fillCredentials(page, 'Beta', 'alice')
    await page.locator('form button[type=submit]').click()
    await page.waitForFunction(id => globalThis.history.state?.acct === id, 'alice@' + host)
    stage = 'real file drop and cancel'
    await page.evaluate(() => {
      const transfer = new globalThis.DataTransfer()
      transfer.items.add(new globalThis.File(['fake file'], 'discarded.txt'))
      globalThis.document.body.dispatchEvent(
        new globalThis.DragEvent('drop', {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        })
      )
    })
    await h(page).getByText('discarded.txt').waitFor()
    assert.equal(
      await h(page).getByRole('combobox', { name: /^As/ }).inputValue(),
      JSON.stringify([origins.Beta, 'alice', null])
    )
    await h(page).getByRole('button', { name: 'Cancel' }).click()
    await h(page).waitFor({ state: 'hidden' })
    stage = 'mobile multipart share navigation'
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => {
      const form = globalThis.document.createElement('form')
      form.id = 'fixture-share'
      form.method = 'post'
      form.enctype = 'multipart/form-data'
      form.action = '/share-target/'
      for (const [name, value] of [
        ['title', 'Shared fixture'],
        ['text', 'Disposable shared text'],
      ]) {
        const input = globalThis.document.createElement('input')
        input.name = name
        input.value = value
        form.append(input)
      }
      const input = globalThis.document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.name = 'files'
      form.append(input)
      globalThis.document.body.append(form)
    })
    await page.locator('#fixture-share input[type=file]').setInputFiles([
      { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('one') },
      { name: 'selected.txt', mimeType: 'text/plain', buffer: Buffer.from('two') },
    ])
    await page.evaluate(() => globalThis.document.getElementById('fixture-share').submit())
    await h(page)
      .getByText(/Disposable shared text/)
      .waitFor()
    await h(page)
      .getByRole('combobox', { name: /^As/ })
      .selectOption(JSON.stringify([origins.Beta, 'alice', null]))
    await h(page)
      .getByLabel('Choose one attachment for this draft')
      .selectOption({ label: 'selected.txt' })
    const id = dms.Beta.find(d => d.user === 'alice' || d.peer === 'alice').id
    await h(page)
      .getByRole('combobox', { name: /^Destination/ })
      .selectOption(JSON.stringify({ kind: 'dm', id }))
    let posts = 0
    const posting = r => {
      if (r.method() === 'POST' && /\/messages\/?$/.test(new globalThis.URL(r.url()).pathname))
        posts++
    }
    page.on('request', posting)
    await h(page).getByRole('button', { name: 'Open draft' }).click()
    await h(page).waitFor({ state: 'hidden' })
    await page.waitForFunction(() =>
      Array.from(
        globalThis.document.querySelectorAll('textarea,input,[contenteditable="true"]')
      ).some(el => (el.value ?? el.textContent ?? '').includes('Disposable shared text'))
    )
    assert.equal(await page.evaluate(() => globalThis.history.state.acct), 'alice@' + host)
    await page
      .getByText('selected.txt', { exact: true })
      .filter({ visible: true })
      .first()
      .waitFor()
    assert.equal(posts, 0)
    globalThis.console.log(
      'PASS actor-default window drop, cancel, real multipart PWA POST with two files, selected Beta DM draft without sending'
    )
  } catch (e) {
    globalThis.console.error('Share check ' + stage + ': ' + String(e.message).split('\n')[0])
    throw e
  } finally {
    await ctx.close()
  }
}

// Run against the static client-only export served on the supplied loopback URL.
if (process.argv[2] === '--static') {
  const site = new globalThis.URL(process.argv[3])
  assert(site.hostname === '127.0.0.1' || site.hostname === 'localhost')
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(site.origin)
    await page.getByRole('heading', { name: 'Connect to an RChat instance' }).waitFor()
    await page.evaluate(() => globalThis.navigator.serviceWorker.ready.then(() => true))
    if (!(await page.evaluate(() => !!globalThis.navigator.serviceWorker.controller)))
      await page.reload()
    await page.waitForFunction(() => !!globalThis.navigator.serviceWorker.controller)
    await page.evaluate(() => {
      const form = globalThis.document.createElement('form')
      form.method = 'post'
      form.enctype = 'multipart/form-data'
      form.action = '/share-target/'
      const field = globalThis.document.createElement('input')
      field.name = 'text'
      field.value = 'Disposable static share'
      form.append(field)
      globalThis.document.body.append(form)
      form.submit()
    })
    const dialog = page.getByRole('dialog', { name: 'Share to RChat' })
    await dialog.getByText('Disposable static share').waitFor()
    await dialog.getByText('Sign in to choose a destination.').waitFor()
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
    await dialog.waitFor({ state: 'hidden' })
    globalThis.console.log(
      'PASS static client-only startup with real share navigation and dismissal'
    )
  } finally {
    await browser.close()
  }
}
