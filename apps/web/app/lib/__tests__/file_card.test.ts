import { beforeEach, describe, expect, test } from 'bun:test'
import {
  cardMenu,
  expiryLabel,
  expiryTitle,
  fileKind,
  fileTarget,
  pct,
  splitName,
  splitShown,
  type FileMenu,
} from '../file_card'
import { downloadName } from '../sniff'

beforeEach(() => {
  process.env.TZ = 'America/New_York'
})

describe('fileKind', () => {
  test('the extension picks the kind', () => {
    const table: [string, string][] = [
      ['Mandy Save.zip', 'archive'],
      ['backup.tar.gz', 'archive'],
      ['disk.iso', 'archive'],
      ['report.pdf', 'document'],
      ['letter.docx', 'document'],
      ['book.epub', 'document'],
      ['sheet.xlsx', 'spreadsheet'],
      ['data.csv', 'spreadsheet'],
      ['data.tsv', 'spreadsheet'],
      ['deck.pptx', 'slides'],
      ['talk.key', 'slides'],
      ['song.mp3', 'audio'],
      ['voice.opus', 'audio'],
      ['tune.mid', 'audio'],
      ['clip.mp4', 'video'],
      ['clip.mkv', 'video'],
      ['photo.jpeg', 'image'],
      ['logo.svg', 'image'],
      ['scan.tiff', 'image'],
      ['notes.txt', 'text'],
      ['README.md', 'text'],
      ['server.log', 'text'],
      ['app.conf', 'text'],
      ['main.rs', 'code'],
      ['index.ts', 'code'],
      ['data.json', 'code'],
      ['config.yml', 'code'],
      ['Cargo.toml', 'code'],
      ['page.html', 'code'],
      ['run.sh', 'code'],
      ['Dockerfile', 'code'],
      ['LICENSE', 'text'],
      ['mystery.qqq', 'generic'],
      ['noext', 'generic'],
    ]
    expect(table.map(([name]) => [name, fileKind(name, null)])).toEqual(table)
  })

  test('uppercase extensions count the same', () => {
    expect(fileKind('ARCHIVE.ZIP', null)).toBe('archive')
    expect(fileKind('Photo.JPG', null)).toBe('image')
    expect(fileKind('Main.RS', null)).toBe('code')
  })

  test('a known extension wins over the mime type', () => {
    expect(fileKind('song.mp3', 'application/pdf')).toBe('audio')
    expect(fileKind('data.csv', 'text/plain')).toBe('spreadsheet')
  })

  test('the mime type decides when the extension is unknown', () => {
    expect(fileKind('blob', 'image/png')).toBe('image')
    expect(fileKind('blob.bin', 'audio/ogg')).toBe('audio')
    expect(fileKind('blob', 'video/webm')).toBe('video')
    expect(fileKind('blob', 'application/pdf')).toBe('document')
    expect(fileKind('blob', 'application/zip')).toBe('archive')
    expect(fileKind('blob', 'text/csv; charset=utf-8')).toBe('spreadsheet')
    expect(fileKind('blob', 'application/vnd.ms-powerpoint')).toBe('slides')
    expect(fileKind('blob', 'application/json')).toBe('code')
    expect(fileKind('blob', 'TEXT/PLAIN')).toBe('text')
    expect(fileKind('blob', 'application/x-unknown')).toBe('generic')
  })

  test('application/octet-stream says nothing', () => {
    expect(fileKind('blob', 'application/octet-stream')).toBe('generic')
    expect(fileKind('blob', 'application/octet-stream; x=1')).toBe('generic')
    expect(fileKind('blob.zip', 'application/octet-stream')).toBe('archive')
  })
})

describe('splitName', () => {
  test('the last extension, with its dot and case', () => {
    expect(splitName('Mandy Save.zip')).toEqual({ base: 'Mandy Save', ext: '.zip' })
    expect(splitName('a.b.c')).toEqual({ base: 'a.b', ext: '.c' })
    expect(splitName('Photo.JPG')).toEqual({ base: 'Photo', ext: '.JPG' })
    expect(splitName('x.abcdefghij')).toEqual({ base: 'x', ext: '.abcdefghij' })
  })

  test('tar archives keep both extensions', () => {
    expect(splitName('backup.tar.gz')).toEqual({ base: 'backup', ext: '.tar.gz' })
    expect(splitName('backup.TAR.ZST')).toEqual({ base: 'backup', ext: '.TAR.ZST' })
    expect(splitName('a.tar.bz2')).toEqual({ base: 'a', ext: '.tar.bz2' })
    expect(splitName('a.tar.xz')).toEqual({ base: 'a', ext: '.tar.xz' })
  })

  test('no extension for dotfiles, a trailing dot, only an extension or a long one', () => {
    for (const name of ['.env', 'name.', '.zip', '.tar.gz', 'x.abcdefghijk', 'noext', 'a.ü', ''])
      expect(splitName(name)).toEqual({ base: name, ext: '' })
  })

  test('names cleaned for saving split the same way', () => {
    expect(splitName(downloadName('../evil‮gpj.exe'))).toEqual({
      base: '_evil_gpj',
      ext: '.exe',
    })
    expect(splitName(downloadName('  report.pdf. '))).toEqual({ base: 'report', ext: '.pdf' })
    expect(splitName(downloadName('...'))).toEqual({ base: 'download', ext: '' })
  })

  test('the shown name is cut where the raw one is', () => {
    expect(splitShown('shit.zip', '****.zip')).toEqual(['shit', '****', '.zip', '.zip'])
    expect(splitShown('bad.ts', '***.**')).toEqual(['bad', '***', '.ts', '.**'])
    expect(splitShown('é😀x.png', 'é😀*.png')).toEqual(['é😀x', 'é😀*', '.png', '.png'])
    expect(splitShown('a.zip', '***')).toEqual(['a.zip', '***', '', ''])
  })
})

