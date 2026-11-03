// Smoke test for a desktop build made with `--features smoke`; scripts/smoke.sh prepends
// SMOKE_INSTANCE and SMOKE_HOLD and starts the app with an `rchat://` link to the instance.
// Checks that the link waits for a click before switching instance, enters as a guest, saves
// files through the shell, opens Settings and checks the desktop parts, then reports through a
// smoke:// navigation the shell turns into the exit code.
;(() => {
  if (window.top !== window) return
  const done = (ok, why = '') => {
    location.href = ok ? 'smoke://pass/' : `smoke://fail/${encodeURIComponent(why)}`
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const wait = async (what, test, ms = 20000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
      const got = test()
      if (got) return got
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const find = (sel, text) =>
    [...document.querySelectorAll(sel)].find(e => e.textContent.includes(text))
  const exact = (sel, text) =>
    [...document.querySelectorAll(sel)].find(e => e.textContent.trim() === text)
  const type = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const invoke = (cmd, args, options) => window.__TAURI_INTERNALS__.invoke(cmd, args, options)
  const bytes = text => new TextEncoder().encode(text)
  const chunk = (id, text) => invoke('save_chunk', bytes(text), { headers: { 'x-save': `${id}` } })
  const PHASE = 'rchat_smoke_phase'

  // First page: the link from the command line asks before it changes the instance. A save left
  // open here must be dropped when the page goes away.
  const confirmLink = async () => {
    const host = SMOKE_INSTANCE.replace(/^https?:\/\//, '').replace(/\/$/, '')
    const dialog = await wait('switch dialog', () =>
      [...document.querySelectorAll('[role="dialog"]')].find(d =>
        d.textContent.includes('Switch instance?')
      )
    )
    const shown = [...dialog.querySelectorAll('*')].find(e => e.textContent === host)
    if (!shown) throw new Error(`dialog shows ${dialog.querySelector('p')?.textContent}`)
    await sleep(1500)
    if (!dialog.isConnected) throw new Error('dialog closed without a click')
    if (!find('button', 'Connect')) throw new Error('instance changed without a click')
    const leaked = await invoke('save_begin', { name: 'leaked.txt' })
    await chunk(leaked, 'never finished')
    sessionStorage.setItem(PHASE, 'opened')
    exact('button', 'Open').click()
  }

  const saves = async () => {
    const id = await invoke('save_begin', { name: '../smoke.txt' })
    await chunk(id, 'hello ')
    await chunk(id, 'world')
    await invoke('save_end', { id, ok: true })
    const dropped = await invoke('save_begin', { name: 'aborted.txt' })
    await chunk(dropped, 'half')
    await invoke('save_end', { id: dropped, ok: false })
    const stale = await chunk(dropped, 'more').then(
      () => false,
      () => true
    )
    if (!stale) throw new Error('an aborted save took more data')
  }

  const run = async () => {
    if (!sessionStorage.getItem(PHASE)) return confirmLink()
    const info = window.__RCHAT_DESKTOP__
    if (!info) throw new Error('no desktop info')
    if (document.documentElement.dataset.chrome !== info.os) throw new Error('no window chrome')
    await wait('title bar', () => document.querySelector('[data-tauri-drag-region]'))
    if (info.os !== 'macos')
      await wait('window buttons', () => document.querySelector('button[aria-label="Close"]'))

    const settings = await wait('sign in or chat', () => {
      const connect = find('button', 'Connect')
      const input = connect?.closest('form')?.querySelector('input')
      if (input && !input.value) {
        type(input, SMOKE_INSTANCE)
        setTimeout(() => connect.click(), 100)
      }
      find('button', 'cannot send messages')?.click()
      return document.querySelector('button[title="Settings"]')
    })

    const prefs = await invoke('desktop_settings')
    if (typeof prefs.close_to_tray !== 'boolean') throw new Error('settings command failed')
    await invoke('set_badge', { count: 3 })
    const denied = await invoke('plugin:opener|open_url', { url: 'https://example.com' }).then(
      () => false,
      () => true
    )
    if (!denied) throw new Error('a plugin command outside the capability was allowed')
    if ((await invoke('notify_permission')) !== 'granted') throw new Error('no notifications')
    await saves()

    settings.click()
    await wait('desktop settings', () => find('p', 'Desktop app'))
    await wait('update button', () => exact('button', 'Check for updates'))
    await sleep(SMOKE_HOLD * 1000)
    done(true)
  }

  addEventListener('DOMContentLoaded', () =>
    setTimeout(() => run().catch(e => done(false, String(e?.message ?? e))), 1000)
  )
})()
