'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, Copy, Plus, Send, TriangleAlert, X } from 'lucide-react'
import { useAccount } from '../lib/client/react'
import { useApiDoc, type ApiResponse } from '../lib/api_console'
import {
  buildRequest,
  emptyValue,
  emptyValues,
  hideSecrets,
  planSend,
  requestUrl,
  restoreValues,
  toCurl,
  valueAt,
  type BuiltRequest,
  type Errors,
  type Field,
  type FormValue,
  type Method,
  type Operation,
  type Values,
} from '../lib/openapi'
import { holdEscape } from '../lib/palette_store'
import { sharing } from '../lib/platform'
import { useStore } from '../lib/store'
import { CodeBlock } from './code_block'
import { SettingSwitch } from './settings_fields'
import { Button, Cover, IconButton } from './controls'
import { Grid, Inset, Row, Stack, Surface } from './layout'
import { useCopied } from './ui'
import { useInstanceLabel } from './instance_badge'
import { TO_SCREEN } from '../lib/secret'
import { time } from '../lib/platform/time'

const METHOD_CLS = {
  GET: 'bg-secondary-container text-on-secondary-container',
  POST: 'bg-primary-container text-on-primary-container',
  PUT: 'bg-tertiary-container text-on-tertiary-container',
  PATCH: 'bg-tertiary-container text-on-tertiary-container',
  DELETE: 'bg-error-container text-on-error-container',
} as const satisfies Record<Method, string>

export function MethodBadge({ method }: { method: Method }) {
  return (
    <Inset
      as="span"
      pad="xs"
      inset="chip"
      look={`rounded-md font-mono text-2xs font-semibold ${METHOD_CLS[method]}`}
      place="shrink-0"
    >
      {method}
    </Inset>
  )
}

const inputCls =
  'w-full min-w-0 rounded-lg border bg-transparent px-2.5 py-1.5 text-base outline-none placeholder:text-on-surface-variant/70 focus:border-primary md:text-sm'

const typeLabel = (f: Field): string => {
  switch (f.kind) {
    case 'array':
      return `${f.items ? typeLabel(f.items) : 'any'}[]`
    case 'enum':
      return 'choice'
    case 'json':
      return 'JSON'
    default:
      return f.format ? `${f.kind}, ${f.format}` : f.kind
  }
}

const firstLine = (s: string | null) => (s ? s.split(/\n\n/)[0].replace(/\s*\n\s*/g, ' ') : null)

const placeholderOf = (f: Field) => {
  const x = f.example ?? f.default
  if (x === undefined || x === null) return f.kind === 'json' ? '{ }' : ''
  return typeof x === 'string' ? x : JSON.stringify(x)
}

const LONG = /^(content|description|bio|topic|reason|question)$/

