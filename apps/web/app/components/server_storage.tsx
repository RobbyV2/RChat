'use client'
import { ask, sendTo } from '../lib/asks'
import { time } from '../lib/platform/time'
import { useCallback, useEffect, useState } from 'react'
import { useAccount, useStore } from '../lib/client/react'
import { serverAdminPerms } from '../lib/store'
import { hasPerm, Perm } from '../lib/types'
import {
  EARLIER_ACTION,
  EARLIER_CONFIRM,
  hostedServerSeal,
  jobText,
  latestJob,
  serverPlace,
  type JobView,
} from '../lib/sealing'
import type { ReAuthBody } from '../lib/types'
import { ReAuthPrompt } from './backup_phrase/reauth_prompt'
import { Stack } from './layout'
import { SignInLinks } from './sso/sign_in_methods'
import { StorageSettings } from './storage_settings'
import { Dialog, textBtn } from './ui'

// The newest job of `place` in `direction`: asked when shown, taken from its progress as it
// arrives (to whoever started it), and asked again every 2 seconds while it runs. A job that
// had ended before it was shown here is left out unless it failed or was started here
// (`refresh`).
export function useSealJob(place: string | null, direction: JobView['direction'] = 'seal') {
  const acct = useAccount()
  const [fetched, setFetched] = useState<{ place: string; list: unknown } | null>(null)
  const pushed = useStore(s => (place ? s.sealJobs[place] : undefined))
  const [tick, setTick] = useState(0)
  const [seenRunning, setSeenRunning] = useState<string | null>(null)
  const [startedHere, setStartedHere] = useState(false)
  useEffect(() => {
    if (!place) return
    let live = true
    sendTo(acct, ask.sealJobs(place)).then(
      (list: unknown) => {
        if (live) setFetched({ place, list })
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [acct, place, direction, tick])
  const newest = latestJob(fetched?.place === place ? fetched.list : [], direction, pushed)
  const running = newest?.state === 'running'
  useEffect(() => {
    if (!running) return
    return time().every(2000, () => setTick(n => n + 1))
  }, [running])
  const key = place && newest ? `${place}:${newest.id}` : null
  useEffect(() => {
    if (running && key) setSeenRunning(key)
  }, [running, key])
  const job =
    newest && (newest.state !== 'done' || seenRunning === key || startedHere) ? newest : null
  const refresh = useCallback(() => {
    setStartedHere(true)
    setTick(n => n + 1)
  }, [])
  return { job, refresh }
}

// The last step of encrypting the earlier messages of a hosted `place`: who you are, then the
// job (after turning the switch on when `alsoOn`).
export function SealJobConfirm({
  place,
  alsoOn,
  turnOn,
  onStarted,
}: {
  place: string
  alsoOn: boolean
  turnOn(): Promise<unknown>
  onStarted(): void
}) {
  const acct = useAccount()
  return (
    <SignInLinks>
      {(links, list) => (
        <>
          {list.notice}
          <ReAuthPrompt
            purpose="seal-data"
            context={place}
            links={links ?? []}
            onBody={async (body: ReAuthBody) => {
              if (alsoOn) await turnOn()
              await sendTo(acct, ask.startSealJob(place, 'seal', body))
              onStarted()
            }}
          />
        </>
      )}
    </SignInLinks>
  )
}

// "Encrypt stored messages" in a hosted server's settings, for members with Manage server.
export function ServerStorage({ server }: { server: string }) {
  const acct = useAccount()
  const seal = useStore(s => s.servers[server]?.seal)
  const settings = useStore(s => s.settings)
  const canManage = useStore(s => hasPerm(serverAdminPerms(s, server), Perm.ManageServer))
  const place = serverPlace(server)
  const { job, refresh } = useSealJob(place)
  const state = hostedServerSeal(seal, canManage, settings)
  const turn = (on: boolean) => sendTo(acct, ask.updateServer(server, { seal: on }))
  return (
    <StorageSettings
      state={state}
      place="hosted"
      onSwitch={on => turn(on).then(() => undefined)}
      progress={job ? jobText(job) : null}
      earlierStep={(close, alsoOn) => (
        <SealJobConfirm
          place={place}
          alsoOn={alsoOn && !state.on}
          turnOn={() => turn(true)}
          onStarted={() => {
            refresh()
            close()
          }}
        />
      )}
    />
  )
}

// "Encrypt earlier messages" of a hosted DM, from its menu: who you are, then the job and how
// far it got.
export function SealEarlierDialog() {
  const place = useStore(s =>
    s.activeDialog?.kind === 'seal_earlier' ? s.activeDialog.place : null
  )
  return place ? <SealEarlierPanel key={place} place={place} /> : null
}

function SealEarlierPanel({ place }: { place: string }) {
  const closeDialog = useStore(s => s.closeDialog)
  const { job, refresh } = useSealJob(place)
  const [started, setStarted] = useState(false)
  return (
    <Dialog full title={EARLIER_ACTION} onClose={closeDialog}>
      <Stack gap="md">
        <p className="text-sm text-on-surface">{EARLIER_CONFIRM}</p>
        {job && (
          <p role="status" className="text-xs text-on-surface">
            {jobText(job)}
          </p>
        )}
        {started ? (
          <div className="flex justify-end">
            <button type="button" onClick={closeDialog} className={textBtn}>
              Close
            </button>
          </div>
        ) : (
          <SealJobConfirm
            place={place}
            alsoOn={false}
            turnOn={async () => undefined}
            onStarted={() => {
              setStarted(true)
              refresh()
            }}
          />
        )}
      </Stack>
    </Dialog>
  )
}
