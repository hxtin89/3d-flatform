// Loads what the science-data preparation step wrote: index.json first, then the dataset
// files it names, resolved next to the index. The index is the one file that changes, so it
// is revalidated on every load; the dataset files carry their hash in the name and the
// browser may keep them as long as it likes.

import {
  SCIENCE_FORMAT,
  validateCollection,
  type DatasetId,
  type DatasetShapes,
  type ScienceIndex,
} from './science-data-format.ts'

export interface LoadedScienceData {
  index: ScienceIndex
  indexUrl: string
  collections: Partial<DatasetShapes>
}

export async function loadScienceData(
  indexUrl: string,
  datasets: readonly DatasetId[],
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedScienceData> {
  const base = new URL(indexUrl, globalThis.document?.baseURI)
  const response = await fetchImpl(base.href, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`science index ${base.href}: HTTP ${response.status}`)
  const index = await response.json() as ScienceIndex
  if (index.format !== SCIENCE_FORMAT) {
    throw new Error(`science index ${base.href}: format ${index.format}, this viewer reads ${SCIENCE_FORMAT}`)
  }

  const collections: Partial<DatasetShapes> = {}
  await Promise.all(datasets.map(async (dataset) => {
    const entry = index.datasets[dataset]
    if (!entry) return
    const url = new URL(entry.file, base).href
    const fileResponse = await fetchImpl(url)
    if (!fileResponse.ok) throw new Error(`science data ${url}: HTTP ${fileResponse.status}`)
    const collection = await fileResponse.json() as DatasetShapes[typeof dataset]
    // The preparation step refuses bad data; this catches a file edited or swapped by hand.
    const problems = validateCollection(dataset, collection)
    if (problems.length > 0) {
      console.warn(`[science-data] ${dataset}: ${problems.length} problem(s), not drawn`, problems.slice(0, 5))
      return
    }
    ;(collections as Record<DatasetId, unknown>)[dataset] = collection
  }))
  return { index, indexUrl: base.href, collections }
}
