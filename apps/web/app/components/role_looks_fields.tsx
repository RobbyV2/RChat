'use client'
import { useRef, useState } from 'react'
import { SmilePlus, X } from 'lucide-react'
import { IconButton } from './controls'
import { EmojiPicker } from './emoji_picker'

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
  const iconTitle = locked ?? (icon ? `Change the icon of ${name}` : `Add an icon to ${name}`)
  const check = (checked: boolean, text: string, hint: string, flip: () => void) => (
    <label
      title={locked ?? hint}
      className={`flex items-center gap-1.5 text-sm ${locked ? 'opacity-60' : ''}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={!!locked}
        onChange={flip}
        className="accent-primary"
      />
      {text}
    </label>
  )
  return (
    <div data-role-looks className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <span className="flex items-center gap-1">
        <button
          ref={ref}
          type="button"
          title={iconTitle}
          aria-label={iconTitle}
          aria-expanded={picking}
          disabled={!!locked}
          onClick={() => setPicking(p => !p)}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-container-high text-base text-on-surface-variant outline-offset-2 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60 pointer-coarse:h-11 pointer-coarse:w-11"
        >
          {icon ?? <SmilePlus size={16} />}
        </button>
        {icon && !locked && (
          <IconButton
            icon={X}
            label={`Remove the icon of ${name}`}
            shape="square"
            onClick={() => onChange({ icon: null })}
          />
        )}
      </span>
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
    </div>
  )
}
