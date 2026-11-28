'use client'
import { instanceAddress, instanceName } from '../lib/names'
import { Name } from '../components/name'
import { Button } from '../components/controls'
import { Row, Stack, Surface } from '../components/layout'
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
    <div className="flex min-h-app flex-col items-center safe-x-3 sm:safe-x-4">
      <Surface as="header" tone="plain" radius="none" pad="sm" place="w-full shrink-0">
        <Row gap="sm" justify="between">
          <ThemeToggle />
          <StatusClock />
        </Row>
      </Surface>
      <main className="my-auto w-full max-w-md rounded-2xl shadow-elevation-2">
        <Surface tone="low" pad="lg" gap="lg">
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
              <Surface tone="base" radius="lg" pad="md">
                <p className="text-xs">Instance</p>
                <span>
                  <Name of={instanceName(info?.name ?? account.conn.name)} /> ·{' '}
                  <Name of={instanceAddress(account.conn.host)} />
                </span>
              </Surface>
              {!owner && allowed && (
                <Button onClick={() => setAdding(true)} place="self-start">
                  Use another instance
                </Button>
              )}
              <SignInStep
                back={next}
                owner={owner}
                missing={missing}
                onSuccess={signedIn => {
                  if (!client.canWritePage(account) || adding) return
                  if (
                    signedIn.conn.origin !== account.conn.origin ||
                    !client.show(signedIn, 'none')
                  )
                    return
                  router.replace(accountPath(next, routeOwnerFor(signedIn)))
                }}
              />
            </>
          )}
          <Stack gap="2xs" align="center">
            <InstallButton />
            <IosInstallHint />
          </Stack>
        </Surface>
      </main>
    </div>
  )
}
