import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const sourceDir = resolve('source-assets/sounds')
const outputDir = resolve('public/sounds')
const tracks = [
  ['ambient-day.MOV', 'ambient-day'],
  ['night-ambient.MOV', 'night-ambient'],
  ['rain.MOV', 'rain'],
]
const seamSeconds = 1.5

mkdirSync(outputDir, { recursive: true })

for (const [sourceName, outputStem] of tracks) {
  const source = resolve(sourceDir, sourceName)
  const aacOutput = resolve(outputDir, `${outputStem}.m4a`)
  const opusOutput = resolve(outputDir, `${outputStem}.webm`)
  const duration = Number(execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    source,
  ], { encoding: 'utf8' }).trim())
  if (!Number.isFinite(duration) || duration <= seamSeconds * 3) {
    throw new Error(`Audio source is too short for a soft loop: ${sourceName}`)
  }

  const seamStart = (duration - seamSeconds).toFixed(6)
  const preciseDuration = duration.toFixed(6)
  const filter = [
    '[0:a:0]asplit=3[body-in][tail-in][head-in]',
    `[body-in]atrim=start=${seamSeconds}:end=${seamStart},asetpts=PTS-STARTPTS[body]`,
    `[tail-in]atrim=start=${seamStart}:end=${preciseDuration},asetpts=PTS-STARTPTS[tail]`,
    `[head-in]atrim=start=0:end=${seamSeconds},asetpts=PTS-STARTPTS[head]`,
    `[tail][head]acrossfade=d=${seamSeconds}:c1=tri:c2=tri[seam]`,
    '[body][seam]concat=n=2:v=0:a=1,loudnorm=I=-24:LRA=7:TP=-2[out]',
  ].join(';')

  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-i', source,
    '-filter_complex', filter,
    '-map', '[out]',
    '-map_metadata', '-1',
    '-vn', '-sn', '-dn',
    '-ar', '44100', '-ac', '2',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    aacOutput,
  ], { stdio: 'inherit' })
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-i', source,
    '-filter_complex', filter,
    '-map', '[out]',
    '-map_metadata', '-1',
    '-vn', '-sn', '-dn',
    '-ar', '48000', '-ac', '2',
    '-c:a', 'libopus', '-b:a', '96k', '-vbr', 'on',
    '-compression_level', '10', '-application', 'audio',
    opusOutput,
  ], { stdio: 'inherit' })
  console.log(`Prepared ${outputStem}.m4a + ${outputStem}.webm`)
}
