// Science data preparation step: reads the source, checks it, and writes versioned GeoJSON
// files plus index.json for the viewer (format: src/threejs-test/science-data-format.ts).
// Meant to run nightly and on demand; once the project's CMS exists it also runs on publish.
//
//   npm run science:prepare                       # Directus → public/science-data/
//   npm run science:prepare -- --dry-run          # read and check, write nothing
//   npm run science:prepare -- --out <dir>        # another output folder
//   npm run science:prepare -- --allow-shrink     # accept a dataset losing > 20 % of its features
//   npm run science:prepare -- --directus-url <url>
//
// When a check fails it writes nothing and exits with 1, so the last good set stays live.
// When nothing changed it writes nothing either: same content, same file names, same index.
// Order of writes: the new dataset files (new names, nothing overwritten), then index.json
// through a temporary file and a rename, then the pruning of files no index entry remembers.

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DATASET_FILE_PATTERN,
  DATASET_IDS,
  SCIENCE_FORMAT,
  bboxOf,
  datasetFileName,
  nextEntry,
  referencedFiles,
  shrinkProblem,
  unionBbox,
  validateCollection,
  type DatasetEntry,
  type DatasetId,
  type ScienceIndex,
} from '../../src/threejs-test/science-data-format.ts'
import { DIRECTUS_URL, readDirectus } from './directus-source.ts'

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'public/science-data' },
    'dry-run': { type: 'boolean', default: false },
    'allow-shrink': { type: 'boolean', default: false },
    'directus-url': { type: 'string', default: DIRECTUS_URL },
  },
})

const outDir = resolve(args.out!)
const indexPath = join(outDir, 'index.json')

/** One feature per line: readable diffs, and the hash still covers every byte. */
function serialise(collection: { type: string; features: unknown[] }): string {
  const lines = collection.features.map(f => JSON.stringify(f))
  return `{"type":"FeatureCollection","features":[\n${lines.join(',\n')}\n]}\n`
}

async function readPreviousIndex(): Promise<ScienceIndex | null> {
  if (!existsSync(indexPath)) return null
  const index = JSON.parse(await readFile(indexPath, 'utf8')) as ScienceIndex
  if (index.format !== SCIENCE_FORMAT) throw new Error(`${indexPath}: format ${index.format}, this step writes ${SCIENCE_FORMAT}`)
  return index
}

async function main(): Promise<number> {
  const previous = await readPreviousIndex()
  const result = await readDirectus(args['directus-url'])

  const problems: string[] = []
  const prepared: Array<{ dataset: DatasetId; text: string; next: Parameters<typeof nextEntry>[1] }> = []
  for (const dataset of DATASET_IDS) {
    const collection = result.collections[dataset]
    problems.push(...validateCollection(dataset, collection))
    const shrink = shrinkProblem(dataset, previous?.datasets[dataset]?.featureCount, collection.features.length)
    if (shrink && !args['allow-shrink']) problems.push(shrink)
    const text = serialise(collection)
    const version = createHash('sha256').update(text).digest('hex').slice(0, 16)
    prepared.push({
      dataset,
      text,
      next: {
        file: datasetFileName(dataset, version),
        version,
        featureCount: collection.features.length,
        bytes: Buffer.byteLength(text),
        bbox: unionBbox(collection.features.map(f => bboxOf(f.geometry))),
      },
    })
  }

  for (const d of result.dropped) console.log(`dropped  ${d.dataset} ${d.id} "${d.name}": ${d.reason}`)
  if (problems.length > 0) {
    for (const p of problems) console.error(`refused  ${p}`)
    console.error(`\n${problems.length} problem(s). Nothing written; ${previous ? 'the last good set stays live' : 'there is no earlier set'}.`)
    return 1
  }

  const now = new Date().toISOString()
  const datasets: Partial<Record<DatasetId, DatasetEntry>> = {}
  let changed = previous === null || previous.source.url !== result.source.url
  for (const { dataset, next } of prepared) {
    const before = previous?.datasets[dataset]
    datasets[dataset] = nextEntry(before, next, now)
    const same = before?.version === next.version
    if (!same) changed = true
    console.log(`${same ? 'same    ' : 'new     '} ${dataset}: ${next.featureCount} features, ${(next.bytes / 1024).toFixed(1)} KiB, ${next.file}`)
  }

  if (!changed) {
    console.log('\nNothing changed. Nothing written.')
    return 0
  }
  if (args['dry-run']) {
    console.log('\nDry run. Nothing written.')
    return 0
  }

  await mkdir(outDir, { recursive: true })
  for (const { text, next } of prepared) {
    const path = join(outDir, next.file)
    if (!existsSync(path)) await writeFile(path, text)
  }
  const index: ScienceIndex = { format: SCIENCE_FORMAT, generatedAt: now, source: result.source, datasets }
  const temporary = `${indexPath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`)
  await rename(temporary, indexPath)

  const keep = referencedFiles(index)
  for (const name of await readdir(outDir)) {
    if (DATASET_FILE_PATTERN.test(name) && !keep.has(name)) {
      await rm(join(outDir, name))
      console.log(`pruned   ${name}`)
    }
  }
  console.log(`\nWrote ${indexPath}`)
  return 0
}

main().then(code => { process.exitCode = code }, error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