describe('expiryLabel', () => {
  const now = Date.UTC(2026, 10, 26, 12) / 1000

  test('none for a file that does not expire', () => {
    expect(expiryLabel(null, now)).toBeNull()
  })

  test('past and now are expired', () => {
    expect(expiryLabel(now - 1, now)).toBe('Expired')
    expect(expiryLabel(now, now)).toBe('Expired')
  })

  test('under a day stays relative', () => {
    expect(expiryLabel(now + 5 * 3600, now)).toBe('Expires in 5 hours')
    expect(expiryLabel(now + 90, now)).toBe('Expires in 2 minutes')
  })

  test('a day or more gives the local date', () => {
    expect(expiryLabel(now + 86_400, now, 'en-US')).toBe('Expires on Nov 27, 2026')
    const far = Date.UTC(2029, 10, 25, 15) / 1000
    expect(expiryLabel(far, now, 'en-US')).toBe('Expires on Nov 25, 2029')
    const lateUtc = Date.UTC(2029, 10, 26, 2) / 1000
    expect(expiryLabel(lateUtc, now, 'en-US')).toBe('Expires on Nov 25, 2029')
  })

  test('the title is the full local date and time', () => {
    const at = Date.UTC(2029, 10, 25, 15, 30) / 1000
    const title = expiryTitle(at, 'en-US')
    for (const part of ['Sunday', 'November 25, 2029', '10:30']) expect(title).toContain(part)
  })
})

test('download progress in whole percent', () => {
  expect(pct({ got: 42, total: 100 })).toBe(42)
  expect(pct({ got: 999, total: 1000 })).toBe(99)
  expect(pct({ got: 5, total: 0 })).toBe(0)
  expect(pct({ got: 200, total: 100 })).toBe(100)
  expect(pct(undefined)).toBe(0)
})

describe('cardMenu', () => {
  const download = () => {}
  const cancel = () => {}
  const image = { kind: 'image' as const, run: () => {} }
  const idle = {
    primary: { label: 'Download' as const },
    progress: null,
    onCancel: cancel,
    extra: [image],
    menu: { download, link: 'https://x.example/m' },
  }

  test('an idle card offers its download, its other buttons and its link', () => {
    expect(cardMenu('****.zip', idle)).toEqual({
      name: '****.zip',
      verb: 'Download',
      download,
      cancel: null,
      extra: [image],
      link: 'https://x.example/m',
      remove: null,
    })
  })

  test('a file its viewer may take off the message offers that too', () => {
    const remove = () => {}
    expect(cardMenu('a.zip', { ...idle, menu: { ...idle.menu, remove } }).remove).toBe(remove)
    expect(cardMenu('a.zip', idle).remove).toBeNull()
  })

  test('while a download runs, Cancel takes its place and the other buttons go', () => {
    const m = cardMenu('a.zip', { ...idle, progress: { got: 1, total: 2 } })
    expect([m.download, m.cancel, m.extra]).toEqual([null, cancel, []])
  })

  test('a running fetch without a way to stop it keeps the download', () => {
    const m = cardMenu('a.zip', { ...idle, progress: { got: 1, total: 2 }, onCancel: undefined })
    expect([m.download, m.cancel, m.extra]).toEqual([download, null, []])
  })

  test('a P2P file on the device is saved, with no link', () => {
    const m = cardMenu('clip.mp4', {
      primary: { label: 'Save' },
      progress: null,
      menu: { download, link: null },
    })
    expect([m.verb, m.download, m.extra, m.link]).toEqual(['Save', download, [], null])
  })
})

test("a card's menu target reads the card each time, and none once it is gone", () => {
  let card: FileMenu | null = cardMenu('a.zip', {
    primary: { label: 'Download' },
    progress: null,
    menu: { download: null, link: null },
  })
  const first = card
  const t = fileTarget(() => card)
  expect(t.kind === 'file' && t.now()).toBe(first)
  card = { ...first, verb: 'Save' }
  expect(t.kind === 'file' && t.now()?.verb).toBe('Save')
  card = null
  expect(t.kind === 'file' && t.now()).toBeNull()
})
