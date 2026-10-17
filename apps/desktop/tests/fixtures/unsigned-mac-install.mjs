import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareUnsignedMacInstall } from '../../src/unsigned-mac-install.ts'

const request = JSON.parse(await readFile(process.argv[2], 'utf8'))
const prepared = await prepareUnsignedMacInstall(request)
if (request.helperSource !== undefined) {
  const operation = (await readdir(request.stateDirectory)).find(name => name.startsWith('install-'))
  if (operation === undefined) throw new Error('missing fixture operation')
  await writeFile(join(request.stateDirectory, operation, 'install.sh'), request.helperSource)
}
await prepared.launch()
process.send({ kind: 'ready' })
process.on('message', message => {
  if (message === 'quit') process.exit(0)
})
