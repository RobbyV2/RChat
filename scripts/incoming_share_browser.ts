// Run with bun scripts/incoming_share_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'

const bundle = await Bun.build({
  entrypoints: [
    fileURLToPath(
      new URL('../apps/web/app/lib/__tests__/browser/incoming_share.tsx', import.meta.url)
    ),
  ],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs)
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/sw.js')
      return new Response(Bun.file(new URL('../apps/web/public/sw.js', import.meta.url)))
    if (path === '/bundle.js') return new Response(bundle.outputs[0])
    return new Response(
      path === '/native'
        ? '<body><script type="module" src="/bundle.js"></script></body>'
        : '<body>Hosted share fixture</body>',
      {
        headers: { 'Content-Type': 'text/html' },
      }
    )
  },
})
const browser = await chromium.launch()
try {
  const native = await browser.newPage()
  await native.goto(new URL('/native', server.url).href)
  await native.locator('body[data-takes="1"]').waitFor()
  await native.getByText('Change route').click()
  await native.getByText('Finish take').click()
  const dialog = native.getByRole('dialog', { name: 'Share to RChat' })
  await dialog.getByText('Native fixture').waitFor()
  assert.equal(await native.locator('body').getAttribute('data-takes'), '1')
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  await native.evaluate(() => window.dispatchEvent(new Event('rchat-incoming-share')))
  await native.locator('body[data-takes="2"]').waitFor()
  await native.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['new'], 'replacement.txt'))
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
  })
  await dialog.getByText('replacement.txt').waitFor()
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  await native.getByText('Finish take').click()
  assert.equal(await dialog.count(), 0)
  await native.evaluate(() => window.dispatchEvent(new Event('rchat-incoming-share')))
  await native.locator('body[data-takes="3"]').waitFor()
  await native.getByText('Unmount host').click()
  await native.getByText('Finish take').click()
  assert.equal(await dialog.count(), 0)

  const ctx = await browser.newContext()
  const pages = [await ctx.newPage(), await ctx.newPage()]
  for (const [i, page] of pages.entries()) {
    await page.goto(server.url.href)
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
    })
    await page.waitForFunction(() => !!navigator.serviceWorker.controller)
    await page.evaluate(index => {
      const form = document.createElement('form')
      form.method = 'post'
      form.action = '/share-target/'
      form.enctype = 'multipart/form-data'
      const text = document.createElement('input')
      text.name = 'text'
      text.value = 'tab ' + index
      const file = document.createElement('input')
      file.type = 'file'
      file.name = 'files'
      const transfer = new DataTransfer()
      transfer.items.add(new File([String(index)], 'fixture.txt'))
      file.files = transfer.files
      form.append(text, file)
      document.body.append(form)
      form.submit()
    }, i)
    await page.waitForURL('**/?receive-share=*')
  }
  for (const i of [1, 0]) {
    const answers = await pages[i].evaluate(async () => {
      const ticket = new URL(location.href).searchParams.get('receive-share')
      const claim = () =>
        new Promise(resolve => {
          const channel = new MessageChannel()
          channel.port1.onmessage = async e => {
            channel.port1.close()
            resolve(e.data ? [e.data.text, await e.data.files[0].text()] : null)
          }
          navigator.serviceWorker.controller!.postMessage({ kind: 'receive-share', ticket }, [
            channel.port2,
          ])
        })
      return [await claim(), await claim()]
    })
    assert.deepEqual(answers, [['tab ' + i, String(i)], null])
  }
  console.log(
    'PASS native route change during take, replacement, dismissal, teardown, and two hosted tabs consuming their own multipart tickets once'
  )
} finally {
  await browser.close()
  server.stop(true)
}
