import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openScienceData } from './science-data-loader.ts'

const trails = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: [[[-69.488, -12.859], [-69.489, -12.858]]] },
    properties: { trail_id: 'trails/1', country_code: 'PE', trail_name: 'Bootkiller_Trail', folder_name: null },
  }],
}
const entry = (file: string) => ({ file, version: '0', updatedAt: '', featureCount: 1, bytes: 1, bbox: [0, 0, 0, 0], history: [] })

function fakeFetch(files: Record<string, unknown>, asked: string[]) {
  return (async (url: string, init?: RequestInit) => {
    asked.push(`${url}${init?.cache ? ` (${init.cache})` : ''}`)
    const body = files[url]
    return body === undefined ? new Response('', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
}

test('the index is revalidated, a dataset is fetched once, next to the index', async () => {
  const asked: string[] = []
  const source = await openScienceData('https://cdn.test/science-data/index.json', fakeFetch({
    'https://cdn.test/science-data/index.json': { format: 1, generatedAt: '', source: { kind: 'test', url: '' }, datasets: { trails: entry('trails.0000000000000001.json') } },
    'https://cdn.test/science-data/trails.0000000000000001.json': trails,
  }, asked))
  const [a, b] = await Promise.all([source.load('trails'), source.load('trails')])
  assert.equal(a, b)
  assert.equal(a?.features.length, 1)
  assert.equal(await source.load('mammals'), null)
  assert.deepEqual(asked, [
    'https://cdn.test/science-data/index.json (no-cache)',
    'https://cdn.test/science-data/trails.0000000000000001.json',
  ])
})

test('a file that fails its checks is not drawn; a failed download is tried again', async () => {
  const asked: string[] = []
  const files: Record<string, unknown> = {
    'https://cdn.test/index.json': { format: 1, generatedAt: '', source: { kind: 'test', url: '' }, datasets: {
      trails: entry('trails.json'), 'protected-areas': entry('areas.json'),
    } },
    'https://cdn.test/areas.json': { type: 'FeatureCollection', features: [] },
  }
  const source = await openScienceData('https://cdn.test/index.json', fakeFetch(files, asked))
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.equal(await source.load('protected-areas'), null)
  } finally {
    console.warn = warn
  }
  await assert.rejects(source.load('trails'), /HTTP 404/)
  files['https://cdn.test/trails.json'] = trails
  assert.equal((await source.load('trails'))?.features.length, 1)
})

test('an index of another format is refused', async () => {
  const fetchImpl = fakeFetch({ 'https://cdn.test/index.json': { format: 2, datasets: {} } }, [])
  await assert.rejects(openScienceData('https://cdn.test/index.json', fetchImpl), /format 2/)
})