function FieldInput({
  field,
  value,
  path,
  errors,
  onChange,
  top = false,
}: {
  field: Field
  value: FormValue
  path: string
  errors: Errors
  onChange: (v: FormValue) => void
  top?: boolean
}) {
  const id = useId()
  const error = errors[path]
  const border = error ? 'border-error' : 'border-outline'
  const isNull = value === null
  const label = (
    <Row gap="sm" align="baseline" wrap>
      <label htmlFor={id} className="font-mono text-xs text-on-surface">
        {field.name}
        {field.required && <span className="text-error">*</span>}
      </label>
      <span className="text-2xs text-on-surface-variant">{typeLabel(field)}</span>
      {field.nullable && (
        <Row as="label" gap="2xs" place="ml-auto">
          <input
            type="checkbox"
            checked={isNull}
            onChange={e => onChange(e.target.checked ? null : emptyValue(field))}
          />
          <span className="text-2xs text-on-surface-variant">null</span>
        </Row>
      )}
    </Row>
  )
  const help = firstLine(field.description)
  const footer = (
    <>
      {help && <p className="text-2xs leading-snug text-on-surface-variant">{help}</p>}
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </>
  )
  let input: ReactNode = null
  if (!isNull) {
    if (field.kind === 'object') {
      const rec = typeof value === 'object' && value && !Array.isArray(value) ? value : {}
      const fields = (
        <Stack gap="md">
          {(field.fields ?? []).map(x => (
            <FieldInput
              key={x.name}
              field={x}
              value={valueAt(rec, x)}
              path={`${path}.${x.name}`}
              errors={errors}
              onChange={v => onChange({ ...rec, [x.name]: v })}
            />
          ))}
          {!field.fields?.length && <p className="text-xs text-on-surface-variant">No fields.</p>}
        </Stack>
      )
      input = top ? fields : <Nested>{fields}</Nested>
    } else if (field.kind === 'array') {
      const list = Array.isArray(value) ? value : []
      const item = field.items ?? { ...field, kind: 'json' as const }
      input = (
        <Nested>
          <Stack gap="sm">
            {list.map((v, i) => (
              <Row key={i} gap="2xs" align="start">
                <div className="min-w-0 flex-1">
                  <FieldInput
                    field={{ ...item, name: `${i + 1}`, required: true, description: null }}
                    value={v}
                    path={`${path}.${i}`}
                    errors={errors}
                    onChange={next => onChange(list.map((x, j) => (j === i ? next : x)))}
                  />
                </div>
                <IconButton
                  icon={X}
                  label="Remove item"
                  size="sm"
                  onClick={() => onChange(list.filter((_, j) => j !== i))}
                />
              </Row>
            ))}
            <Button
              icon={Plus}
              onClick={() => onChange([...list, emptyValue(item)])}
              place="self-start"
            >
              Add item
            </Button>
          </Stack>
        </Nested>
      )
    } else if (field.kind === 'boolean' || field.kind === 'enum') {
      const options = field.kind === 'boolean' ? ['true', 'false'] : (field.options ?? [])
      input = (
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={e => onChange(e.target.value)}
          aria-invalid={!!error}
          className={`${inputCls} ${border} bg-surface-container`}
        >
          <option value="">{field.required ? 'Pick one' : 'Not set'}</option>
          {options.map(o => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
    } else {
      const multi =
        field.kind === 'json' ||
        (field.kind === 'string' && (LONG.test(field.name) || (field.maxLength ?? 0) > 300))
      const common = {
        id,
        value: typeof value === 'string' ? value : '',
        placeholder: placeholderOf(field),
        'aria-invalid': !!error,
        spellCheck: false,
        autoComplete: 'off',
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
      }
      input = multi ? (
        <textarea
          {...common}
          rows={field.kind === 'json' ? 4 : 2}
          className={`${inputCls} ${border} resize-y ${field.kind === 'json' ? 'font-mono' : ''}`}
        />
      ) : (
        <input
          {...common}
          type={/password|secret|token/i.test(field.name) ? 'password' : 'text'}
          inputMode={
            field.kind === 'integer' ? 'numeric' : field.kind === 'number' ? 'decimal' : undefined
          }
          className={`${inputCls} ${border}`}
        />
      )
    }
  }
  return (
    <Stack gap="2xs">
      {!top && label}
      {input}
      {!top && footer}
      {top && error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </Stack>
  )
}

// A nested object or list: set in under a line along its left side.
function Nested({ children }: { children: ReactNode }) {
  return (
    <Inset pad="md" inset="sides" look="border-l-2 border-outline-variant">
      {children}
    </Inset>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack as="section" gap="md">
      <h3 className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
        {title}
      </h3>
      {children}
    </Stack>
  )
}

function ResponseView({ res }: { res: ApiResponse }) {
  const ok = res.status >= 200 && res.status < 300
  const streamer = useStore(s => s.streamer)
  const [shown, setShown] = useState<ApiResponse | null>(null)
  const covered = streamer && shown !== res
  return (
    <Stack as="section" aria-label="Response" gap="sm">
      <Row gap="sm" wrap>
        <Inset
          data-api-status={res.status}
          as="span"
          pad="sm"
          inset="chip"
          look={`rounded-md font-mono text-xs font-semibold ${ok ? 'bg-primary-container text-on-primary-container' : 'bg-error-container text-on-error-container'}`}
        >
          {res.status} {res.statusText}
        </Inset>
        <span className="text-xs text-on-surface-variant">{res.ms} ms</span>
        <span className="text-xs text-on-surface-variant">{res.size} bytes</span>
      </Row>
      {covered ? (
        <Cover data-streamer-cover onClick={() => setShown(res)}>
          Hidden in streamer mode. Show response
        </Cover>
      ) : (
        <ResponseBody res={res} />
      )}
    </Stack>
  )
}

function ResponseBody({ res }: { res: ApiResponse }) {
  return (
    <>
      <Surface pad="md" tone="base" radius="md">
        <details className="text-xs">
          <summary className="text-on-surface-variant">Headers ({res.headers.length})</summary>
          <Grid as="dl" cols="pair" gap="md" lineGap="2xs" look="font-mono">
            {res.headers.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-on-surface-variant">{k}</dt>
                <dd className="break-all text-on-surface">{v}</dd>
              </div>
            ))}
          </Grid>
        </details>
      </Surface>
      {res.text ? (
        <CodeBlock code={res.text} tag={res.json ? 'json' : 'plaintext'} />
      ) : (
        <p className="text-xs text-on-surface-variant">Empty body</p>
      )}
      {res.cut && (
        <p className="text-xs text-on-surface-variant">The response is too long to show in full.</p>
      )}
    </>
  )
}

function CurlButton({ op, values }: { op: Operation; values: Values }) {
  const { api, store } = useAccount()
  const guest = useStore(s => s.guest)
  const [withToken, setWithToken] = useState(false)
  const [copied, flash] = useCopied()
  const built = buildRequest(op, values, guest)
  const copy = () => {
    if (!built.ok) return
    // Secrets (the token, and secret path, query, header and body values) only when asked.
    const request = withToken ? built.request : hideSecrets(op, values, built.request)
    const url = requestUrl(new URL(api.base, window.location.href).href, request)
    if (!url) return
    const token = withToken ? (store.getState().token?.reveal(TO_SCREEN) ?? null) : null
    void sharing()
      .copyText(toCurl(url, request, token))
      .then(ok => (ok ? flash() : store.getState().setError('Could not copy to the clipboard')))
  }
  return (
    <Stack gap="sm">
      <Row gap="sm" wrap>
        <Button icon={copied ? Check : Copy} onClick={copy} disabled={!built.ok}>
          {copied ? 'Copied' : 'Copy as curl'}
        </Button>
        {!guest && (
          <div className="min-w-56 flex-1">
            <SettingSwitch
              label="Include my token and secrets"
              value={withToken}
              onChange={setWithToken}
            />
          </div>
        )}
      </Row>
      {withToken && (
        <Row as="p" role="alert" gap="xs" align="start">
          <TriangleAlert size={14} className="shrink-0 text-error" />
          <span className="text-xs text-error">
            Anyone with this command can act as you. Don&apos;t share it.
          </span>
        </Row>
      )}
    </Stack>
  )
}

export function ApiConsole({
  op,
  initial,
  onBack,
}: {
  op: Operation
  initial?: unknown
  onBack: () => void
}) {
  const account = useAccount()
  const { sessionMark } = account.lifetime
  const { sendRequest, noteRequest } = account.apiDoc
  const guest = useStore(s => s.guest)
  const [values, setRawValues] = useState<Values>(() =>
    initial && typeof initial === 'object' ? restoreValues(op, initial as Values) : emptyValues(op)
  )
  const [errors, setErrors] = useState<Errors>({})
  // The checked request waiting for "Send"; editing the form drops it.
  const [pending, setPending] = useState<BuiltRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<ApiResponse | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const blocked = op.multipart
  const groups: [string, typeof op.params][] = [
    ['Path', op.params.filter(p => p.in === 'path')],
    ['Query', op.params.filter(p => p.in === 'query')],
    ['Headers', op.params.filter(p => p.in === 'header')],
  ]

  useEffect(() => {
    if (!pending) return
    return holdEscape(() => setPending(null))
  }, [pending])

  const setValues = (next: Values | ((cur: Values) => Values)) => {
    setPending(null)
    setRawValues(next)
  }

  const setParam = (name: string, v: FormValue) =>
    setValues(cur => ({ ...cur, params: { ...cur.params, [name]: v } }))

  const send = async (request: BuiltRequest) => {
    setErrors({})
    setPending(null)
    setBusy(true)
    setFailure(null)
    const at = sessionMark()
    const note = (status: number) =>
      noteRequest(
        { op: op.id, method: op.method, path: op.path, status, at: time().now(), values },
        at
      )
    try {
      const out = await sendRequest(request)
      if (at !== sessionMark()) return
      setRes(out)
      note(out.status)
    } catch (e) {
      if (at !== sessionMark()) return
      setRes(null)
      setFailure(e instanceof Error ? e.message : "Can't reach the server")
      note(0)
    } finally {
      setBusy(false)
    }
  }

  const ask = () => {
    const plan = planSend(op, values, guest)
    setErrors(plan.kind === 'errors' ? plan.errors : {})
    if (plan.kind === 'confirm') setPending(plan.request)
    else if (plan.kind === 'send') void send(plan.request)
  }

  const danger = op.method === 'DELETE'

  return (
    <Stack gap="none" data-api-console place="min-h-0 flex-1">
      <Surface pad="md" inset="bar" tone="plain" radius="none" border="bottom" place="shrink-0">
        <Row gap="sm">
          <IconButton icon={ArrowLeft} label="Back to the list" size="lg" onClick={onBack} />
          <MethodBadge method={op.method} />
          <span className="min-w-0 truncate font-mono text-sm">{op.path}</span>
        </Row>
      </Surface>
      <Surface pad="lg" tone="plain" radius="none" place="min-h-0 flex-1 overflow-y-auto">
        <Stack gap="lg">
          <Stack gap="2xs">
            <h2 className="font-medium text-on-surface">{op.summary}</h2>
            {op.description && (
              <p className="text-xs whitespace-pre-line text-on-surface-variant">
                {op.description.replace(/([^\n])\n(?!\n)/g, '$1 ')}
              </p>
            )}
          </Stack>
          {groups.map(([title, list]) =>
            list.length ? (
              <Section key={title} title={title}>
                {list.map(p => (
                  <FieldInput
                    key={p.name}
                    field={p}
                    value={valueAt(values.params, p)}
                    path={`param.${p.name}`}
                    errors={errors}
                    onChange={v => setParam(p.name, v)}
                  />
                ))}
              </Section>
            ) : null
          )}
          {op.body && (
            <Section title={op.body.required ? 'Body (JSON)*' : 'Body (JSON)'}>
              <FieldInput
                field={op.body}
                value={values.body}
                path="body"
                errors={errors}
                onChange={v => setValues(cur => ({ ...cur, body: v }))}
                top
              />
            </Section>
          )}
          {op.multipart && (
            <p className="text-sm text-on-surface-variant">
              File uploads are not supported here. Use curl for this one.
            </p>
          )}
          {errors._ && (
            <p role="alert" className="text-sm text-error">
              {errors._}
            </p>
          )}
          {Object.keys(errors).length > 0 && !errors._ && (
            <p role="alert" className="text-sm text-error">
              Fix the highlighted fields first.
            </p>
          )}
          {pending ? (
            <div
              role="alertdialog"
              aria-label="Confirm request"
              data-api-confirm-box
              className={`rounded-xl border ${
                danger
                  ? 'border-error/50 bg-error-container/30'
                  : 'border-outline-variant bg-surface-container'
              }`}
            >
              <Surface pad="md" gap="md" tone="plain">
                <Row as="p" gap="sm">
                  <MethodBadge method={op.method} />
                  <span className="min-w-0 font-mono text-sm break-all">{op.path}</span>
                </Row>
                <p className="text-sm text-on-surface">
                  {danger
                    ? 'This deletes something on the server and may not be undone.'
                    : 'This changes something on the server.'}{' '}
                  Send it?
                </p>
                <Row gap="sm" justify="end">
                  <Button size="md" onClick={() => setPending(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant={danger ? 'filled-danger' : 'filled'}
                    size="md"
                    data-api-confirm
                    onClick={() => void send(pending)}
                  >
                    Send {op.method}
                  </Button>
                </Row>
              </Surface>
            </div>
          ) : (
            <Row gap="sm" justify="between" wrap>
              <Button variant="danger" onClick={() => setValues(emptyValues(op))}>
                Clear
              </Button>
              <Button
                variant="filled"
                size="md"
                icon={Send}
                data-api-send
                onClick={ask}
                disabled={busy || blocked}
              >
                {busy ? 'Sending' : 'Send'}
              </Button>
            </Row>
          )}
          <CurlButton op={op} values={values} />
          {failure && (
            <p role="alert" className="text-sm text-error">
              {failure}
            </p>
          )}
          {res && <ResponseView res={res} />}
        </Stack>
      </Surface>
    </Stack>
  )
}

export function ApiConsoleFor({
  opId,
  initial,
  onBack,
}: {
  opId: string
  initial?: unknown
  onBack: () => void
}) {
  const op = useApiDoc(s => s.ops?.find(o => o.id === opId) ?? null)
  const { label } = useInstanceLabel()
  if (!op)
    return (
      <Surface pad="lg" gap="sm" tone="plain" radius="none" align="start">
        <p className="text-sm text-on-surface-variant">
          That operation is not in the API of <span className="streamer">{label}</span>.
        </p>
        <Button onClick={onBack}>Back</Button>
      </Surface>
    )
  return <ApiConsole key={opId} op={op} initial={initial} onBack={onBack} />
}
