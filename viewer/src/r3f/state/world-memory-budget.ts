export interface StreamMemoryBudget {
  cacheBytes: number
  gpuBytes: number
}

/** Active site gets 80%; each other ready stream shares the remaining 20%. */
export function allocateWorldMemoryBudget<T extends string>(
  total: StreamMemoryBudget,
  ids: readonly T[],
  activeId: T,
): Record<T, StreamMemoryBudget> {
  const backgroundCount = Math.max(0, ids.length - 1)
  const activeShare = backgroundCount ? 0.8 : 1
  const backgroundShare = backgroundCount ? (1 - activeShare) / backgroundCount : 0
  let cacheLeft = total.cacheBytes
  let gpuLeft = total.gpuBytes
  return ids.reduce((allocated, id, index) => {
    const share = id === activeId ? activeShare : backgroundShare
    const last = index === ids.length - 1
    const cacheBytes = last ? cacheLeft : Math.floor(total.cacheBytes * share)
    const gpuBytes = last ? gpuLeft : Math.floor(total.gpuBytes * share)
    cacheLeft -= cacheBytes
    gpuLeft -= gpuBytes
    allocated[id] = { cacheBytes, gpuBytes }
    return allocated
  }, {} as Record<T, StreamMemoryBudget>)
}
