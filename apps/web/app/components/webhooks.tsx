'use client'

import type { ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { embedColor, fieldRows, safeLink, webhookIdOf } from '../lib/webhooks'
import type { RichEmbed, UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { Masked, useCopied } from './ui'
import { sharing } from '../lib/platform'

// Always shown next to a webhook's name, whatever name it posted with.
export function WebhookBadge() {
  return (
    <span
      title="Posted through a webhook, not by a member"
      className="shrink-0 self-center rounded-md bg-tertiary-container px-1 py-px text-[10px] leading-4 font-semibold tracking-wide text-on-tertiary-container"
    >
      WEBHOOK
    </span>
  )
}

type CardText = (s: string) => ReactNode

function RichCard({ embed, text, line }: { embed: RichEmbed; text: CardText; line: CardText }) {
  const color = embedColor(embed.color)
  const link = safeLink(embed.url)
  const rows = fieldRows(embed.fields ?? [])
  return (
    <div
      style={color ? { borderLeftColor: color } : undefined}
      className="mt-1 w-full max-w-md min-w-0 rounded-lg border-l-4 border-outline bg-surface-container px-3 py-2"
    >
      {embed.title &&
        (link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="block text-sm font-semibold break-words text-primary hover:underline"
          >
            {line(embed.title)}
          </a>
        ) : (
          <p className="text-sm font-semibold break-words text-on-surface">{line(embed.title)}</p>
        ))}
      {embed.description && (
        <div className="mt-0.5 text-sm break-words text-on-surface">{text(embed.description)}</div>
      )}
      {rows.map((row, i) => (
        <div
          key={i}
          className={`mt-2 grid gap-x-4 gap-y-1 ${row.length > 1 ? 'sm:grid-cols-3' : 'grid-cols-1'}`}
        >
          {row.map((f, j) => (
            <div key={j} className="min-w-0">
              <p className="text-xs font-semibold break-words text-on-surface">{line(f.name)}</p>
              <div className="text-sm break-words text-on-surface-variant">{text(f.value)}</div>
            </div>
          ))}
        </div>
      ))}
      {embed.footer?.text && (
        <p className="mt-2 text-xs break-words text-on-surface-variant">
          {line(embed.footer.text)}
        </p>
      )}
    </div>
  )
}

export function RichEmbeds({
  embeds,
  text,
  line,
}: {
  embeds: RichEmbed[]
  text: CardText
  line: CardText
}) {
  if (!embeds.length) return null
  return (
    <div className="flex flex-col">
      {embeds.map((e, i) => (
        <RichCard key={i} embed={e} text={text} line={line} />
      ))}
    </div>
  )
}

// The small profile card of a webhook author: no member details, no DM.
export function WebhookProfile({
  user,
  sheet,
  titleId,
}: {
  user: UserRef
  sheet: boolean
  titleId: string
}) {
  const [copied, flash] = useCopied()
  const id = webhookIdOf(user.username)
  return (
    <>
      <div
        aria-hidden
        className={`shrink-0 bg-surface-container-highest ${sheet ? 'h-20' : 'h-14'}`}
      />
      <div className={sheet ? 'px-5' : 'px-4'}>
        <div className="-mt-10 flex items-end justify-between gap-2">
          <span className="block shrink-0 rounded-full bg-surface-container-high p-1.5">
            <UserAvatar
              username={user.username}
              avatarKind={user.avatar_kind}
              avatarColor={user.avatar_color}
              size={64}
            />
          </span>
          <span className="mb-1">
            <WebhookBadge />
          </span>
        </div>
        <p
          id={titleId}
          className="streamer mt-2 line-clamp-2 text-lg leading-6 font-semibold break-words text-on-surface"
        >
          <Masked text={user.display_name} />
        </p>
        <p className="mt-2 rounded-xl bg-surface-container-low p-3 text-sm text-on-surface-variant">
          Posted by an app or service through a webhook. It is not a member and cannot get messages.
        </p>
        {id !== null && (
          <button
            onClick={() => void sharing().copyText(String(id)).then(flash)}
            className={`mt-2 flex w-full items-center gap-3 rounded-lg px-2.5 text-left text-sm text-on-surface hover:bg-surface-container-highest ${sheet ? 'min-h-11' : 'py-1.5'}`}
          >
            <span className="shrink-0">{copied ? <Check size={16} /> : <Copy size={16} />}</span>
            {copied ? 'Copied' : 'Copy Webhook ID'}
          </button>
        )}
      </div>
    </>
  )
}
