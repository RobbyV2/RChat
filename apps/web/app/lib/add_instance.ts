import type { Book } from './client/book'

export type AddStep = 'address' | 'trust' | 'known' | 'signin' | 'done'
export interface TrustContext {
  pageOrigin: string | null
  shell: boolean
  localServer?: boolean
  ownOrigin?: string | null
  knownAccountEntry?: boolean
}
export function trustText(host: string, pageHost: string | null) {
  return pageHost
    ? `This app is served by ${pageHost}, not by ${host}. It will keep your sign-in for ${host} and can read and send anything your account can. Continue only if you trust ${pageHost}.`
    : `This app will keep your sign-in for ${host} and can read and send anything your account can. Continue only if you got this app from a source you trust.`
}
export function p2pTrustText(pageHost: string | null) {
  return `Your P2P identity key will be stored by this app on this device. Anyone who controls the app can read your P2P messages and act as you. Continue only if you trust ${pageHost ?? 'this app'}.`
}
export function afterProbe(
  book: Book,
  origin: string,
  id: string,
  ctx: TrustContext
): { step: AddStep; error?: string } {
  const collision = book.instances.find(i => i.id === id && i.origin !== origin)
  if (collision)
    return {
      step: 'address',
      error: `That's the same instance as ${new URL(collision.origin).host}.`,
    }
  const known = book.instances.find(i => i.origin === origin)
  if (known && (known.accounts.length || known.guest))
    return { step: ctx.knownAccountEntry ? 'signin' : 'known' }
  if (book.instances.reduce((n, i) => n + i.accounts.length, 0) >= 50)
    return { step: 'address', error: 'This device already has 50 saved accounts.' }
  const hostedHere =
    !ctx.shell &&
    origin === ctx.pageOrigin &&
    (ctx.ownOrigin === undefined || ctx.ownOrigin === origin)
  return { step: ctx.localServer || hostedHere ? 'signin' : 'trust' }
}
export const alreadySignedIn = (name: string, host: string) =>
  `You're already signed in as ${name} on ${host}.`
export const addingAllowed = (shell: boolean, clientOnly: boolean, siteSetting: boolean) =>
  shell || clientOnly || siteSetting
