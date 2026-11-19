import { create } from 'zustand'
import { ctxFor } from '../actions/ctx'
import { allActions, defineAction, runAction } from '../actions/registry'
import { getBasePath } from '../basePath'
import { Sha256 } from '../sha256'
import { useStore } from '../store'
import type { RChatState } from '../store_types'
import {
  approveAppVisit,
  canView,
  cancelViewing,
  forgetViewing,
  leaveAppVisit,
  useViewing,
  requestViewing,
  viewingKey,
  type ViewingTarget,
} from '../viewing'
import { VIEW_LIMITS } from './ui/catalog'
import type { On } from './ui/types'
import { argumentValue, readPreview, type PreviewDefinition } from './preview_definition'

import {
  fileDigest,
  readSavedPreview,
  removePreviewFile,
  savedPreviews,
  storePreview,
  type SavedPreview,
} from './preview_files'

export interface PreviewSource {
  installation: string
  publisher: string
  revision: string
  name: string
  file?: File
  saved?: SavedPreview
  read(): Promise<string>
}

const digest = process.env.NEXT_PUBLIC_FIELD_NOTES_DIGEST ?? ''
export const exampleSource: PreviewSource = {
  installation: 'field-notes',
  publisher: 'bundled',
  revision: digest,
  name: 'Field notes',
  async read() {
    const response = await fetch(getBasePath() + '/app-examples/field-notes.json', {
      credentials: 'omit',
      redirect: 'error',
    })
    if (!response.ok) throw new Error('The example could not be loaded.')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (new Sha256().update(bytes).hex() !== digest)
      throw new Error('The example changed. Reload to open the current version.')
    return new TextDecoder().decode(bytes)
  },
}

export const fileSource = (file: File): PreviewSource => ({
  installation: crypto.randomUUID(),
  publisher: 'local-file',
  file,
  revision: 'selected',
  name: file.name,
  read: () =>
    file.size <= VIEW_LIMITS.chars
      ? file.text()
      : Promise.reject(new Error('This definition is too large.')),
})

export const savedSource = (
  account: string,
  server: string,
  file: SavedPreview
): PreviewSource => ({
  installation: 'file',
  publisher: 'local-file',
  revision: file.revision,
  name: file.name,
  saved: file,
  read: async () => readSavedPreview(account, server, file.revision),
})

interface Loaded {
  account: string
  server: string
  target: ViewingTarget
  source: PreviewSource
  fileBody?: string
  definition: PreviewDefinition
  release(): void
}

type PreviewState = {
  loaded: Loaded | null
  dialog: string | null
  values: Record<string, string>
  error: string | null
}
const empty: PreviewState = { loaded: null, dialog: null, values: {}, error: null }
export const usePreview = create<PreviewState>(() => empty)
let intent = 0

export const previewPlace = (s: RChatState, server: string) =>
  !!s.me &&
  !s.guest &&
  s.view?.kind === 'channel' &&
  s.view.server === server &&
  s.me.servers.some(x => x.name === server)
const current = (app: Loaded) => {
  const s = useStore.getState()
  return (
    usePreview.getState().loaded === app &&
    s.me?.username === app.account &&
    previewPlace(s, app.server)
  )
}
const targetOf = (account: string, server: string, src: PreviewSource): ViewingTarget => ({
  kind: 'app',
  name: src.name,
  sensitive: false,
  key: viewingKey(account, ['app', server, src.installation, src.publisher, src.revision]),
})
export function closePreview() {
  intent++
  if (useViewing.getState().prompt?.target.kind === 'app') cancelViewing()
  useStore.getState().closeDialog()
  usePreview.setState({ dialog: null, values: {}, error: null })
  leaveAppVisit()
}

export function forgetPreview() {
  const app = usePreview.getState().loaded
  if (app) {
    if (app.source.saved) removePreviewFile(app.account, app.server, app.source.revision)
    forgetViewing(app.target)
  }
  closePreview()
}
export const forgetSavedPreview = (account: string, server: string, file: SavedPreview) => {
  const target = targetOf(account, server, savedSource(account, server, file))
  if (usePreview.getState().loaded?.target.key === target.key) return forgetPreview()
  removePreviewFile(account, server, file.revision)
  forgetViewing(target)
}

