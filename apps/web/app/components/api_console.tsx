'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, Copy, Plus, Send, TriangleAlert, X } from 'lucide-react'
import { api } from '../lib/instances'
import { noteRequest, sendRequest, useApiDoc, type ApiResponse } from '../lib/api_console'
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
import { SettingSwitch } from './admin_panel'
import { dangerBtn, filledBtn, filledDangerBtn, iconBtn, textBtn, useCopied } from './ui'

const METHOD_CLS: Record<Method, string> = {
  GET: 'bg-secondary-container text-on-secondary-container',
  POST: 'bg-primary-container text-on-primary-container',
  PUT: 'bg-tertiary-container text-on-tertiary-container',
  PATCH: 'bg-tertiary-container text-on-tertiary-container',
  DELETE: 'bg-error-container text-on-error-container',
}

export function MethodBadge({ method }: { method: Method }) {
  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold ${METHOD_CLS[method]}`}
    >
      {method}
    </span>
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
    <div className="flex flex-wrap items-baseline gap-x-2">
      <label htmlFor={id} className="font-mono text-xs text-on-surface">
        {field.name}
        {field.required && <span className="text-error">*</span>}
      </label>
      <span className="text-[11px] text-on-surface-variant">{typeLabel(field)}</span>
      {field.nullable && (
        <label className="ml-auto flex items-center gap-1 text-[11px] text-on-surface-variant">
          <input
            type="checkbox"
            checked={isNull}
            onChange={e => onChange(e.target.checked ? null : emptyValue(field))}
          />
          null
        </label>
      )}
    </div>
  )
  const help = firstLine(field.description)
  const footer = (
    <>
      {help && <p className="text-[11px] leading-snug text-on-surface-variant">{help}</p>}
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
      input = (
        <div
          className={`flex flex-col gap-3 ${top ? '' : 'border-l-2 border-outline-variant pl-3'}`}
        >
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
        </div>
      )
    } else if (field.kind === 'array') {
      const list = Array.isArray(value) ? value : []
      const item = field.items ?? { ...field, kind: 'json' as const }
      input = (
        <div className="flex flex-col gap-2 border-l-2 border-outline-variant pl-3">
          {list.map((v, i) => (
            <div key={i} className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <FieldInput
                  field={{ ...item, name: `${i + 1}`, required: true, description: null }}
                  value={v}
                  path={`${path}.${i}`}
                  errors={errors}
                  onChange={next => onChange(list.map((x, j) => (j === i ? next : x)))}
                />
              </div>
              <button
                type="button"
                title="Remove item"
                aria-label="Remove item"
                onClick={() => onChange(list.filter((_, j) => j !== i))}
                className={iconBtn}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onChange([...list, emptyValue(item)])}
            className={`${textBtn} flex items-center gap-1 self-start`}
          >
            <Plus size={14} /> Add item
          </button>
        </div>
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
    <div className="flex flex-col gap-1">
      {!top && label}
      {input}
      {!top && footer}
      {top && error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function ResponseView({ res }: { res: ApiResponse }) {
  const ok = res.status >= 200 && res.status < 300
  return (
    <section aria-label="Response" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          data-api-status={res.status}
          className={`rounded-md px-2 py-0.5 font-mono text-xs font-semibold ${
            ok
              ? 'bg-primary-container text-on-primary-container'
              : 'bg-error-container text-on-error-container'
          }`}
        >
          {res.status} {res.statusText}
        </span>
        <span className="text-xs text-on-surface-variant">{res.ms} ms</span>
        <span className="text-xs text-on-surface-variant">{res.size} bytes</span>
      </div>
      <details className="rounded-lg bg-surface-container px-3 py-2 text-xs">
        <summary className="cursor-pointer text-on-surface-variant">
          Headers ({res.headers.length})
        </summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono">
          {res.headers.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-on-surface-variant">{k}</dt>
              <dd className="break-all text-on-surface">{v}</dd>
            </div>
          ))}
        </dl>
      </details>
      {res.text ? (
        <CodeBlock code={res.text} tag={res.json ? 'json' : 'plaintext'} />
      ) : (
        <p className="text-xs text-on-surface-variant">Empty body</p>
      )}
      {res.cut && (
        <p className="text-xs text-on-surface-variant">The response is too long to show in full.</p>
      )}
    </section>
  )
}

function CurlButton({ op, values }: { op: Operation; values: Values }) {
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
    const token = withToken ? useStore.getState().token : null
    void sharing()
      .copyText(toCurl(url, request, token))
      .then(ok => (ok ? flash() : useStore.getState().setError('Could not copy to the clipboard')))
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={copy}
          disabled={!built.ok}
          className={`${textBtn} flex items-center gap-1.5 disabled:opacity-40`}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy as curl'}
        </button>
        {!guest && (
          <div className="min-w-56 flex-1">
            <SettingSwitch
              label="Include my token and secrets"
              value={withToken}
              onChange={setWithToken}
            />
          </div>
        )}
      </div>
      {withToken && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-error">
          <TriangleAlert size={14} className="mt-px shrink-0" />
          Anyone with this command can act as you. Don&apos;t share it.
        </p>
      )}
    </div>
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
    const note = (status: number) =>
      noteRequest({ op: op.id, method: op.method, path: op.path, status, at: Date.now(), values })
    try {
      const out = await sendRequest(request)
      setRes(out)
      note(out.status)
    } catch (e) {
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
    <div data-api-console className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
        <button
          type="button"
          title="Back to the list"
          aria-label="Back to the list"
          onClick={onBack}
          className={iconBtn}
        >
          <ArrowLeft size={18} />
        </button>
        <MethodBadge method={op.method} />
        <span className="min-w-0 truncate font-mono text-sm">{op.path}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-5">
          <div>
            <h2 className="font-medium text-on-surface">{op.summary}</h2>
            {op.description && (
              <p className="mt-1 text-xs whitespace-pre-line text-on-surface-variant">
                {op.description.replace(/([^\n])\n(?!\n)/g, '$1 ')}
              </p>
            )}
          </div>
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
              className={`flex flex-col gap-3 rounded-xl border p-3 ${
                danger
                  ? 'border-error/50 bg-error-container/30'
                  : 'border-outline-variant bg-surface-container'
              }`}
            >
              <p className="flex min-w-0 items-center gap-2">
                <MethodBadge method={op.method} />
                <span className="min-w-0 font-mono text-sm break-all">{op.path}</span>
              </p>
              <p className="text-sm text-on-surface">
                {danger
                  ? 'This deletes something on the server and may not be undone.'
                  : 'This changes something on the server.'}{' '}
                Send it?
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setPending(null)} className={textBtn}>
                  Cancel
                </button>
                <button
                  type="button"
                  data-api-confirm
                  onClick={() => void send(pending)}
                  className={danger ? filledDangerBtn : filledBtn}
                >
                  Send {op.method}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setValues(emptyValues(op))}
                className={dangerBtn}
              >
                Clear
              </button>
              <button
                type="button"
                data-api-send
                onClick={ask}
                disabled={busy || blocked}
                className={`${filledBtn} flex items-center gap-1.5`}
              >
                <Send size={14} />
                {busy ? 'Sending' : 'Send'}
              </button>
            </div>
          )}
          <CurlButton op={op} values={values} />
          {failure && (
            <p role="alert" className="text-sm text-error">
              {failure}
            </p>
          )}
          {res && <ResponseView res={res} />}
        </div>
      </div>
    </div>
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
  if (!op)
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-sm text-on-surface-variant">
        <p>That operation is not in this instance&apos;s API.</p>
        <button type="button" onClick={onBack} className={textBtn}>
          Back
        </button>
      </div>
    )
  return <ApiConsole key={opId} op={op} initial={initial} onBack={onBack} />
}
