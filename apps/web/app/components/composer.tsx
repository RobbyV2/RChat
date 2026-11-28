'use client'
import { isUnsupported } from '../lib/place/feature'
import { OwnLoadNotice } from './own_load'

import { Name, useNameLabels } from './name'
import {
  instanceName,
  labelWith,
  notAName,
  unnamed,
  type Label,
  type NameLabeller,
} from '../lib/names'
import { Button, IconButton } from './controls'
import { PeerCodeButton } from './p2p/peer_code_button'
import { useActorSuffix, usePlaceActor } from './view_actor'
import { useEffect, useState } from 'react'
import { ChartColumn, Clock, ShieldAlert } from 'lucide-react'
import { useStore } from '../lib/store'
import { useAccount } from '../lib/client/react'
import { useLive } from '../lib/place/react'
import { clock } from '../lib/slowmode'
import { useCountdown } from '../lib/countdown'
import { Dialog, fieldCls } from './ui'
import { SITE_FILTER_NOTE } from '../lib/home'
import { useHome } from '../lib/home_store'
import { ReplyBar } from './replies'
import { ComposerGate, useGate } from './composer_gate'
import { ForwardBar, useForwardClip } from './forwards'
import { ComposerField } from './composer_field'
import { AttachButton, ComposerFiles, pastedFiles } from './composer_files'
import { useCompose } from '../lib/place/use_composer'
import type { ComposerList, WriteTo } from '../lib/place/composer'
import { CreatePollDialog } from './poll_dialog'
import { RelayPicker } from './relay_settings'
import type { RelayChoice } from '../lib/relays'
import { useInstanceLabel } from './instance_badge'
import { Dock, Row, Stack, Surface, Inset } from './layout'
import { ScheduledChip, SendLaterDialog } from './scheduled'

const PRESETS: { label: string; seconds: number | null }[] = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 604800 },
  { label: 'Indefinite', seconds: null },
]

const UNITS = [
  { label: 'seconds', mult: 1 },
  { label: 'minutes', mult: 60 },
  { label: 'hours', mult: 3600 },
  { label: 'days', mult: 86400 },
]

