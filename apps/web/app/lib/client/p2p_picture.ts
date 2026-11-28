'use client'

import { useEffect, useMemo, useState } from 'react'
import { picturesShown, type AvatarView } from '../avatar_setting'
import { parsePic, stillFor, type P2pFile, type P2pPic } from '../p2p/pictures'
import { useP2p, useP2pApp } from './p2p_react'
import type { AvatarCrop } from '../avatar_images'
import { limitsOf } from '../instance_limits'
import { P2P_NOT_RUNNING, keptPic } from '../p2p/app/pictures'
import type { PictureScope } from '../p2p/picture_gate'
import { pictureFiles } from '../picture_files'
import { useStore } from '../store'

// The address of a P2P picture file once it is on this device; null until then. A file that
// is not here is asked of who may hold it.
function useP2pFileUrl(file: P2pFile | null): string | null {
  const identity = useP2pApp()
  const h = file?.h ?? null
  const bytes = file?.size ?? 0
  const state = useP2p(s => (h ? s.files[h]?.state : undefined))
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (identity && h) identity.p2pFiles.watch({ h, size: bytes })
  }, [identity, h, bytes])
  useEffect(() => {
    if (identity && h && state === 'none') void identity.p2pFiles.fetchPicture({ h, size: bytes })
  }, [identity, h, bytes, state])
  useEffect(() => {
    if (!identity || !h || state !== 'done') return setUrl(null)
    let live = true
    void identity.p2pFiles.pictureUrl(h).then(made => live && setUrl(made))
    return () => {
      live = false
      identity.p2pFiles.unusePicture(h)
    }
  }, [identity, h, state])
  return h ? url : null
}

// The address of the picture this device draws for the P2P identity `ik` at `size` CSS pixels;
// null while it draws none. `placed` is the picture a room settled for them (null: none);
// without it the picture of their identity shows: our own, or the one a contact sent.
export function useP2pPicture(
  ik: string,
  placed: P2pPic | null | undefined,
  size: number,
  view: AvatarView
): string | null {
  const pic = useP2pPic(ik, placed)
  return useP2pFileUrl(pic && picturesShown(view) ? stillFor(pic, size) : null)
}

// The address of a P2P server's picture for its icon; null while this device draws none.
export function useP2pServerPicture(pic: P2pPic | null | undefined, view: AvatarView) {
  return useP2pFileUrl(pic && picturesShown(view) ? pic.s : null)
}

// The picture this device draws for the identity `ik`, as `useP2pPicture` settles it.
export function useP2pPic(ik: string, placed: P2pPic | null | undefined): P2pPic | null {
  const own = useP2p(s => (s.ik === ik ? s.pic : null))
  const sent = useP2p(s => s.contacts.find(c => c.ik === ik)?.pic)
  const theirs = useMemo(() => parsePic(sent) ?? null, [sent])
  return placed !== undefined ? placed : (own ?? theirs)
}

// Whether the P2P picture `pic` has an animation this device may play.
export function useP2pAnimated(pic: P2pPic | null | undefined, view: AvatarView) {
  const kept = useStore(s => s.settings.animated_profile_pictures)
  return !!pic?.a && kept && picturesShown(view)
}

// The address of the animation of a P2P picture while it `plays`; its file is asked for only
// then, and null comes back until it is here.
export function useP2pAnimation(pic: P2pPic | null | undefined, plays: boolean) {
  return useP2pFileUrl(plays && pic?.a ? pic.a : null)
}

// What the P2P picture editors share: whether a picture can be made here now, the most bytes of
// a source file, and making one from the chosen square of a file for the picture `scope` names.
export function useP2pPictureMaker() {
  const identity = useP2pApp()
  const served = useStore(s => s.settings.profile_pictures)
  const maxBytes = useStore(s => limitsOf(s.instance).avatar_upload_bytes)
  const animated = useStore(s => s.settings.animated_profile_pictures)
  const make = async (
    file: Blob,
    crop: AvatarCrop,
    scope: PictureScope
  ): Promise<P2pPic | string> =>
    identity
      ? keptPic(identity.p2pFiles, await pictureFiles(file, crop, animated), scope)
      : P2P_NOT_RUNNING
  return { off: served ? null : 'Profile pictures are turned off on this site', maxBytes, make }
}
