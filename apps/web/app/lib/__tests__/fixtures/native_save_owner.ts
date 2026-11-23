import assert from 'node:assert/strict'

const ipc = { started: Promise.withResolvers<void>(), request: Promise.withResolvers<void>() }
Object.assign(globalThis, {
  window: {
    location: new URL('https://shown.test'),
    __RCHAT_DESKTOP__: { os: 'linux', version: '1' },
    __TAURI_INTERNALS__: {
      invoke: (command: string) => {
        assert.equal(command, 'save_begin')
        ipc.started.resolve()
        return ipc.request.promise
      },
    },
  },
})

// Shell detection happens when the platform adapters load.
const { testAccount } = await import('../test_account')
const { client } = await import('../../client/client')
const { SAVE_FAILED } = await import('../../platform/desktop_sharing')
const owner = testAccount('reader', 'https://owner.test')
const shown = testAccount('reader', 'https://shown.test')
const failures: string[] = []
owner.store.setState({ setError: message => failures.push('owner ' + message) })
shown.store.setState({ setError: message => failures.push('shown ' + message) })
client.shown = () => shown
owner.api.mediaBlob = async () => new Blob(['file'])
try {
  for (const ended of [false, true]) {
    ipc.started = Promise.withResolvers<void>()
    ipc.request = Promise.withResolvers<void>()
    await owner.media.saveMedia('1', undefined, 'file.txt')
    await ipc.started.promise
    if (ended) owner.lifetime.endSession()
    ipc.request.reject(new Error('Disk write failed'))
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(failures, ['owner ' + SAVE_FAILED])
  }
} finally {
  owner.store.dispose()
  shown.store.dispose()
}
