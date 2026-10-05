/// <reference lib="webworker" />
// Bakes the colour grade off the main thread (plan 4.7): parses imported .cube looks, bakes the
// lattice into the buffer each job brings and transfers it back, and writes Export .cube. All of
// it is grade-bake-host.ts, which grade-editor.ts also runs on the main thread when this worker
// cannot start or fails; this file only carries the messages.
import { createGradeBakeHost, type HostRequest } from './grade-bake-host.ts'

const host = createGradeBakeHost()

self.onmessage = (event: MessageEvent<HostRequest>) => {
  const result = host.handle(event.data)
  if (result) postMessage(result.reply, { transfer: result.transfer })
}
