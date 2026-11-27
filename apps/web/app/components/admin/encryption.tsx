'use client'

import { ask, sendTo } from '../../lib/asks'
import { Loaded, useSource } from '../loaded'
import { KeyRound, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  BACKUP_WARNING,
  COPIES_HINT,
  COPIES_LABEL,
  EVERYWHERE,
  EVERYWHERE_CONFIRM,
  KEY_SAVED,
  KEY_SAVED_CONFIRM,
  PINNED_NOTE,
  REQUIRE_SERVER,
  REQUIRE_SERVER_HINT,
  REQUIRE_SITE,
  REQUIRE_SITE_HINT,
  ROTATE,
  ROTATE_CONFIRM,
  UNSEAL,
  UNSEAL_CONFIRM,
  UNSEAL_SERVER_CONFIRM,
  fingerprints,
  jobPlace,
  keySavedLine,
  keySourceLine,
  keptLines,
  keySourceNote,
  lostKeys,
  lostWarning,
  parseAdminEncryption,
  placesLine,
  readinessLine,
  resetWarning,
  rotating,
  rotationLine,
  runningJob,
  unreadableLine,
  type AdminEncryption,
} from '../../lib/admin_encryption'
import { useAccount } from '../../lib/client/react'
import { jobText, serverPlace } from '../../lib/sealing'
import { errorText } from '../../lib/store'
import { Button, Pill, SectionHeading } from '../controls'
import { Row, Stack, Surface } from '../layout'
import type { ReAuthBody, StoredSeal } from '../../lib/types'
import { ReAuthPrompt } from '../backup_phrase/reauth_prompt'
import { useSealJob } from '../server_storage'
import { SettingSwitch } from '../settings_fields'
import { PageRow } from '../settings_page'
import { time } from '../../lib/platform/time'
import { SignInLinks } from '../sso/sign_in_methods'
import { Dialog, FieldError } from '../ui'

const cardTitleCls = 'text-xs font-medium tracking-wide text-on-surface-variant uppercase'

function Card({ children }: { children: ReactNode }) {
  return (
    <Surface tone="base" radius="lg" pad="lg" gap="2xs">
      {children}
    </Surface>
  )
}

function Warning({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <Surface as="p" role="alert" data-warning={kind} tone="error" radius="lg" pad="lg">
      <Row as="span" gap="sm" align="start">
        <TriangleAlert size={18} aria-hidden className="shrink-0" />
        <span className="min-w-0 text-sm break-words">{children}</span>
      </Row>
    </Surface>
  )
}

