import type { Api, ApiClient } from './api'

// Screens never hold the client of an instance: they name a request with `ask` and hand it to a
// load (components/loaded.tsx) or to `sendTo`.

const run: unique symbol = Symbol('ask')

// A request of an instance, named and with its arguments, not yet sent.
export interface Ask<T> {
  readonly [run]: (api: Api) => Promise<T>
}

type Asks = {
  [
    K in keyof Api as Api[K] extends (...args: never[]) => Promise<unknown> ? K : never
  ]: Api[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => Ask<R> : never
}

// Every request the client can make, by its name: `ask.listPasswords(server)`.
export const ask: Asks = new Proxy({} as Asks, {
  get:
    (_made, name) =>
    (...args: unknown[]): Ask<unknown> => ({
      [run]: api =>
        (api as unknown as Record<PropertyKey, (...a: unknown[]) => Promise<unknown>>)[name](
          ...args
        ),
    }),
})

// Sends a request to the instance of `session` (an account, or a connection to another site).
export const sendTo = <T>(session: { api: Api }, request: Ask<T>): Promise<T> =>
  request[run](session.api)

// The same request with its answer changed by `to`, and with `otherwise` what a refusal stands
// for (it may throw again).
export const asked = <T, U>(
  request: Ask<T>,
  to: (answer: T) => U | Promise<U>,
  otherwise?: (error: unknown) => U | Promise<U>
): Ask<U> => ({
  [run]: api => request[run](api).then(to, otherwise),
})

// Several requests sent together, answered once all are.
export const together = <T>(requests: Ask<T>[]): Ask<T[]> => ({
  [run]: api => Promise.all(requests.map(request => request[run](api))),
})

// A request that is answered without asking, for a screen that knows the answer already.
export const known = <T>(answer: T): Ask<T> => ({ [run]: () => Promise.resolve(answer) })

// The address of an uploaded file on the session's instance.
export const mediaUrlOf = (session: Held, id: string): string => session.api.mediaUrl(id)

// The address of an uploaded profile picture at `size` pixels on the session's instance.
export const avatarUrlOf = (session: Held, id: string, size: number): string =>
  session.api.avatarUrl(id, size)

// The address of that picture's animation at `size` pixels.
export const avatarAnimatedUrlOf = (session: Held, id: string, size: number): string =>
  session.api.avatarAnimatedUrl(id, size)

// The address the session's requests go to, and the origin it is served from (as the page at
// `page` reaches it).
export const apiBaseOf = (session: Held): string => session.api.base
export const apiOriginOf = (session: Held, page?: string): string => session.api.origin(page)

// What holds a connection to an instance: an account's session, a connection to another site, a
// frame's connection.
type Held = { api: ApiClient }

// Media addresses on the session's instance: a link preview's image, and the upload an address
// on the instance names (null for any other address).
export const previewUrlOf = (session: Held, path: string): string => session.api.previewUrl(path)
export const mediaIdOf = (session: Held, url: string): string | null => session.api.mediaId(url)

// Whether the session is signed in, and whether a guest's media in `server` loads by address.
export const signedInTo = (session: Held): boolean => session.api.signedIn()
export const guestMediaOf = (session: Held, server?: string) => session.api.guestMedia(server)

// The bytes behind a media address or an upload, fetched with the session's own credentials.
export const blobOf = (session: Held, url: string, server?: string, signal?: AbortSignal) =>
  session.api.authedBlob(url, server, signal)
export const mediaBlobOf = (session: Held, id: string, server?: string, signal?: AbortSignal) =>
  session.api.mediaBlob(id, server, signal)

// A guest's request: `headers` carry the guest session (lib/guest_chat.ts keeps it).
export const guestRequest = <T>(
  session: Held,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  headers: Record<string, string>
): Promise<T> => session.api.req<T>(method, path, body, headers)

// The API console: the instance's description of its API, and a request the person wrote, sent
// once as written with the session's credentials.
export const apiDescription = (session: Held): Promise<unknown> =>
  session.api.req<unknown>('GET', '/openapi.json')
export const sendWritten = (
  session: Held,
  request: { method: string; path: string; body?: unknown; headers?: Record<string, string> }
): Promise<Response> =>
  session.api.send(request.method, request.path, request.body, {
    headers: request.headers,
    retry: false,
  })
