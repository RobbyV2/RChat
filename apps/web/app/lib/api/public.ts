import { getBasePath } from '../basePath'
import { time } from '../platform/time'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const made: unique symbol = Symbol('public request')

const INSTANCE_PATHS = {
  document: '/api/instance',
  wellKnown: '/.well-known/rchat',
} as const

const ASSETS = {
  fieldNotes: '/app-examples/field-notes.json',
} as const

export type InstanceDocumentPath = keyof typeof INSTANCE_PATHS
export type AppAsset = keyof typeof ASSETS

export interface ConsentDecision {
  receipt: string
  action: 'describe' | 'allow' | 'cancel'
}

interface Plan {
  url: string
  method: 'GET' | 'POST'
  redirect: RequestRedirect
  json?: boolean
  body?: string
  sameOrigin?: boolean
  noStore?: boolean
  timeoutMs?: number
}

// A request that belongs to no account: it goes to another instance, to this site before anyone
// signed in, or to a file of the app. It carries no token, grant or cookie, and its address and
// headers come only from the builders below.
export class PublicRequest {
  readonly #plan: Plan

  constructor(key: typeof made, plan: Plan) {
    if (key !== made) throw new TypeError('public requests come from their builders')
    this.#plan = plan
  }

  get url() {
    return this.#plan.url
  }

  send(fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<Response> {
    const { url, method, redirect, json, body, sameOrigin, noStore, timeoutMs } = this.#plan
    const headers: Record<string, string> = {}
    if (json) headers.Accept = 'application/json'
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const init: RequestInit = { method, headers, credentials: 'omit', redirect }
    if (body !== undefined) init.body = body
    if (sameOrigin) init.mode = 'same-origin'
    if (noStore) init.cache = 'no-store'
    if (timeoutMs) init.signal = time().deadline(timeoutMs)
    return fetcher(url, init)
  }
}

// An instance's description of itself, from one of the two places it may be served.
export const instanceDocument = (origin: string, path: InstanceDocumentPath, timeoutMs: number) =>
  new PublicRequest(made, {
    url: `${origin}${INSTANCE_PATHS[path]}`,
    method: 'GET',
    redirect: 'manual',
    json: true,
    timeoutMs,
  })

// The public settings of the instance whose API root is `apiRoot`.
export const publicSettings = (apiRoot: string, timeoutMs: number) =>
  new PublicRequest(made, {
    url: `${apiRoot.replace(/\/+$/, '')}/v1/settings`,
    method: 'GET',
    redirect: 'follow',
    noStore: true,
    timeoutMs,
  })

// The sign-in consent page's question to the site that serves it.
export const clientConsent = ({ receipt, action }: ConsentDecision) =>
  new PublicRequest(made, {
    url: '/api/auth/oidc/client-consent',
    method: 'POST',
    redirect: 'error',
    body: JSON.stringify({ receipt, action }),
    sameOrigin: true,
    noStore: true,
  })

// A file shipped with the app.
export const appAsset = (asset: AppAsset) =>
  new PublicRequest(made, {
    url: `${getBasePath()}${ASSETS[asset]}`,
    method: 'GET',
    redirect: 'error',
  })