// The key status, with the controls the section passes in: by the key source, under the
// encrypted storage card and under the jobs.
export function EncryptionStatus({
  view,
  now = time().now(),
  keyAction,
  storage,
  jobActions,
  rotateAction,
}: {
  view: AdminEncryption
  now?: number
  keyAction?: ReactNode
  storage?: ReactNode
  jobActions?: ReactNode
  rotateAction?: ReactNode
}) {
  const prints = fingerprints(view)
  const lost = lostKeys(view)
  const note = keySourceNote(view)
  const reset = resetWarning(view, now)
  const unreadable = unreadableLine(view)
  return (
    <Stack gap="md">
      {view.needs_backup && <Warning kind="backup">{BACKUP_WARNING}</Warning>}
      {lost.length > 0 && <Warning kind="lost">{lostWarning(lost)}</Warning>}
      {reset !== null && <Warning kind="reset">{reset}</Warning>}
      <Card>
        <p className={cardTitleCls}>Key source</p>
        <Row as="p" gap="sm">
          <KeyRound size={16} aria-hidden className="shrink-0 text-on-surface-variant" />
          <span data-key-source={view.source} className="min-w-0 text-sm break-words">
            {keySourceLine(view)}
          </span>
        </Row>
        {view.kms !== null && (
          <p data-kms className="min-w-0 font-mono text-xs break-all text-on-surface-variant">
            {view.kms}
          </p>
        )}
        {view.key_file !== null && (
          <p className="min-w-0 font-mono text-xs break-all text-on-surface-variant">
            {view.key_file}
          </p>
        )}
        {note !== null && <p className="text-xs text-on-surface-variant">{note}</p>}
        {keptLines(view).map(line => (
          <p key={line} data-kept className="text-xs text-on-surface-variant">
            {line}
          </p>
        ))}
        {view.source === 'file' && view.backed_up_at !== null && (
          <p data-backed-up className="text-xs text-on-surface-variant">
            {keySavedLine(view.backed_up_at, now)}
          </p>
        )}
        {keyAction}
        {prints.length === 0 && view.database_key && (
          <>
            {view.rotation && (
              <p role="status" data-rotation className="text-sm">
                {rotationLine(view.rotation)}
              </p>
            )}
            {rotateAction}
          </>
        )}
      </Card>
      {prints.length > 0 && (
        <Card>
          <p className={cardTitleCls}>Key fingerprints</p>
          <Stack as="ul" gap="2xs">
            {prints.map(p => (
              <Row as="li" key={p.id} gap="sm" wrap>
                <span className="min-w-0 font-mono text-sm break-all">{p.id}</span>
                <span className="font-mono text-sm text-on-surface-variant">{p.print}</span>
                {p.current && <Pill tone="outline">In use</Pill>}
              </Row>
            ))}
          </Stack>
          <p className="text-xs text-on-surface-variant">If a key leaked, rotate data keys too.</p>
          {view.rotation && (
            <p role="status" data-rotation className="text-sm">
              {rotationLine(view.rotation)}
            </p>
          )}
          {rotateAction}
        </Card>
      )}
      <Card>
        <p className={cardTitleCls}>Encrypted storage</p>
        <p className="text-sm">{readinessLine(view)}</p>
        <p className="text-sm">{placesLine(view)}</p>
        {unreadable !== null && (
          <p data-unreadable className="text-sm text-error">
            {unreadable}
          </p>
        )}
        <p className="text-xs text-on-surface-variant">
          Where it is on, messages are stored encrypted with a key this site keeps. This is not
          end-to-end encryption.
        </p>
        {storage}
      </Card>
      <Card>
        <p className={cardTitleCls}>Stored messages</p>
        {view.jobs.length === 0 ? (
          <p className="text-sm text-on-surface-variant">Nothing was encrypted or decrypted yet.</p>
        ) : (
          <Stack as="ul" gap="2xs">
            {view.jobs.map(job => {
              const where = jobPlace(job.place)
              return (
                <Row as="li" key={job.id} data-job={job.state} gap="sm" align="baseline" wrap>
                  <span className={`min-w-0 text-sm break-words ${where.name ? 'streamer' : ''}`}>
                    {where.text}
                  </span>
                  <span className="min-w-0 text-sm text-on-surface-variant">{jobText(job)}</span>
                </Row>
              )
            })}
          </Stack>
        )}
        {jobActions}
      </Card>
    </Stack>
  )
}

interface Confirming {
  title: string
  body: string
  purpose: 'seal-data' | 'keys-saved' | 'rotate-keys'
  context: string
  run(body: ReAuthBody): Promise<unknown>
}

// A step that needs a confirmation of who you are: what it does, then the confirmation.
function ReAuthDialog({
  step,
  onClose,
  onDone,
}: {
  step: Confirming
  onClose(): void
  onDone(): void
}) {
  return (
    <Dialog full title={step.title} onClose={onClose}>
      <Stack gap="md">
        <p className="text-sm text-on-surface">{step.body}</p>
        <SignInLinks>
          {(links, list) => (
            <>
              {list.notice}
              <ReAuthPrompt
                purpose={step.purpose}
                context={step.context}
                links={links ?? []}
                onBody={async body => {
                  await step.run(body)
                  onDone()
                }}
              />
            </>
          )}
        </SignInLinks>
      </Stack>
    </Dialog>
  )
}

// The site-wide switches: requiring encryption, and saying every copy runs this build.
function StorageSwitches({ view, reload }: { view: AdminEncryption; reload(): void }) {
  const owner = useAccount()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = (change: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    change()
      .then(
        reload,
        owner.lifetime.inSession((e: unknown) => setError(errorText(e)))
      )
      .finally(() => setBusy(false))
  }
  const { on, pinned } = view.required
  return (
    <Stack gap="none">
      <SettingSwitch
        label={REQUIRE_SITE}
        hint={pinned ? PINNED_NOTE : REQUIRE_SITE_HINT}
        value={on}
        disabled={pinned || busy}
        onChange={next => act(() => sendTo(owner, ask.adminRequireEncryption(next)))}
      />
      {view.copies_confirmed !== null && (
        <SettingSwitch
          label={COPIES_LABEL}
          hint={COPIES_HINT}
          value={view.copies_confirmed}
          disabled={busy}
          onChange={next => act(() => sendTo(owner, ask.adminConfirmCopies(next)))}
        />
      )}
      <FieldError message={error} />
    </Stack>
  )
}

