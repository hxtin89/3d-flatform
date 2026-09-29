import * as THREE from 'three'

/** How far a track may drift and still count as held: model units, or quaternion
 *  components. The parrot's held tracks drift by 3e-5 at most and its smallest real motion
 *  is 3.4e-2, so anything in between finds the same 108 of its 141. */
export const HELD_TRACK_TOLERANCE = 1e-4

/**
 * Tracks that hold one value through every clip that plays at once, and the same value in
 * each, are baked into their bone and dropped from the clips. Mixing such a track every
 * frame only writes back the value the bone already holds; the parrot's Flight and Glide
 * carry 141 tracks each, and 108 of them never move (they drift by at most 3e-5, where the
 * smallest real motion is 3.4e-2).
 *
 * `clips` must be every clip that plays on the rig, with weights that always add up to 1.
 * Below 1 the mixer blends the bone's own value in for the missing share, so a dropped
 * track would change the pose. A track that is missing from any clip, or moves in any, is
 * kept. Returns the clips in the same order, each with its original duration.
 */
export function bakeHeldTracks(
  root: THREE.Object3D,
  clips: readonly THREE.AnimationClip[],
  tolerance: number,
): THREE.AnimationClip[] {
  const [first, ...others] = clips
  const held = new Set<string>()
  for (const track of first.tracks) {
    // Values a key: 3 or 4 for a plain vector or quaternion track, three times that for a
    // cubic-spline one, whose keys carry in- and out-tangents around the value.
    const size = track.getValueSize()
    const peers = others.map((clip) => clip.tracks.find((peer) => peer.name === track.name))
    if (peers.some((peer) => !peer || peer.getValueSize() !== size)) continue
    const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name)
    const node = THREE.PropertyBinding.findNode(root, nodeName) as Record<string, any> | null
    const target = node?.[propertyName]
    // Only a key that is exactly the property's value can be written into it, which also
    // leaves cubic-spline tracks alone.
    if (typeof target?.fromArray !== 'function' || target.toArray().length !== size) continue
    const reference = track.values.slice(0, size)
    const quaternion = track instanceof THREE.QuaternionKeyframeTrack
    const all = [track, ...(peers as THREE.KeyframeTrack[])]
    if (!all.every((candidate) => holdsValue(candidate.values, reference, size, tolerance, quaternion))) continue
    target.fromArray(reference)
    held.add(track.name)
  }
  return clips.map((clip) => new THREE.AnimationClip(
    clip.name,
    clip.duration,
    clip.tracks.filter((track) => !held.has(track.name)),
    clip.blendMode,
  ))
}

function holdsValue(
  values: ArrayLike<number>,
  reference: ArrayLike<number>,
  size: number,
  tolerance: number,
  quaternion: boolean,
): boolean {
  for (let key = 0; key < values.length; key += size) {
    let same = true
    // q and -q are the same rotation.
    let flipped = quaternion
    for (let index = 0; index < size; index++) {
      if (Math.abs(values[key + index] - reference[index]) > tolerance) same = false
      if (flipped && Math.abs(values[key + index] + reference[index]) > tolerance) flipped = false
    }
    if (!same && !flipped) return false
  }
  return true
}
