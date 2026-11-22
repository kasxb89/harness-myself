/** Private Linux entry; never resolves a shared update feed or publication destination. */
import { createElectronBuilderConfig } from './electron-builder-config.mjs'
import { YUNSHU_DESKTOP_APP_ID } from './desktop-release-environment.mjs'

export default createElectronBuilderConfig({
  ...process.env,
  DSH_DESKTOP_APP_ID: YUNSHU_DESKTOP_APP_ID,
  DSH_DESKTOP_TARGET_PLATFORM: 'linux',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_LINUX_PRIVATE: '1',
  DSH_DESKTOP_UNSIGNED: '0',
})
