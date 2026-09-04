import type * as THREE from 'three'
import type { RigMode } from '../state/ui-store'

/** Parcel-relative camera state. Azimuth 0 = camera south of the centre
 * looking north, counter-clockwise from above; elevation = pitch of the
 * position vector above the ground centroid; range in metres (log-space
 * inside the springs); lookHeightM lifts the look-at point off the ground. */
export interface RigState {
  azimuthDeg: number
  elevationDeg: number
  logRange: number
  lookHeightM: number
}

export interface CameraRig {
  mode(): RigMode
  /** Donor story: descend from the start pose into the endless orbit. */
  startStory(): void
  /** No story (?intro=0, reduced motion): spring straight to the orbit pose. */
  flyToOrbit(): void
  /** Dolly along the sight line toward an ENU point, keeping the heading. */
  flyToPoint(targetEnu: THREE.Vector3, endDistanceM: number): void
  /** Re-frame the parcel (style change). */
  refit(): void
  /** The user took the controls: freeze the springs where they are. */
  takeover(): void
  /** Blend from the user's view back into the orbit, velocity-continuous. */
  resume(): void
  /** Replay the story from t = 0 (scrubber). */
  replay(): void
}