const openForVisit = (app: Loaded, remember: boolean) => {
  const { saved } = app.source
  if (
    remember &&
    saved &&
    app.fileBody !== undefined &&
    !storePreview(app.account, app.server, saved, app.fileBody, aliasesOf(app.definition))
  ) {
    approveAppVisit(app.target, false)
    usePreview.setState({ error: 'Opened for this visit. This device could not save the app.' })
    return
  }
  approveAppVisit(app.target, remember)
}
const aliasesOf = (definition: PreviewDefinition) =>
  definition.actions.flatMap(a =>
    a.slash ? [{ slash: a.slash, argument: a.args.length > 0 }] : []
  )
const actionId = (app: Loaded, name: string) => `app.${app.definition.id}.${name}`
function applyStep(app: Loaded, step: On, values: Record<string, string>) {
  if (!current(app) || !canView(app.target)) return
  if ('action' in step) {
    const named = app.definition.actions.find(a => a.name === step.action)
    if (named) {
      const args = Object.fromEntries(
        Object.entries(step.args ?? {}).map(([key, expr]) => [key, argumentValue(expr, values)])
      )
      applyStep(app, named.on, { ...values, ...args })
    }
  } else if (
    step.op === 'close' ||
    (step.op === 'open' && app.definition.dialogs.has(step.dialog))
  ) {
    usePreview.setState({ dialog: step.op === 'open' ? step.dialog : null, values })
  }
}
export function previewStep(app: Loaded, step: On) {
  applyStep(app, step, usePreview.getState().values)
}

function register(app: Loaded) {
  const remove = app.definition.actions
    .filter(a => a.slash || a.palette)
    .map(a =>
      defineAction({
        id: actionId(app, a.name),
        scope: 'app',
        title: a.label,
        slash: a.slash,
        subtitle: () => app.definition.name,
        available: ctx =>
          current(app) &&
          ctx.server === app.server &&
          (ctx.via === 'bar' || (ctx.via === 'palette' && a.palette && canView(app.target))),
        args: a.args.map(f => ({ kind: 'text' as const, name: f.name, prompt: f.label ?? f.name })),
        run: async (_ctx, args) => {
          const seq = ++intent
          let remember = false
          if (!canView(app.target)) {
            if (
              !(await requestViewing(app.target, value => {
                remember = value
              }))
            )
              return
            if (seq !== intent || !current(app) || !canView(app.target)) return
            openForVisit(app, remember)
          }
          if (seq !== intent || !current(app) || !canView(app.target)) return
          useStore.getState().openDialog({ kind: 'app_preview', server: app.server })
          applyStep(app, a.on, Object.fromEntries(a.args.map(f => [f.name, args[f.name] ?? ''])))
        },
      })
    )
  return () => remove.forEach(off => off())
}

