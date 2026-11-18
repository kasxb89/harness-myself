import { clientBundle } from '../tsdown.client.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const bundle = clientBundle('@deepseek-ai/dsh-client-ui-agent-preset', ['lib/types/index.js'])
const employeeMarkPath = fileURLToPath(new URL('./src/client/assets/employees-mark.png', import.meta.url))

export default ((options) => bundle(options).map(config => ({
  ...config,
  plugins: [...(config.plugins ?? []), {
    name: 'employee-page-artwork',
    resolveId(source: string) {
      return source === './assets/employees-mark.png' ? employeeMarkPath : null
    },
    async load(id: string) {
      if (id !== employeeMarkPath) return null
      this.addWatchFile(id)
      const data = await readFile(id)
      return `export default ${JSON.stringify(`data:image/png;base64,${data.toString('base64')}`)}`
    },
  }],
}))) satisfies typeof bundle
