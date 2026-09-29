// npm run preview                                       -> serves dist/ at /livingdashboard/
// npm run preview -- livingdashboard-sbb --port 5177    -> at /livingdashboard-sbb/ on 5177
//
// Give it the same path the build was made for. Anything after the path goes to
// vite preview as is. On the default port 4173 the basemap stays empty, because the
// local MapTiler key only answers some localhost ports (see src/maptiler-key.ts).
import { execSync } from 'node:child_process'
import { dashboardBase } from './dashboard-base.mjs'

const [first, ...rest] = process.argv.slice(2)
const hasPath = first !== undefined && !first.startsWith('-')
const base = dashboardBase(hasPath ? first : undefined)
const extra = (hasPath ? rest : process.argv.slice(2)).join(' ')

execSync(`vite preview --base=${base} ${extra}`.trim(), { stdio: 'inherit' })
