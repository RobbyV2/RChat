import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiConsole } from '../../components/api_console'
import { PaletteHost } from '../../components/palette'
import { PaletteSettingsSection } from '../../components/palette_settings'
import { closePalette, usePaletteUi } from '../palette_store'
import { parseOpenApi, type Operation } from '../openapi'
import { resetSessionCaches, useStore } from '../store'
import { me } from './fixtures'

// Server rendering reads the store's initial state, so the test state goes there.
const initial = useStore.getInitialState()
const saved = { ...initial }
const setState = (patch: Partial<typeof initial>) => {
  useStore.setState(patch)
  Object.assign(initial, useStore.getState())
}

const paletteInitial = usePaletteUi.getInitialState()
const paletteSaved = { ...paletteInitial }
const setPalette = (patch: Partial<typeof paletteInitial>) => {
  usePaletteUi.setState(patch)
  Object.assign(paletteInitial, usePaletteUi.getState())
}

afterAll(() => {
  Object.assign(initial, saved)
  Object.assign(paletteInitial, paletteSaved)
  resetSessionCaches()
})

const ops = parseOpenApi({
  paths: {
    '/api/messages/{id}': {
      delete: {
        operationId: 'delete_message',
        summary: 'Delete a message',
        description: 'Deletes it.\nFor good.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Message id',
            schema: { type: 'integer' },
          },
        ],
      },
    },
    '/api/me': {
      patch: {
        operationId: 'patch_me',
        summary: 'Update me',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  bio: { type: ['string', 'null'] },
                  avatar_kind: { type: 'string', enum: ['identicon', 'color'] },
                },
              },
            },
          },
        },
      },
    },
  },
})
const op = (id: string) => ops.find(o => o.id === id) as Operation

describe('api console markup', () => {
  afterEach(() => setState({ guest: false, me: null }))

  test('a form from the parameters and body, with send and copy as curl', () => {
    setState({ me: me('alice'), guest: false })
    const html = renderToStaticMarkup(<ApiConsole op={op('patch_me')} onBack={() => {}} />)
    expect(html).toContain('PATCH')
    expect(html).toContain('/api/me')
    expect(html).toContain('>bio<')
    expect(html).toContain('<option value="identicon">identicon</option>')
    expect(html).toContain('data-api-send')
    expect(html).toContain('Copy as curl')
    expect(html).toContain('Include my token and secrets')
    expect(html).toContain('title="Back to the list"')
  })
})

describe('palette markup', () => {
  afterEach(() => {
    closePalette()
    setPalette({ open: false, text: '', view: { kind: 'list' } })
    setState({ guest: false, me: null })
  })

  test('members get the API chip; guests get no chip and no console, even when asked', () => {
    setState({ me: me('alice'), guest: false })
    setPalette({ open: true, text: '/', view: { kind: 'list' } })
    expect(renderToStaticMarkup(<PaletteHost />)).toContain('title="API (/)"')
    setState({ me: null, guest: true })
    setPalette({ open: true, text: '/', view: { kind: 'api', op: 'delete_message' } })
    const html = renderToStaticMarkup(<PaletteHost />)
    expect(html).toContain('data-palette-input')
    expect(html.includes('title="API (/)"')).toBe(false)
    expect(html.includes('data-api-console')).toBe(false)
    expect(html.includes('Loading the API')).toBe(false)
  })
})

describe('palette settings markup', () => {
  test('three index modes for members, no Full for guests', () => {
    setState({ me: me('alice'), guest: false })
    const member = renderToStaticMarkup(<PaletteSettingsSection />)
    for (const label of ['Off', 'Loaded only', 'Full', 'Clear index', 'Size'])
      expect(member).toContain(label)
    setState({ me: null, guest: true })
    const guest = renderToStaticMarkup(<PaletteSettingsSection />)
    expect(guest.includes('>Full<')).toBe(false)
    expect(guest).toContain('Guests can index in memory only.')
  })
})
