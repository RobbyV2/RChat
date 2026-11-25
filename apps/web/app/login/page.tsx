'use client'
import { watchPagePolicy } from '../lib/client/hosted_policy'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AccountProvider, useAccount, useStore } from '../lib/client/react'
import { client } from '../lib/client/client'
import { routeOwnerFor, selectPageAccount } from '../lib/client/account_paths'
import type { AccountSession } from '../lib/client/session'
import { accountPath, parseAccountPath, type RouteOwner } from '../lib/view'
import { confirmationHint } from '../lib/provider_confirmation'
import { safeNext } from '../lib/invite'
import { awaitingInstance } from '../lib/instances'
import { shellInfo } from '../lib/platform'
import { UnavailableAccount } from './account_login'
import { AddInstanceFlow, useAddingAllowed } from '../components/add_instance'
import { SignInStep } from '../components/sign_in_step'
import StatusClock, { ThemeToggle } from '../components/status_clock'
import { InstallButton, IosInstallHint } from '../components/pwa_register'
export default function LoginPage() {
  const [destination, setDestination] = useState<
    | {
        account: AccountSession
        next: string
        owner: RouteOwner | null
      }
    | null
    | undefined
  >(undefined)
  useEffect(() => {
    const resolve = () => {
      const requested = safeNext(new URLSearchParams(window.location.search).get('next'))
      const next = requested ?? '/'
      const route = parseAccountPath(next)
      const account = requested
        ? selectPageAccount(next.split(/[?#]/, 1)[0], window.history.state)
        : client.shown()
      if (account && !requested) client.show(account, 'none')
      const pin =
        (requested || (account && confirmationHint(account))) &&
        typeof account?.credentialTarget === 'string'
          ? { username: account.credentialTarget, host: account.conn.host }
          : null
      setDestination(account && route ? { account, next, owner: route.owner ?? pin } : null)
    }
    return watchPagePolicy(resolve)
  }, [])
  if (destination === undefined) return null
  if (!destination) return <UnavailableAccount />
  return (
    <AccountProvider session={destination.account}>
      <LoginForm
        key={destination.account.renderKey}
        next={destination.next}
        owner={destination.owner}
      />
    </AccountProvider>
  )
}

function LoginForm({ next, owner }: { next: string; owner: RouteOwner | null }) {
  const account = useAccount()
  const router = useRouter()
  const info = useStore(s => s.instance)
  const authed = useStore(s => !!s.token || s.guest)
  const allowed = useAddingAllowed()
  const [missing, setMissing] = useState(false)
  const [adding, setAdding] = useState(false)
  const welcome =
    !owner &&
    (awaitingInstance(account.conn) ||
      missing ||
      (!!shellInfo() && !client.book.getState().instances.some(i => i.accounts.length || i.guest)))
  useEffect(() => {
    if (awaitingInstance(account.conn)) return
    let live = true
    void account.store
      .getState()
      .loadInstance()
      .then(ok => {
        if (!live) return
        setMissing(ok === false)
        if (ok) void account.store.getState().loadSettings()
      })
    return () => {
      live = false
    }
  }, [account])
  useEffect(() => {
    if (authed && client.canWritePage(account) && !adding)
      router.replace(accountPath(next, parseAccountPath(next)?.owner ?? routeOwnerFor(account)))
  }, [authed, account, adding, next, owner, router])
  return (
    <div className="flex min-h-app flex-col items-center px-safe-3 sm:px-safe-4">
      <header className="flex w-full shrink-0 items-center justify-between py-2">
        <ThemeToggle />
        <StatusClock />
      </header>
      <main className="my-auto flex w-full max-w-md flex-col gap-5 rounded-2xl bg-surface-container-low p-4 shadow-elevation-2 sm:p-6">
        <h1 className="flex justify-center">
          <img src="/rchat_logo.png" alt="RChat" className="h-16 w-auto" />
        </h1>
        {(allowed && (adding || welcome)) || (welcome && awaitingInstance(account.conn)) ? (
          <>
            {welcome && (
              <>
                <h2 className="text-xl font-medium">Connect to an RChat instance</h2>
                <p>Instances are run by different people. You can add more later.</p>
              </>
            )}
            <AddInstanceFlow
              onCancel={welcome ? undefined : () => setAdding(false)}
              onDone={session => {
                client.show(session, 'none')
                router.replace(accountPath('/', routeOwnerFor(session)))
              }}
            />
          </>
        ) : (
          <>
            <div className="rounded-xl bg-surface-container px-3 py-2">
              <p className="text-xs">Instance</p>
              <span className="streamer">
                {info?.name ?? account.conn.name} · {account.conn.host}
              </span>
            </div>
            {!owner && allowed && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="self-start text-sm text-primary"
              >
                Use another instance
              </button>
            )}
            <SignInStep
              back={next}
              owner={owner}
              missing={missing}
              onSuccess={signedIn => {
                if (!client.canWritePage(account) || adding) return
                if (signedIn.conn.origin !== account.conn.origin || !client.show(signedIn, 'none'))
                  return
                router.replace(accountPath(next, routeOwnerFor(signedIn)))
              }}
            />
          </>
        )}
        <div className="flex flex-col items-center gap-1">
          <InstallButton />
          <IosInstallHint />
        </div>
      </main>
    </div>
  )
}
