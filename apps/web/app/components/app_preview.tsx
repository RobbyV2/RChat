'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { useStore } from '../lib/store'
import { useAccount } from '../lib/client/react'
import {
  exampleSource,
  fileSource,
  savedSource,
  previewPlace,
  previewFor,
  type LoadedPreview,
} from '../lib/apps/preview'
import { savedPreviews } from '../lib/apps/preview_files'
import type { Node } from '../lib/apps/ui/types'
import { Button } from './controls'
import { buttonLook } from '../lib/controls'
import { CloseButton, fieldCls, Masked } from './ui'

function Parts({ node, app }: { node: Node; app: LoadedPreview }): ReactNode {
  const { usePreview, previewStep } = previewFor(useAccount())
  const values = usePreview(s => s.values)
  const setField = (name: string, value: string) =>
    usePreview.setState(s => ({ values: { ...s.values, [name]: value } }))
  const children = (items: Node[]) => items.map((n, i) => <Parts key={i} node={n} app={app} />)
  switch (node.c) {
    case 'row':
    case 'stack':
      return (
        <div
          className={
            node.c === 'stack' ? 'flex min-w-0 flex-col gap-3' : 'flex min-w-0 flex-wrap gap-3'
          }
        >
          {children(node.children)}
        </div>
      )
    case 'text':
      return (
        <p className="break-words">
          <Masked text={node.text} />
        </p>
      )
    case 'value':
      return (
        <p className="whitespace-pre-wrap break-words">
          {'field' in node.bind ? values[node.bind.field] : null}
        </p>
      )
    case 'button':
      return (
        <Button variant="filled" size="md" onClick={() => previewStep(app, node.on)}>
          <Masked text={node.label} />
        </Button>
      )
    case 'input': {
      const props = {
        className: fieldCls,
        value: values[node.field] ?? '',
        maxLength: 4096,
        onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          setField(node.field, e.target.value),
      }
      return (
        <label className="flex min-w-0 flex-col gap-1">
          <Masked text={node.label ?? node.field} />
          {node.kind === 'multiline' ? <textarea {...props} rows={3} /> : <input {...props} />}
        </label>
      )
    }
    case 'form':
      return (
        <form
          className="flex flex-col gap-3"
          onSubmit={e => {
            e.preventDefault()
            if (node.on_done) previewStep(app, node.on_done)
          }}
        >
          {node.fields?.map(name => (
            <label key={name} className="flex min-w-0 flex-col gap-1">
              {name}
              <input
                className={fieldCls}
                maxLength={4096}
                value={values[name] ?? ''}
                onChange={e => setField(name, e.target.value)}
              />
            </label>
          ))}
          <Button type="submit" variant="filled" size="md">
            <Masked text={node.submit} />
          </Button>
        </form>
      )
    default:
      return null
  }
}

function AppDialog({ node, app }: { node: Extract<Node, { c: 'dialog' }>; app: LoadedPreview }) {
  const { previewStep } = previewFor(useAccount())
  const pane = useRef<HTMLDivElement>(null)
  const close = () => previewStep(app, { op: 'close' })
  useEffect(() => {
    const el = pane.current
    ;(el?.querySelector<HTMLElement>('input,textarea,button') ?? el)?.focus()
  }, [node])
  return (
    <div
      ref={pane}
      role="dialog"
      aria-labelledby="authored-dialog-title"
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-3 rounded-xl bg-surface-container-highest p-4"
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          e.preventDefault()
          close()
        }
        if (e.key !== 'Tab') return
        const focusable = e.currentTarget.querySelectorAll<HTMLElement>('input,textarea,button')
        const last = focusable[focusable.length - 1],
          first = focusable[0]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }}
    >
      <h4 id="authored-dialog-title" className="break-words font-medium">
        <Masked text={node.title} />
      </h4>
      {node.children.map((n, i) => (
        <Parts key={i} node={n} app={app} />
      ))}
      <Button size="md" onClick={close}>
        Close dialog
      </Button>
    </div>
  )
}

// The host's line under an app's name. No signing key vouches for a local definition, so its
// author's name always shows as unverified.
export function AppByline({ author }: { author: string }) {
  return (
    <p className="mb-3 flex min-w-0 shrink-0 flex-wrap items-baseline gap-x-2 text-sm text-on-surface-variant">
      <span className="line-clamp-2 min-w-0 break-words">
        By <Masked text={author} />
      </span>
      <span
        data-app-unverified
        title="The author's name comes from the file and is not verified"
        className="shrink-0 rounded-full bg-surface-container-highest px-2 text-xs font-medium text-on-surface"
      >
        Unverified
      </span>
    </p>
  )
}

