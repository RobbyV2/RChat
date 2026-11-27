import { asAccount } from '../lib/people'
import { personName } from '../lib/names'
import { Name } from './name'
import { SITE_NAME, bySite, systemParts } from '../lib/system_messages'
import type { Message } from '../lib/types'
import { Surface } from './layout'
import { ShortTime } from './timestamp'

// A join, leave, storage or pin line in a widget's message list, worded as in the channel.
export function WidgetNotice({ message }: { message: Message }) {
  const [before, after] = message.kind === 'pin' ? ['', ' pinned a message.'] : systemParts(message)
  return (
    <Surface
      as="article"
      pad="2xs"
      tone="plain"
      radius="none"
      data-mid={message.id}
      data-system={message.kind}
    >
      <p className="min-w-0 break-words text-sm text-on-surface-variant">
        {before}
        {bySite(message) ? (
          <span className="font-medium text-on-surface">{SITE_NAME}</span>
        ) : (
          <Name
            of={personName(asAccount(message.author, 'widget'))}
            withUsername
            look="font-medium text-on-surface"
          />
        )}
        {after} <ShortTime ts={message.created_at} className="text-xs opacity-70" />
      </p>
    </Surface>
  )
}
