/** Native Chromium launch has no executable or process carrier in a browser Worker. */
import { notImplementedFail } from '../notImplementedFail.ts'

/** Univer's native renderer cannot launch Chromium in the Worker host. */
export const launch = notImplementedFail('puppeteer-core', 'launch')
/** CommonJS interop marker. */
export const __esModule = true
/** The actual renderer's launch call fails before returning any browser object. */
export default { launch }