export async function launchPreview(server: string, source: PreviewSource) {
  const s = useStore.getState()
  if (!s.me || !previewPlace(s, server)) return
  const account = s.me.username
  let target = targetOf(account, server, source)
  const seq = ++intent
  const valid = () => {
    const now = useStore.getState()
    return (
      seq === intent &&
      now.activeDialog?.kind === 'app_preview' &&
      now.activeDialog.server === server &&
      now.me?.username === account &&
      previewPlace(now, server) &&
      targetOf(account, server, source).key === target.key
    )
  }
  try {
    const file = source.file
    let bytes: Uint8Array | undefined
    // A previously saved candidate can be identified locally before decoding any authored content.
    const known =
      file &&
      savedPreviews(account, server).filter(f => f.name === file.name && f.size === file.size)
    if (file && known?.length) {
      bytes = new Uint8Array(await file.arrayBuffer())
      if (!valid()) return
      const revision = fileDigest(bytes)
      const match = known.find(f => f.revision === revision)
      if (match) {
        source = savedSource(account, server, match)
        target = targetOf(account, server, source)
      }
    }
    let remember = false
    const choice =
      file || source.saved
        ? (value: boolean) => {
            remember = value
          }
        : undefined
    if (!canView(target) && !(await requestViewing(target, choice))) return
    if (!valid() || !canView(target)) return
    let body: string
    if (file) {
      if (file.size > VIEW_LIMITS.chars) throw new Error('This definition is too large.')
      bytes ??= new Uint8Array(await file.arrayBuffer())
      if (!valid() || !canView(target)) return
      body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } else {
      const currentApp = usePreview.getState().loaded
      body =
        source.saved && currentApp?.target.key === target.key && currentApp.fileBody !== undefined
          ? currentApp.fileBody
          : await source.read()
      if (!valid() || !canView(target)) return
    }
    const definition = readPreview(body.replace(/^\uFEFF/, ''))
    if (file && bytes && !source.saved) {
      source = savedSource(account, server, {
        name: file.name,
        size: file.size,
        revision: fileDigest(bytes),
      })
      target = targetOf(account, server, source)
    }
    usePreview.getState().loaded?.release()
    const app: Loaded = {
      account,
      server,
      source,
      target,
      definition,
      fileBody: source.saved ? body : undefined,
      release: () => {},
    }
    usePreview.setState({ loaded: app, dialog: null, values: {}, error: null })
    if (source.saved && (remember || !canView(target))) openForVisit(app, remember)
    app.release = register(app)
  } catch (e) {
    if (valid())
      usePreview.setState({
        error: e instanceof Error ? e.message : 'Cannot open this definition.',
      })
  }
}

const runAlias = (app: Loaded, slash: string, rest: string | undefined) => {
  const action = app.definition.actions.find(a => a.slash === slash)
  if (!action || (rest && !action.args.length)) return false
  const id = actionId(app, action.name)
  if (allActions().some(a => a.slash === slash && a.id !== id)) return false
  const args = action.args.length ? { [action.args[0].name]: rest ?? '' } : {}
  void runAction(id, ctxFor(useStore.getState(), { kind: 'none' }, 'bar'), args)
  return true
}

// A remembered app's alias opens that app before anything reaches chat. With more than one
// remembered app answering it, the launcher lets the viewer choose.
const runSavedAlias = (slash: string, rest: string | undefined) => {
  const s = useStore.getState()
  const server = s.view?.kind === 'channel' ? s.view.server : null
  if (!s.me || !server || !previewPlace(s, server)) return false
  if (allActions().some(a => a.slash === slash)) return false
  const account = s.me.username
  const owners = savedPreviews(account, server).filter(f =>
    f.aliases?.some(a => a.slash === slash && (a.argument || !rest))
  )
  if (!owners.length) return false
  s.openDialog({ kind: 'app_preview', server })
  if (owners.length > 1) {
    usePreview.setState({ error: `Choose the app for /${slash}.` })
    return true
  }
  const [file] = owners
  void launchPreview(server, savedSource(account, server, file)).then(() => {
    const app = usePreview.getState().loaded
    if (app?.server === server && app.source.revision === file.revision && current(app))
      runAlias(app, slash, rest)
  })
  return true
}

// Only an exact, unambiguous alias on a submitted chat line can invoke the preview.
export const dispatchPreviewText = (text: string) => {
  const match = /^\/([a-z][a-z0-9_-]*)(?:[ \t]+([^\n]*))?$/.exec(text.trim())
  if (!match) return false
  const [, slash, rest] = match
  const app = usePreview.getState().loaded
  if (app && current(app) && app.definition.actions.some(a => a.slash === slash))
    return runAlias(app, slash, rest)
  return runSavedAlias(slash, rest)
}

useViewing.subscribe((next, previous) => {
  if (next.revision === previous.revision) return
  const { loaded, dialog, values } = usePreview.getState()
  if (loaded && !canView(loaded.target) && (dialog || Object.keys(values).length))
    usePreview.setState({ dialog: null, values: {} })
})

useStore.subscribe((s, prev) => {
  const app = usePreview.getState().loaded
  if (app && (!previewPlace(s, app.server) || s.me?.username !== app.account)) {
    intent++
    app.release()
    usePreview.setState(empty)
    leaveAppVisit()
  }
  if (prev.activeDialog?.kind === 'app_preview' && s.activeDialog?.kind !== 'app_preview') {
    intent++
    leaveAppVisit()
  }
})
