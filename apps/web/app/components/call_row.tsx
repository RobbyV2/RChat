'use client'

import { Button } from './controls'
import type { ReactNode } from 'react'
import {
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Video,
  VideoOff,
  type LucideIcon,
} from 'lucide-react'
import { callLogInfo } from '../lib/call_choice'
import { callLog, type CallLogs } from '../lib/place/call_log'
import { isUnsupported } from '../lib/place/feature'
import { useFeature, useLive } from '../lib/place/react'
import type { PersonName } from '../lib/names'
import type { CallLog, Message } from '../lib/types'
import { callTone, type CallTone } from '../lib/voice_layout'
import { CallDuration, DirectBadge } from './call_buttons'
import { Inset, Row, Surface } from './layout'
import { Name } from './name'
import { P2pBadge } from './p2p/p2p_badge'
import { MessageTime } from './timestamp'
import { FUNCTIONAL } from '../lib/motion/functional'

const callIcon = (tone: CallTone, video: boolean, incoming: boolean): LucideIcon => {
  if (video) return tone === 'missed' || tone === 'declined' ? VideoOff : Video
  switch (tone) {
    case 'ringing':
      return incoming ? PhoneIncoming : PhoneOutgoing
    case 'active':
      return PhoneCall
    case 'missed':
      return PhoneMissed
    case 'declined':
      return PhoneOff
    case 'ended':
      return incoming ? PhoneIncoming : PhoneOutgoing
  }
}

const called = (who: PersonName | null) =>
  who ? (
    <Name of={who} withUsername look="font-medium text-on-surface" />
  ) : (
    <span className="font-medium text-on-surface">Someone</span>
  )

// A call in a conversation's messages, whichever place it is in: how it went, and the way to
// answer it while it rings.
export function CallRow({
  m,
  event,
  divider,
}: {
  m: Message
  // The place's own key for the message, where it has one beside the number.
  event?: string
  divider: ReactNode
}) {
  const logs = useFeature(callLog)
  if (!m.call || isUnsupported(logs)) return null
  return (
    <div data-row data-mid={m.id} data-event={event} data-call={callTone(m.call)}>
      {divider}
      <CallLine m={m} call={m.call} logs={logs} />
    </div>
  )
}

function CallLine({ m, call, logs }: { m: Message; call: CallLog; logs: CallLogs }) {
  const me = useLive(logs.self)
  const tone = callTone(call)
  const incoming = me !== null && me !== call.from
  const mark = logs.mark(call)
  const status: ReactNode =
    tone === 'ringing' ? (
      incoming ? (
        <>{called(logs.caller(call))} is calling you</>
      ) : (
        <>Calling {called(logs.other(m))}…</>
      )
    ) : tone === 'active' ? (
      <>In progress</>
    ) : null
  return (
    <CallLogLine
      call={call}
      me={me}
      time={m.created_at}
      status={status}
      badge={mark === 'direct' ? <DirectBadge /> : mark === 'peer' ? <P2pBadge /> : null}
      live={
        tone === 'active' &&
        call.answered_at !== null && (
          <Surface
            as="span"
            row
            pad="sm"
            inset="chip"
            gap="2xs"
            tone="plain"
            radius="full"
            text="xs"
            look="bg-status-green/15 font-medium text-status-green tabular-nums"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-status-green" />
            <CallDuration from={call.answered_at} />
          </Surface>
        )
      }
    >
      {tone === 'ringing' && incoming && (
        <Row as="span" gap="xs">
          <Button variant="accept" icon={Phone} title="Accept" onClick={() => logs.accept(m)}>
            Accept
          </Button>
          <Button variant="filled-danger" icon={PhoneOff} title="Decline" onClick={logs.decline}>
            Decline
          </Button>
        </Row>
      )}
    </CallLogLine>
  )
}

// One call log line: icon by kind and direction, "Voice call"/"Video call", the connection badge,
// the outcome (or `status` while it rings or runs), the duration and the time.
function CallLogLine({
  call,
  me,
  time,
  status,
  badge,
  live,
  children,
}: {
  call: CallLog
  me: string | null
  time: number
  status?: ReactNode
  badge?: ReactNode
  live?: ReactNode
  children?: ReactNode
}) {
  const tone = callTone(call)
  const incoming = me !== null && me !== call.from
  const info = callLogInfo(call, me)
  const Icon = callIcon(tone, info.video, incoming)
  const running = tone === 'ringing' || tone === 'active'
  const iconCls = running
    ? 'text-status-green'
    : info.alert
      ? 'text-error'
      : 'text-on-surface-variant'
  const direction = `${incoming ? 'Incoming' : 'Outgoing'} ${info.label.toLowerCase()}`
  return (
    <Inset data-call-row row pad="lg" inset="line" gap="md" look="hover:bg-surface-container-low">
      <span
        role="img"
        title={direction}
        aria-label={direction}
        className={`flex w-9 shrink-0 justify-center ${iconCls}`}
      >
        <Icon size={18} className={tone === 'ringing' ? FUNCTIONAL.pulseSafe : ''} />
      </span>
      <Row gap="sm" wrap lineGap="2xs" text="sm" ink="muted" place="min-w-0 flex-1">
        <span className="font-medium text-on-surface">{info.label}</span>
        {badge}
        <span aria-hidden>·</span>
        <span className="min-w-0">
          {status ?? (
            <span className={info.alert ? 'font-medium text-error' : ''}>{info.outcome}</span>
          )}
        </span>
        {info.duration !== null && (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{info.duration}</span>
          </>
        )}
        {live}
        <MessageTime ts={time} className="text-xs opacity-70" />
        {children}
      </Row>
    </Inset>
  )
}
