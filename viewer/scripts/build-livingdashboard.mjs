// npm run build                          -> dist/ for /livingdashboard/
// npm run build -- livingdashboard-sbb   -> dist/ for /livingdashboard-sbb/
//
// Same three steps as before, each stopping the build if it fails: type check,
// Vite bundle for the given path, then the index.html copy and path check.
import { execSync } from 'node:child_process'
import { dashboardBase } from './dashboard-base.mjs'

const base = dashboardBase(process.argv[2])
const run = (command) => execSync(command, { stdio: 'inherit' })

run('tsc')
run(`vite build --base=${base}`)
run(`node scripts/prepare-livingdashboard.mjs ${base}`)
