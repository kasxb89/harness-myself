import { defineConfig } from 'tsdown'

/** Build separately so the external renderer has no Cordis or shared-chunk dependency. */
export default defineConfig(['index', 'render-cache'].map(name => ({
  entry: [`lib/types/${name}.js`], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
})))
