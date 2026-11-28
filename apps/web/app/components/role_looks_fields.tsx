'use client'
import { useRef, useState } from 'react'
import { SmilePlus, X } from 'lucide-react'
import { IconButton } from './controls'
import { EmojiPicker } from './emoji_picker'
import { Row } from './layout'
import { useNameLabels } from './name'
import { notAName, labelWith } from '../lib/names'

export interface RoleLooksPatch {
  icon?: string | null
  hoist?: boolean
  tint?: boolean
}

// How a role shows, on hosted servers and P2P rooms alike: its icon (one emoji after its members'
// names), whether its members show in a group of their own, and whether it colors their names.
export function RoleLooksFields({
  name,
  icon,
  hoist,
  tint,
  locked,
  onChange,
}: {
  name: string
  icon: string | null
  hoist: boolean
  tint: boolean
  locked: string | null
  onChange: (patch: RoleLooksPatch) => void
}) {
  const [picking, setPicking] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const say = useNameLabels()
  const called = say.covered(name, 'this role', true)
  const iconTitle = locked
    ? notAName(locked)
    : icon
      ? labelWith`Change the icon of ${called}`
      : labelWith`Add an icon to ${called}`
  const check = (checked: boolean, text: string, hint: string, flip: () => void) => (
    <label title={locked ?? hint} className={`flex text-sm ${locked ? 'opacity-60' : ''}`}>
      <Row as="span" gap="xs">
        <input
          type="checkbox"
          checked={checked}
          disabled={!!locked}
          onChange={flip}
          className="accent-primary"
        />
        {text}
      </Row>
    </label>
  )
  return (
    <Row data-role-looks gap="lg" wrap>
      <Row as="span" gap="2xs">
        <IconButton
          ref={ref}
          {...(icon ? { glyph: icon } : { icon: SmilePlus })}
          label={iconTitle}
          tone="tonal"
          shape="square"
          aria-expanded={picking}
          disabled={!!locked}
          onClick={() => setPicking(p => !p)}
        />
        {icon && !locked && (
          <IconButton
            icon={X}
            label={labelWith`Remove the icon of ${called}`}
            shape="square"
            onClick={() => onChange({ icon: null })}
          />
        )}
      </Row>
      {check(
        hoist,
        'Show members separately',
        'Its members get a group of their own in the member list',
        () => onChange({ hoist: !hoist })
      )}
      {check(tint, 'Color member names', "Its color shows on its members' names", () =>
        onChange({ tint: !tint })
      )}
      {picking && (
        <EmojiPicker
          anchor={ref.current}
          side="bottom"
          align="start"
          label="Role icon"
          onPick={emoji => {
            setPicking(false)
            onChange({ icon: emoji })
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </Row>
  )
}
