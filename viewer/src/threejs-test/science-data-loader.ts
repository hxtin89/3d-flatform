// Reads what the science-data preparation step wrote: index.json first, then a dataset file
// when a layer first asks for it, resolved next to the index. The index is the one file
// that changes, so it is revalidated on every open; the dataset files carry their hash in
// the name and the browser may keep them as long as it likes. Every layer starts switched
// off, so a visitor who never opens one downloads nothing but the index.

import {
  SCIENCE_FORMAT,
  validateCollection,
  type DatasetId,
  type DatasetShapes,
  type ScienceIndex,
} from './science-data-format.ts'

export interface ScienceDataSource {
  readonly index: ScienceIndex
  readonly indexUrl: string
  /**
   * The dataset's features, fetched once and shared by every caller. Null when the index
   * has no such dataset or the file fails its checks; a failed download rejects and is
   * tried again on the next call.
   */
  load<D extends DatasetId>(dataset: D): Promise<DatasetShapes[D] | null>
}

export async function openScienceData(indexUrl: string, fetchImpl: typeof fetch = fetch): Promise<ScienceDataSource> {
  const base = new URL(indexUrl, globalThis.document?.baseURI)
  const response = await fetchImpl(base.href, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`science index ${base.href}: HTTP ${response.status}`)
  const index = await response.json() as ScienceIndex
  if (index.format !== SCIENCE_FORMAT) {
    throw new Error(`science index ${base.href}: format ${index.format}, this viewer reads ${SCIENCE_FORMAT}`)
  }

  const pending = new Map<DatasetId, Promise<unknown>>()
  async function fetchDataset(dataset: DatasetId): Promise<unknown> {
    const entry = index.datasets[dataset]
    if (!entry) return null
    const url = new URL(entry.file, base).href
    const fileResponse = await fetchImpl(url)
    if (!fileResponse.ok) throw new Error(`science data ${url}: HTTP ${fileResponse.status}`)
    const collection = await fileResponse.json() as DatasetShapes[typeof dataset]
    // The preparation step refuses bad data; this catches a file edited or swapped by hand.
    const problems = validateCollection(dataset, collection)
    if (problems.length > 0) {
      console.warn(`[science-data] ${dataset}: ${problems.length} problem(s), not drawn`, problems.slice(0, 5))
      return null
    }
    return collection
  }

  return {
    index,
    indexUrl: base.href,
    load(dataset) {
      let request = pending.get(dataset)
      if (!request) {
        request = fetchDataset(dataset)
        request.catch(() => pending.delete(dataset))
        pending.set(dataset, request)
      }
      return request as Promise<DatasetShapes[typeof dataset] | null>
    },
  }
}
