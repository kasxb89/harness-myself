import { defineConfig } from 'tsdown'

/** Build the Web runtime, startup provider, and package-owned preset tools. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/startup.js', 'lib/types/standard-agent-tools.js'],
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
})
