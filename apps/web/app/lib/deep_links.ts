import { normalizeOrigin } from './instances'
import { safeNext } from './invite'

// `rchat://chat.example.com/invite/lobby/` names the page `/invite/lobby/` on that instance. The
// host is read like a typed instance address, so loopback hosts use http and others https. The
// mobile app can also be opened by `https://` app links, which name their origin exactly; other
// platforms refuse them.
export type LinkTarget =
  { kind: 'home'; path: string } | { kind: 'other'; origin: string; path: string; url: string }

export const deepLinkTarget = (
  raw: string,
  homeOrigin: string,
  appLinks = false
): LinkTarget | null => {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  const scheme = url.protocol
  if (
    (scheme !== 'rchat:' && !(appLinks && scheme === 'https:')) ||
    url.username ||
    url.password ||
    !url.host
  )
    return null
  const origin = scheme === 'https:' ? url.origin : normalizeOrigin(url.host)
  const path = safeNext(`${url.pathname || '/'}${url.search}${url.hash}`)
  if (!origin || !path) return null
  return origin === homeOrigin
    ? { kind: 'home', path }
    : { kind: 'other', origin, path, url: `${origin}${path}` }
}

export interface LinkEnv {
  homeOrigin: string
  // `https://` app links are accepted (mobile only).
  appLinks: boolean
  // Signed in or a guest on the current instance.
  signedIn: boolean
  // The chat itself is on screen and follows URL changes.
  live: boolean
  push: (path: string) => void
  load: (path: string) => void
  // Asks the user before a link changes the instance; true when they agree.
  confirmSwitch: (host: string) => Promise<boolean>
  switchTo: (origin: string) => Promise<string | null>
  openOutside: (url: string) => void
  fail: (message: string) => void
}

// Links on this instance open in place. A link on another instance becomes the instance when
// nobody is signed in yet and the user agrees, so a web page can't quietly point the app at
// another server; otherwise it opens in the browser, since one window holds one sign-in.
export const openDeepLink = async (raw: string, env: LinkEnv) => {
  const target = deepLinkTarget(raw, env.homeOrigin, env.appLinks)
  if (!target) return env.fail("That link can't be opened here")
  if (target.kind === 'home') return env.live ? env.push(target.path) : env.load(target.path)
  if (env.signedIn) return env.openOutside(target.url)
  if (!(await env.confirmSwitch(new URL(target.origin).host))) return
  const failed = await env.switchTo(target.origin)
  if (failed) return env.fail(failed)
  env.load(target.path)
}

export const confirmGate = (
  present: (host: string, answer: (yes: boolean) => void) => void
): LinkEnv['confirmSwitch'] => {
  let open = false
  return host => {
    if (open) return Promise.resolve(false)
    open = true
    return new Promise<boolean>(resolve =>
      present(host, yes => {
        open = false
        resolve(yes)
      })
    )
  }
}
