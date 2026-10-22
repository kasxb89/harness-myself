/** Native process-output line readers are unavailable in a browser Worker. */
import { notImplementedFail } from '../../notImplementedFail.ts'

/** Puppeteer's native browser launcher reads a launched process stream through this function. */
export const createInterface: typeof import('node:readline').createInterface = notImplementedFail('node:readline', 'createInterface')
/** CommonJS interop marker. */
export const __esModule = true
/** Browser launch is never simulated by returning an empty line reader. */
export default { createInterface } satisfies Partial<typeof import('node:readline')>
