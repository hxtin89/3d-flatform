import { useEffect, useRef, type DependencyList } from 'react'
import type * as THREE from 'three'
import { onRebase } from '../../threejs-test/origin'

/** Subscribe to floating-origin rebases; the listener always sees the latest closure. */
export function useOnRebase(listener: (delta: THREE.Vector3) => void, deps: DependencyList = []): void {
  const latest = useRef(listener)
  latest.current = listener
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onRebase((delta) => latest.current(delta)), deps)
}
