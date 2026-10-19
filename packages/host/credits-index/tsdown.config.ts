import { defineConfig } from 'tsdown'

/** Keep the separately licensed HEIC decoder replaceable as npm modules. */
export default defineConfig({
  external: ['heic-decode', 'libheif-js'],
})
