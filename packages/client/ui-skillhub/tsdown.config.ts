import { clientBundle } from '../tsdown.client.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const bundle = clientBundle('@deepseek-ai/dsh-client-ui-skillhub', ['lib/types/index.js'], { hostPhase: true })
const artwork = fileURLToPath(new URL('./src/client/assets/skillhub-mark.png', import.meta.url))

export default ((options) => bundle(options).map(config => ({
  ...config,
  plugins: [...(config.plugins ?? []), {
    name: 'skill-store-artwork',
    resolveId(source: string) {
      return source === './assets/skillhub-mark.png' ? artwork : null
    },
    async load(id: string) {
      if (id !== artwork) return null
      this.addWatchFile(id)
      const data = await readFile(id)
      return `export default ${JSON.stringify(`data:image/png;base64,${data.toString('base64')}`)}`
    },
  }],
}))) satisfies typeof bundle
