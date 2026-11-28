'use client'
import { personCalled } from '../lib/names'
import { Name } from './name'

import { asAccount } from '../lib/people'
import { ListRow } from './controls'
import { Grid, Inset, Lift, Row, Stack, Surface } from './layout'
import type { ReactNode } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { fieldRows, safeLink, webhookIdOf } from '../lib/webhooks'
import { cardAccent } from '../lib/embed_colors'
import { useStore } from '../lib/store'
import { useClock } from '../lib/client/react'
import { formatStamp, fullTime } from '../lib/timestamps'
import { IconButton } from './controls'
import { labelWith } from '../lib/names'
import type { RichEmbed, UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { useCopied } from '../lib/use_copied'
import { sharing } from '../lib/platform'

// Always shown next to a webhook's name, whatever name it posted with.
export function WebhookBadge() {
  return (
    <Inset
      title="Posted through a webhook, not by a member"
      as="span"
      pad="2xs"
      inset="bar"
      look="rounded-md bg-tertiary-container text-3xs leading-4 font-semibold tracking-wide text-on-tertiary-container"
      place="shrink-0 self-center"
    >
      WEBHOOK
    </Inset>
  )
}

type CardText = (s: string) => ReactNode
// A link as messages show it: its menu, and the warning before it opens another site.
type CardLink = (href: string, className: string, children: ReactNode) => ReactNode

function CardTime({ seconds }: { seconds: number }) {
  const clock = useClock()
  const ms = seconds * 1000
  return (
    <time dateTime={new Date(ms).toISOString()} title={fullTime(ms)}>
      {formatStamp(ms, 'f', clock.now())}
    </time>
  )
}

function RichCard({
  embed,
  index,
  text,
  line,
  link: Link,
  remove,
}: {
  embed: RichEmbed
  index: number
  text: CardText
  line: CardText
  link: CardLink
  remove: (() => void) | null
}) {
  const theme = useStore(s => s.theme)
  const color = cardAccent(embed.color, theme)
  const link = safeLink(embed.url)
  const authorLink = safeLink(embed.author?.url)
  const rows = fieldRows(embed.fields ?? [])
  const footer = embed.footer?.text ?? null
  const stamp = typeof embed.timestamp === 'number' ? embed.timestamp : null
  return (
    <div
      data-rich-embed
      style={color ? { borderLeftColor: color } : undefined}
      className="group/card relative w-full max-w-md min-w-0 rounded-lg border-l-4 border-outline bg-surface-container"
    >
      <Surface pad="md" tone="plain" gap="sm">
        {embed.author && (
          <p className="text-xs font-medium break-words text-on-surface">
            {authorLink
              ? Link(authorLink, 'hover:underline', line(embed.author.name))
              : line(embed.author.name)}
          </p>
        )}
        {(embed.title || embed.description) && (
          <Stack gap="3xs">
            {embed.title &&
              (link ? (
                Link(
                  link,
                  'block text-sm font-semibold break-words text-primary hover:underline',
                  line(embed.title)
                )
              ) : (
                <p className="text-sm font-semibold break-words text-on-surface">
                  {line(embed.title)}
                </p>
              ))}
            {embed.description && (
              <div className="text-sm break-words text-on-surface">{text(embed.description)}</div>
            )}
          </Stack>
        )}
        {rows.map((row, i) => (
          <Grid key={i} cols={row.length > 1 ? { base: 1, sm: 3 } : 1} gap="sm">
            {row.map((f, j) => (
              <div key={j} className="min-w-0">
                <p className="text-xs font-semibold break-words text-on-surface">{line(f.name)}</p>
                <div className="text-sm break-words text-on-surface-variant">{text(f.value)}</div>
              </div>
            ))}
          </Grid>
        ))}
        {(footer || stamp !== null) && (
          <p className="text-xs break-words text-on-surface-variant">
            {footer && line(footer)}
            {footer && stamp !== null && ' · '}
            {stamp !== null && <CardTime seconds={stamp} />}
          </p>
        )}
      </Surface>
      {remove && (
        <IconButton
          icon={X}
          label={labelWith`Remove embed ${index + 1}`}
          tooltip="Remove embed"
          size="xs"
          onClick={remove}
          place="absolute top-1.5 right-1.5 opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100 max-md:opacity-100"
        />
      )}
    </div>
  )
}

export function RichEmbeds({
  embeds,
  text,
  line,
  link,
  remove,
}: {
  embeds: readonly RichEmbed[]
  text: CardText
  line: CardText
  link: CardLink
  // The removal of the card at an index, where it can be removed.
  remove?: (index: number) => () => void
}) {
  if (!embeds.length) return null
  return (
    <Stack gap="2xs">
      {embeds.map((e, i) => (
        <RichCard
          key={i}
          index={i}
          embed={e}
          text={text}
          line={line}
          link={link}
          remove={remove ? remove(i) : null}
        />
      ))}
    </Stack>
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
      <Inset pad="lg" inset="sides">
        <Stack gap="sm">
          <Lift by="2xl">
            <Row gap="sm" align="end" justify="between">
              <Surface as="span" pad="xs" tone="high" radius="full" place="shrink-0">
                <UserAvatar person={asAccount(user, 'webhook')} size={64} />
              </Surface>
              <span>
                <WebhookBadge />
              </span>
            </Row>
          </Lift>
          <Name
            as="p"
            id={titleId}
            of={personCalled(user.display_name, user.username)}
            look="line-clamp-2 text-lg leading-6 font-semibold break-words text-on-surface"
          />
          <Surface pad="md" tone="low" radius="lg">
            <p className="text-sm text-on-surface-variant">
              Posted by an app or service through a webhook. It is not a member and cannot get
              messages.
            </p>
          </Surface>
          {id !== null && (
            <ListRow
              icon={copied ? Check : Copy}
              label={copied ? 'Copied' : 'Copy Webhook ID'}
              onClick={() => void sharing().copyText(String(id)).then(flash)}
            />
          )}
        </Stack>
      </Inset>
    </>
  )
}