function ExpiryDialog({
  onPick,
  onClose,
}: {
  onPick: (seconds: number | null, relay: RelayChoice) => void
  onClose: () => void
}) {
  const prefs = useStore(s => s.relayPrefs)
  const [relay, setRelay] = useState<RelayChoice>(prefs.choice)
  const [amount, setAmount] = useState('')
  const [mult, setMult] = useState(3600)
  const custom = Number(amount)
  const customOk = Number.isFinite(custom) && custom > 0
  return (
    <Dialog title="P2P file expiration" onClose={onClose}>
      <Stack gap="lg">
        <Stack gap="md">
          <p className="text-sm text-on-surface-variant">
            Choose how long the P2P files in this message stay stored in your browser. Others can
            only download them while you are online.
          </p>
          <RelayPicker value={relay} onChange={setRelay} prefs={prefs} />
          <Row gap="sm" align="stretch" wrap>
            {PRESETS.map(p => (
              <Button key={p.label} variant="tonal" onClick={() => onPick(p.seconds, relay)}>
                {p.label}
              </Button>
            ))}
          </Row>
        </Stack>
        <Row gap="sm">
          <input
            type="number"
            min={1}
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="Custom"
            className={`${fieldCls} w-24 flex-1`}
          />
          <select value={mult} onChange={e => setMult(Number(e.target.value))} className={fieldCls}>
            {UNITS.map(u => (
              <option key={u.mult} value={u.mult}>
                {u.label}
              </option>
            ))}
          </select>
          <Button
            variant="filled"
            size="md"
            disabled={!customOk}
            onClick={() => onPick(Math.round(custom * mult), relay)}
          >
            Send
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}

// Said once where the instance filter checks messages, until closed.
function SiteFilterNote() {
  const { home } = useAccount()
  const { label } = useInstanceLabel()
  const owner = useHome(s => s.owner)
  const seen = useHome(s => s.prefs.tips.includes(SITE_FILTER_NOTE))
  if (owner === null || seen) return null
  return (
    <Surface
      data-filter-note
      as="p"
      row
      pad="md"
      inset="chip"
      gap="sm"
      tone="base"
      text="xs"
      ink="muted"
    >
      <ShieldAlert size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <Name of={instanceName(label)} /> filters some words in server messages.
      </span>
      <Button onClick={() => home.hideTip(SITE_FILTER_NOTE)} place="shrink-0">
        Got it
      </Button>
    </Surface>
  )
}

// What a list is called where a sentence names it.
const titleOf = (to: WriteTo, say: NameLabeller): Label =>
  to.what === null
    ? unnamed('')
    : to.what.kind === 'thread'
      ? unnamed('the thread')
      : to.what.kind === 'channel'
        ? labelWith`#${say.covered(to.what.name, 'this channel', to.own)}`
        : to.what.name.kind === 'person'
          ? labelWith`@${say(to.what.name, 'this person')}`
          : say(to.what.name, 'this contact')

const placeholderOf = (to: WriteTo, say: NameLabeller): Label =>
  to.what === null || (say.hiding && to.hidden !== null)
    ? (to.hidden ?? unnamed('Message'))
    : to.what.kind === 'thread'
      ? unnamed('Message thread')
      : labelWith`Message ${titleOf(to, say)}`

// Where a message is written, in whichever place is around: the conversation on screen, or its
// open thread.
export function Composer({ list = 'main' }: { list?: ComposerList }) {
  const compose = useCompose(list)
  const { key, text, replying, slowUntil, poll, to, listKey, filtered, peer } = useLive(
    compose.state
  )
  const { shut } = useGate(compose)
  const { stuck } = useLive(compose.files)
  const later = useLive(compose.later)
  const forwarding = useForwardClip() !== null
  const say = useNameLabels()
  const suffix = useActorSuffix(usePlaceActor())
  const [expiryOpen, setExpiryOpen] = useState(false)
  const [pollOpen, setPollOpen] = useState(false)
  const [laterOpen, setLaterOpen] = useState(false)
  const slowLeft = useCountdown(slowUntil)

  useEffect(() => {
    if (key !== null && later.fetched) compose.fetchLater()
  }, [compose, key, later.fetched])

  if (shut) return <ComposerGate compose={compose} list={list} />
  if (key === null) return null

  const hidden = say.hiding && to.hidden !== null
  const bar = replying ? (
    <ReplyBar list={list} />
  ) : forwarding ? (
    <ForwardBar list={list} sent={() => compose.forwarded(titleOf(to, say))} />
  ) : null

  return (
    <Dock gap="sm">
      <PeerCodeButton text={text} peer={peer} />
      {pollOpen && poll && !isUnsupported(poll) && (
        <CreatePollDialog target={poll} onClose={() => setPollOpen(false)} />
      )}
      {laterOpen && (
        <SendLaterDialog
          side={later.side}
          onClose={() => setLaterOpen(false)}
          onPick={async at => {
            const e = await compose.scheduleAt(at)
            if (!e) setLaterOpen(false)
            return e
          }}
        />
      )}
      {expiryOpen && (
        <ExpiryDialog
          onPick={(seconds, relay) => {
            setExpiryOpen(false)
            compose.sendKept(seconds, relay)
          }}
          onClose={() => setExpiryOpen(false)}
        />
      )}
      <ComposerFiles compose={compose} />
      {slowLeft > 0 && (
        <Inset
          role="status"
          data-slow-left
          as="p"
          row
          pad="md"
          inset="sides"
          gap="2xs"
          justify="end"
          text="xs"
          ink="muted"
          look="tabular-nums"
        >
          <Clock size={12} className="shrink-0" />
          Slow mode: {clock(slowLeft)}
        </Inset>
      )}
      {later.notice !== null && (
        <OwnLoadNotice
          what={later.notice}
          lead="Could not load the messages scheduled here."
          retry={compose.fetchLater}
        />
      )}
      <ScheduledChip place={key} items={later.items} ops={later.ops} />
      {filtered && <SiteFilterNote />}
      <ComposerField
        compose={compose}
        listKey={listKey}
        placeholder={
          hidden ? placeholderOf(to, say) : labelWith`${placeholderOf(to, say)}${suffix}`
        }
        slowLeft={slowLeft}
        blocked={stuck}
        bar={bar}
        inputProps={{ 'data-composer': peer ? 'p2p' : 'hosted' }}
        later={() => compose.laterDraft({ pick: () => setLaterOpen(true), busy: pollOpen })}
        onSend={() => compose.send(() => setExpiryOpen(true))}
        onPaste={e => compose.paste(pastedFiles(e))}
        tools={
          <>
            <AttachButton compose={compose} />
            {poll && (
              <IconButton
                icon={ChartColumn}
                label="Create poll"
                tooltip={isUnsupported(poll) ? notAName(poll.line) : undefined}
                disabled={isUnsupported(poll)}
                tight
                data-create-poll
                onClick={() => setPollOpen(true)}
              />
            )}
          </>
        }
      />
    </Dock>
  )
}
