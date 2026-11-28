import type { Api } from './api'

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
export const mediaUrlOf = (session: { api: Api }, id: string): string => session.api.mediaUrl(id)

// The address of an uploaded profile picture at `size` pixels on the session's instance.
export const avatarUrlOf = (session: { api: Api }, id: string, size: number): string =>
  session.api.avatarUrl(id, size)

// The address the session's requests go to, and the origin it is served from.
export const apiBaseOf = (session: { api: Api }): string => session.api.base
export const apiOriginOf = (session: { api: Api }): string => session.api.origin()
