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
import { Row, Stack, Surface } from './layout'
import { CloseButton, fieldCls, Masked, TopDialog } from './ui'

function Parts({ node, app }: { node: Node; app: LoadedPreview }): ReactNode {
  const { usePreview, previewStep } = previewFor(useAccount())
  const values = usePreview(s => s.values)
  const setField = (name: string, value: string) =>
    usePreview.setState(s => ({ values: { ...s.values, [name]: value } }))
  const children = (items: Node[]) => items.map((n, i) => <Parts key={i} node={n} app={app} />)
  switch (node.c) {
    case 'row':
    case 'stack':
      return node.c === 'stack' ? (
        <Stack gap="md">{children(node.children)}</Stack>
      ) : (
        <Row gap="md" wrap>
          {children(node.children)}
        </Row>
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
        <Stack as="label" gap="2xs">
          <Masked text={node.label ?? node.field} />
          {node.kind === 'multiline' ? <textarea {...props} rows={3} /> : <input {...props} />}
        </Stack>
      )
    }
    case 'form':
      return (
        <Stack
          as="form"
          gap="md"
          onSubmit={e => {
            e.preventDefault()
            if (node.on_done) previewStep(app, node.on_done)
          }}
        >
          {node.fields?.map(name => (
            <Stack key={name} as="label" gap="2xs">
              {name}
              <input
                className={fieldCls}
                maxLength={4096}
                value={values[name] ?? ''}
                onChange={e => setField(name, e.target.value)}
              />
            </Stack>
          ))}
          <Button type="submit" variant="filled" size="md">
            <Masked text={node.submit} />
          </Button>
        </Stack>
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
    <Surface
      ref={pane}
      role="dialog"
      aria-labelledby="authored-dialog-title"
      tabIndex={-1}
      pad="lg"
      gap="md"
      tone="highest"
      radius="lg"
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
    </Surface>
  )
}

// The host's line under an app's name. No signing key vouches for a local definition, so its
// author's name always shows as unverified.
export function AppByline({ author }: { author: string }) {
  return (
    <Row as="p" gap="sm" align="baseline" wrap place="shrink-0">
      <span className="line-clamp-2 min-w-0 break-words text-sm text-on-surface-variant">
        By <Masked text={author} />
      </span>
      <Surface
        data-app-unverified
        title="The author's name comes from the file and is not verified"
        as="span"
        pad="sm"
        inset="sides"
        tone="highest"
        radius="full"
        text="xs"
        look="font-medium"
        place="shrink-0"
      >
        Unverified
      </Surface>
    </Row>
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
  const identity = useRef<HTMLHeadingElement>(null)
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
    <TopDialog
      labelledBy="app-preview-title"
      wide
      onCancel={back}
      onKeyDown={e => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          back()
        }
      }}
    >
      <Stack gap="md" place="min-h-0">
        <Row gap="sm" justify="between" place="shrink-0">
          <h2 id="app-preview-title" className="text-lg font-medium">
            App previews
          </h2>
          <CloseButton onClick={closePreview} />
        </Row>
        {shown && (
          <Surface
            as="section"
            aria-label={`App: ${app.definition.name}`}
            pad="lg"
            gap="md"
            tone="low"
            radius="lg"
            border
            place="min-h-0"
          >
            <Stack gap="none" place="shrink-0">
              <h3 ref={identity} tabIndex={-1} className="line-clamp-2 break-words font-medium">
                <Masked text={app.definition.name} />
              </h3>
              <AppByline author={app.definition.author} />
            </Stack>
            <div className="min-h-0 overflow-y-auto overscroll-contain">
              <Stack hidden={!!modal} gap="md">
                <Parts node={app.definition.view} app={app} />
                {app.definition.actions.some(a => a.slash) && (
                  <p className="break-words text-sm text-on-surface-variant">
                    Chat actions:{' '}
                    {app.definition.actions
                      .filter(a => a.slash)
                      .map(a => '/' + a.slash)
                      .join(', ')}
                  </p>
                )}
              </Stack>
              {modal && <AppDialog node={modal} app={app} />}
            </div>
          </Surface>
        )}
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        {account && files.some(f => f.revision !== app?.source.revision) && (
          <ul aria-label="Saved app definitions" className="max-h-dvh-18 shrink-0 overflow-y-auto">
            {files
              .filter(f => f.revision !== app?.source.revision)
              .map(f => (
                <Row key={f.revision} as="li" gap="sm">
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
                </Row>
              ))}
          </ul>
        )}
        <Row gap="sm" wrap place="shrink-0">
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
        </Row>
      </Stack>
    </TopDialog>
  )
}
