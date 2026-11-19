import { expect, test } from 'bun:test'
import { fold, searchRows, type SearchSection } from '../settings_search'

const sections: SearchSection[] = [
  { id: 'overview', label: 'Overview' },
  {
    id: 'features',
    label: 'Features',
    rows: [
      {
        section: 'features',
        group: 'Servers',
        id: 'server_joining',
        label: 'How people join servers',
        line: 'People who may not create one can still get in.',
        env: 'SERVER_JOINING',
      },
      {
        section: 'features',
        group: 'Servers',
        id: 'server_creation',
        label: 'Who can create servers',
        line: 'People can still join servers.',
        env: 'SERVER_CREATION',
      },
      {
        section: 'features',
        group: 'P2P',
        id: 'p2p',
        label: 'Peer-to-peer',
        line: 'Shows P2P in the app.',
        keywords: ['direct', 'serverless'],
        env: 'FEATURE_P2P',
      },
      {
        section: 'features',
        group: 'Accounts',
        id: 'registration',
        label: 'New accounts',
        line: 'Who can sign up.',
        keywords: ['café'],
        env: 'AUTH_REGISTRATION',
      },
    ],
  },
  {
    id: 'servers',
    label: 'Servers',
    rows: [{ section: 'servers', id: 'default_servers', label: 'Default servers' }],
  },
]

const ids = (q: string) => searchRows(sections, q).map(h => h.row.id)

test('folding drops case and accents', () => {
  expect(fold('Café ÀÉÎ')).toBe('cafe aei')
})

test('an empty query finds nothing', () => {
  expect(ids('')).toEqual([])
  expect(ids('   ')).toEqual([])
})

test('every word must match, in any order and any field', () => {
  expect(ids('join')).toEqual(['server_joining', 'server_creation'])
  expect(ids('servers join')).toEqual(['server_joining', 'server_creation'])
  expect(ids('join zebra')).toEqual([])
})

test('case and accents do not matter', () => {
  expect(ids('PEER')).toEqual(['p2p'])
  expect(ids('cafe')).toEqual(['registration'])
  expect(ids('CAFÉ')).toEqual(['registration'])
})

test('label hits come before group, keyword, line and env hits', () => {
  expect(ids('servers')).toEqual(['server_joining', 'server_creation', 'default_servers'])
  expect(ids('serverless')).toEqual(['p2p'])
  expect(ids('create')).toEqual(['server_creation', 'server_joining'])
})

test('env names match whole, in part and with spaces', () => {
  expect(ids('FEATURE_P2P')).toEqual(['p2p'])
  expect(ids('feature p2p')).toEqual(['p2p'])
  expect(ids('auth_reg')).toEqual(['registration'])
})

test('a hit names its section, group and label', () => {
  expect(searchRows(sections, 'creation')[0].trail).toEqual([
    'Features',
    'Servers',
    'Who can create servers',
  ])
  expect(searchRows(sections, 'default')[0].trail).toEqual(['Servers', 'Default servers'])
})

test('results stop at the limit', () => {
  expect(searchRows(sections, 's', 2)).toHaveLength(2)
})
