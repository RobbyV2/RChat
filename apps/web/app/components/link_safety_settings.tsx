'use client'

import { X } from 'lucide-react'
import { useStore } from '../lib/store'
import { forgetHost } from '../lib/link_safety'
import { SettingSwitch } from './settings_fields'
import { sectionCls } from './ui'

// Settings > Privacy: the external link warning, tracking parameters, and trusted domains.
export function LinkSafetySection() {
  const prefs = useStore(s => s.linkPrefs)
  const setLinkPrefs = useStore(s => s.setLinkPrefs)
  return (
    <>
      <p className={sectionCls}>Links</p>
      <div className="flex flex-col gap-1">
        <SettingSwitch
          label="Warn before opening external links"
          hint="Links in other people's messages ask before they open another site."
          value={prefs.warn}
          onChange={warn => setLinkPrefs({ ...prefs, warn })}
        />
        <SettingSwitch
          label="Strip tracking parameters when sending"
          hint="Takes utm_ and similar parameters off links in your messages."
          value={prefs.strip}
          onChange={strip => setLinkPrefs({ ...prefs, strip })}
        />
      </div>
      <p className={sectionCls}>Trusted link domains</p>
      {prefs.trusted.length === 0 ? (
        <p className="px-2 text-sm text-on-surface-variant">
          No trusted domains. Check &quot;Always trust&quot; in a link warning to add one.
        </p>
      ) : (
        <ul data-trusted-domains className="flex flex-col">
          {prefs.trusted.map(host => (
            <li
              key={host}
              className="flex items-center gap-2 rounded-xl px-2 py-1 hover:bg-surface-container"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-on-surface">
                {host}
              </span>
              <button
                type="button"
                title={`Remove ${host}`}
                aria-label={`Remove ${host}`}
                onClick={() => setLinkPrefs(forgetHost(prefs, host))}
                className="rounded-full p-2 text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
              >
                <X size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
