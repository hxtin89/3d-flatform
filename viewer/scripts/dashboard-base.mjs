// The URL path the Living Dashboard is built for, shared by build, preview and the
// post-build check so the three cannot disagree.
//
// It is an argument rather than a setting because more than one copy is deployed
// side by side on the same domain (e.g. /livingdashboard/ and /livingdashboard-sbb/),
// and passing it as `npm run build -- <path>` reads the same in PowerShell and zsh,
// where setting an environment variable for one command does not.
//
// The domain stays the same for every copy, so the MapTiler key keeps working:
// it checks the origin, never the path.

export const DEFAULT_BASE = '/livingdashboard/'

/** "livingdashboard-sbb", "/livingdashboard-sbb" and "/livingdashboard-sbb/" all mean the same path. */
export function dashboardBase(arg) {
  if (!arg) return DEFAULT_BASE
  const base = `/${arg.replace(/^\/+|\/+$/g, '')}/`
  // Letters, digits, - and _ per segment: the path lands in a shell command and in
  // a regex below, and nothing a deploy folder needs is outside that set.
  if (!/^\/(?:[A-Za-z0-9_-]+\/)+$/.test(base)) {
    throw new Error(`Not a usable dashboard path: ${arg} (try e.g. livingdashboard-sbb)`)
  }
  return base
}