// The status with its controls; asked again every two seconds while a job or a rotation runs.
function EncryptionControls({ view, reload }: { view: AdminEncryption; reload(): void }) {
  const owner = useAccount()
  const [step, setStep] = useState<Confirming | null>(null)
  const busy = runningJob(view) || rotating(view)
  useEffect(() => {
    if (!busy) return
    return time().every(2000, reload)
  }, [busy, reload])
  const job = (place: string, direction: 'seal' | 'unseal') => (body: ReAuthBody) =>
    sendTo(owner, ask.startSealJob(place, direction, body))
  const keyAction = view.source === 'file' && (
    <Row gap="sm" wrap>
      <Button
        onClick={() =>
          setStep({
            title: KEY_SAVED,
            body: KEY_SAVED_CONFIRM,
            purpose: 'keys-saved',
            context: '',
            run: body => sendTo(owner, ask.adminKeysSaved(body)),
          })
        }
      >
        {KEY_SAVED}
      </Button>
    </Row>
  )
  const jobActions = (
    <Row gap="sm" wrap>
      <Button
        onClick={() =>
          setStep({
            title: EVERYWHERE,
            body: EVERYWHERE_CONFIRM,
            purpose: 'seal-data',
            context: '*',
            run: job('*', 'seal'),
          })
        }
      >
        {EVERYWHERE}
      </Button>
      <Button
        onClick={() =>
          setStep({
            title: UNSEAL,
            body: UNSEAL_CONFIRM,
            purpose: 'seal-data',
            context: '*',
            run: job('*', 'unseal'),
          })
        }
      >
        {UNSEAL}
      </Button>
    </Row>
  )
  const rotateAction = (
    <Row gap="sm" wrap>
      <Button
        disabled={rotating(view)}
        onClick={() =>
          setStep({
            title: ROTATE,
            body: ROTATE_CONFIRM,
            purpose: 'rotate-keys',
            context: '',
            run: body => sendTo(owner, ask.adminRotateKeys(body)),
          })
        }
      >
        {ROTATE}
      </Button>
    </Row>
  )
  return (
    <>
      <EncryptionStatus
        view={view}
        keyAction={keyAction}
        storage={<StorageSwitches view={view} reload={reload} />}
        jobActions={jobActions}
        rotateAction={rotateAction}
      />
      {step && (
        <ReAuthDialog
          step={step}
          onClose={() => setStep(null)}
          onDone={() => {
            setStep(null)
            reload()
          }}
        />
      )}
    </>
  )
}

export function EncryptionSection() {
  const owner = useAccount()
  const [load, source] = useSource(async () => {
    const view = parseAdminEncryption(await sendTo(owner, ask.adminEncryption()))
    if (!view) throw new Error('The key status came back in a form this page cannot read')
    return view
  }, [owner])
  const reload = useCallback(() => source.refresh(), [source])
  return (
    <PageRow id="keys">
      <Surface tone="plain" pad="sm">
        <Loaded load={load} what="the key status">
          {view => <EncryptionControls view={view} reload={reload} />}
        </Loaded>
      </Surface>
    </PageRow>
  )
}

// "Require encryption" for one server and decrypting what it stored, on its admin page.
export function ServerEncryption({
  server,
  seal,
  refresh,
}: {
  server: string
  seal: StoredSeal | undefined
  refresh(): void
}) {
  const owner = useAccount()
  const place = serverPlace(server)
  const { job, refresh: again } = useSealJob(place, 'unseal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<Confirming | null>(null)
  const forced = seal?.server_forced === true
  const turn = (on: boolean) => {
    setBusy(true)
    setError(null)
    sendTo(owner, ask.adminRequireServerEncryption(server, on))
      .then(
        refresh,
        owner.lifetime.inSession((e: unknown) => setError(errorText(e)))
      )
      .finally(() => setBusy(false))
  }
  return (
    <>
      <SectionHeading as="p">Encrypted storage</SectionHeading>
      <SettingSwitch
        label={REQUIRE_SERVER}
        hint={REQUIRE_SERVER_HINT}
        value={forced}
        disabled={busy || seal === undefined}
        onChange={turn}
      />
      {job && (
        <p role="status" className="text-xs text-on-surface">
          {jobText(job)}
        </p>
      )}
      <Row gap="sm">
        <Button
          onClick={() =>
            setStep({
              title: UNSEAL,
              body: UNSEAL_SERVER_CONFIRM,
              purpose: 'seal-data',
              context: place,
              run: body => sendTo(owner, ask.startSealJob(place, 'unseal', body)),
            })
          }
        >
          {UNSEAL}
        </Button>
      </Row>
      <FieldError message={error} />
      {step && (
        <ReAuthDialog
          step={step}
          onClose={() => setStep(null)}
          onDone={() => {
            setStep(null)
            again()
          }}
        />
      )}
    </>
  )
}
