import { AVATAR_IMAGES, type AvatarCrop } from './avatar_images'
import { moduleAt, rulesBase } from './perms_load'

// Profile pictures made on this device, for a P2P identity: the shared module makes the same
// files an instance makes for an upload.
interface Made {
  mime: string
  file(at: number): Uint8Array
  free(): void
}

export interface PictureModule {
  picture_files(bytes: Uint8Array, x: number, y: number, size: number): Made
}

// What the module refuses, in the words the editor shows.
export const PICTURE_REFUSALS: Record<string, string> = {
  not_image: "Couldn't read that image",
  too_large: 'The picture has too many pixels',
  crop: 'Choose a larger part of the picture',
}

export const NO_PICTURE_MODULE = 'Not available on this device'

let loaded: Promise<PictureModule> | null = null

// The shared module, loaded once; a failed load is tried again on the next call.
export const loadPictureModule = (from = rulesBase()): Promise<PictureModule> => {
  loaded ??= (moduleAt(from)() as unknown as Promise<PictureModule>).catch(e => {
    loaded = null
    throw e
  })
  return loaded
}

// The files of the picture `crop` of `file` shows, one per size in `AVATAR_IMAGES.sizes`, or
// the text of why there is none.
export async function pictureFiles(
  file: Blob,
  crop: AvatarCrop,
  load: () => Promise<PictureModule> = loadPictureModule
): Promise<{ files: Blob[] } | { error: string }> {
  let module: PictureModule
  try {
    module = await load()
  } catch {
    return { error: NO_PICTURE_MODULE }
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  try {
    const made = module.picture_files(bytes, crop.x, crop.y, crop.size)
    const type = made.mime
    const files = AVATAR_IMAGES.sizes.map(
      (_, at) => new Blob([new Uint8Array(made.file(at))], { type })
    )
    made.free()
    return { files }
  } catch (e) {
    const word = e instanceof Error ? e.message : ''
    return { error: PICTURE_REFUSALS[word] ?? PICTURE_REFUSALS.not_image }
  }
}
