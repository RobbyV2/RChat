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
  appLinks: boolean
  known: (origin: string) => boolean
  current: () => boolean
  confirmSwitch: (host: string) => Promise<boolean>
  route: (origin: string, path: string) => Promise<void>
  fail: (message: string) => void
}

export const openDeepLink = async (raw: string, env: LinkEnv) => {
  const target = deepLinkTarget(raw, env.homeOrigin, env.appLinks)
  if (!target) return env.fail("That link can't be opened here")
  const origin = target.kind === 'home' ? env.homeOrigin : target.origin
  if (
    target.kind === 'other' &&
    !env.known(origin) &&
    !(await env.confirmSwitch(new URL(origin).host))
  )
    return
  if (env.current()) await env.route(origin, target.path)
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
