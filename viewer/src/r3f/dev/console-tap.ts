// DEV only: mirror console output into window.__log so a browser automation
// session can read early boot messages after the fact.
if (import.meta.env.DEV) {
  const log: string[] = ((window as any).__log = [])
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      log.push(`[${level}] ${args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`)
      if (log.length > 400) log.shift()
      original(...args)
    }
  }
  window.addEventListener('error', (e) => log.push(`[uncaught] ${e.message} @${e.filename}:${e.lineno}\n${String(e.error?.stack ?? '').split('\n').slice(0, 6).join('\n')}`))
  window.addEventListener('unhandledrejection', (e) => log.push(`[unhandled] ${String((e as PromiseRejectionEvent).reason?.stack ?? (e as PromiseRejectionEvent).reason)}`))
}
export {}
