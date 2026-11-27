'use client'

import { X } from 'lucide-react'
import { useStore } from '../lib/store'
import { forgetSite } from '../lib/link_safety'
import { SettingNotes, SettingSwitch } from './settings_fields'
import { IconButton } from './controls'
import { Row, Stack, Surface } from './layout'
import { sectionCls } from './ui'

// Settings > Privacy: the external link warning, tracking parameters, and trusted domains.
export function LinkSafetySection() {
  const prefs = useStore(s => s.linkPrefs)
  const setLinkPrefs = useStore(s => s.setLinkPrefs)
  return (
    <>
      <p className={sectionCls}>Links</p>
      <Stack gap="2xs">
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
      </Stack>
      <p className={sectionCls}>Trusted link domains</p>
      {prefs.trusted.length === 0 ? (
        <SettingNotes>
          <p className="text-sm text-on-surface-variant">
            No trusted domains. Check &quot;Always trust&quot; in a link warning to add one.
          </p>
        </SettingNotes>
      ) : (
        <Stack as="ul" gap="none" data-trusted-domains>
          {prefs.trusted.map(host => (
            <li key={host} className="rounded-xl hover:bg-surface-container">
              <Surface pad="sm" inset="bar" tone="plain">
                <Row gap="sm">
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-on-surface">
                    {host}
                  </span>
                  <IconButton
                    icon={X}
                    label={`Remove ${host}`}
                    onClick={() => setLinkPrefs(forgetSite(prefs, host))}
                  />
                </Row>
              </Surface>
            </li>
          ))}
        </Stack>
      )}
    </>
  )
}