export function AppPreview() {
  const where = useStore(s =>
    s.activeDialog?.kind === 'app_preview' && previewPlace(s, s.activeDialog.server)
      ? s.activeDialog.server
      : null
  )
  return where ? <Launcher key={where} where={where} /> : null
}

function Launcher({ where }: { where: string }) {
  const owner = useAccount()
  const { canView, useViewing } = owner.viewing
  const {
    usePreview,
    closePreview,
    launchPreview,
    forgetPreview,
    forgetSavedPreview,
    previewStep,
  } = previewFor(owner)
  const frame = useRef<HTMLDialogElement>(null)
  const identity = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    const el = frame.current!
    const opener = document.activeElement
    el.showModal()
    return () => {
      el.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  const { loaded, dialog, error } = usePreview()
  const account = useStore(s => s.me?.username)
  const revision = useViewing(s => s.revision)
  const files = useMemo(() => {
    void revision
    return account ? savedPreviews(account, where, owner.conn) : []
  }, [account, where, revision, owner])
  const app = loaded?.server === where ? loaded : null
  const shown = app && canView(app.target)
  const modal = shown && dialog && app.definition.dialogs.get(dialog)
  const previous = useRef(modal)
  useLayoutEffect(() => {
    if (previous.current && !modal) identity.current?.focus({ preventScroll: true })
    previous.current = modal
  }, [modal])

  const back = () => {
    if (app && modal) previewStep(app, { op: 'close' })
    else closePreview()
  }
  return (
    <dialog
      ref={frame}
      aria-labelledby="app-preview-title"
      onCancel={e => {
        e.preventDefault()
        back()
      }}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          back()
        }
      }}
      className="fixed inset-0 m-auto max-h-[85dvh] w-[min(32rem,calc(100%-2rem))] max-w-full flex-col overflow-hidden rounded-2xl bg-surface-container-high p-4 text-on-surface shadow-elevation-3 open:flex backdrop:bg-scrim/60 sm:p-6"
    >
      <div className="mb-3 flex shrink-0 items-center justify-between">
        <h2 id="app-preview-title" className="text-lg font-medium">
          App previews
        </h2>
        <CloseButton onClick={closePreview} />
      </div>
      {shown && (
        <section
          aria-label={`App: ${app.definition.name}`}
          className="mb-3 flex min-h-0 min-w-0 flex-col rounded-xl border border-outline-variant bg-surface-container-low p-4"
        >
          <h3
            ref={identity}
            tabIndex={-1}
            className="line-clamp-2 shrink-0 break-words font-medium"
          >
            <Masked text={app.definition.name} />
          </h3>
          <AppByline author={app.definition.author} />
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            <div hidden={!!modal}>
              <Parts node={app.definition.view} app={app} />
              {app.definition.actions.some(a => a.slash) && (
                <p className="mt-3 break-words text-sm text-on-surface-variant">
                  Chat actions:{' '}
                  {app.definition.actions
                    .filter(a => a.slash)
                    .map(a => '/' + a.slash)
                    .join(', ')}
                </p>
              )}
            </div>
            {modal && <AppDialog node={modal} app={app} />}
          </div>
        </section>
      )}
      {error && (
        <p role="alert" className="my-2 text-sm text-error">
          {error}
        </p>
      )}
      {account && files.some(f => f.revision !== app?.source.revision) && (
        <ul
          aria-label="Saved app definitions"
          className="mb-2 max-h-[18dvh] shrink-0 overflow-y-auto"
        >
          {files
            .filter(f => f.revision !== app?.source.revision)
            .map(f => (
              <li key={f.revision} className="flex min-w-0 items-center gap-2">
                <Button
                  size="md"
                  onClick={() =>
                    void launchPreview(where, savedSource(account, where, f, owner.conn))
                  }
                  place="min-w-0"
                >
                  <span className="truncate">Open {f.name}</span>
                </Button>
                <Button
                  size="md"
                  aria-label={'Forget approval for ' + f.name}
                  onClick={() => forgetSavedPreview(account, where, f)}
                >
                  Forget
                </Button>
              </li>
            ))}
        </ul>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {!shown && (
          <Button
            variant="filled"
            size="md"
            onClick={() => void launchPreview(where, app?.source ?? exampleSource)}
          >
            {app ? 'Open preview' : 'Open Field notes example'}
          </Button>
        )}
        <label
          className={`relative inline-flex items-center overflow-hidden ${buttonLook('text', 'md')}`}
        >
          Choose app definition
          <input
            aria-label="Choose app definition"
            type="file"
            accept=".json,application/json"
            className="absolute inset-0 w-full cursor-pointer opacity-0"
            onChange={e => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void launchPreview(where, fileSource(file))
            }}
          />
        </label>
        {app && (
          <Button size="md" onClick={forgetPreview}>
            Forget app approval
          </Button>
        )}
      </div>
    </dialog>
  )
}
