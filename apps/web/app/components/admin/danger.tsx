'use client'

import { useState } from 'react'
import { useStore } from '../../lib/store'
import { PageRow } from '../settings_page'
import { Button } from '../controls'
import { fieldCls } from '../ui'

export function DangerSection() {
  const adminDeleteMessage = useStore(s => s.adminDeleteMessage)
  const [id, setId] = useState('')
  return (
    <PageRow id="delete_message" className="p-2">
      <p className="text-sm">Delete a message</p>
      <p className="pb-2 text-xs text-on-surface-variant">
        Removes one message for everyone, by its id. This cannot be undone.
      </p>
      <form
        onSubmit={e => {
          e.preventDefault()
          const n = Number(id.trim())
          if (Number.isInteger(n) && n > 0) void adminDeleteMessage(n).then(() => setId(''))
        }}
        className="flex flex-wrap gap-2"
      >
        <input
          value={id}
          onChange={e => setId(e.target.value)}
          inputMode="numeric"
          placeholder="Message id"
          aria-label="Message id"
          className={`${fieldCls} min-w-32`}
        />
        <Button type="submit" variant="danger" place="shrink-0">
          Delete message
        </Button>
      </form>
    </PageRow>
  )
}
