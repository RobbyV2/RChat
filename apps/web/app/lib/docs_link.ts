// Where Settings and the palette open the docs: the copy the app carries (the client-only web
// build and the desktop and mobile apps bundle it under /docs), else the docs of the instance that
// serves this web app, which its site switch can turn off.

import type { InstanceConnection } from './instances'
import { clientOnly } from './instances'
import { inShell } from './platform/desktop'
import type { SiteSettings } from './types'

export type DocsPlace = { kind: 'open'; url: string } | { kind: 'off'; reason: string }

export const DOCS_PATH = '/docs/'

export function docsPlace({
  bundled,
  served,
  instance,
}: {
  // The app carries its own copy: a client-only build, or the shell.
  bundled: boolean
  // The serving instance's `docs` switch; undefined when this account is on another instance.
  served: boolean | undefined
  instance: string
}): DocsPlace {
  if (bundled || served !== false) return { kind: 'open', url: DOCS_PATH }
  return { kind: 'off', reason: `Documentation is turned off on ${instance}.` }
}

// The place for an account of this app, on the instance called `label`: its settings count only
// when its instance serves the page.
export const docsFor = (
  conn: Pick<InstanceConnection, 'isDefault'>,
  settings: Pick<SiteSettings, 'docs'>,
  label: string
) =>
  docsPlace({
    bundled: clientOnly() || inShell(),
    served: conn.isDefault ? settings.docs : undefined,
    instance: label,
  })
