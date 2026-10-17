/** Check generated-media discovery through the packaged Host's real artifact routes. */
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+J4U0AAAAASUVORK5CYII=', 'base64')

/**
 * Save one image in an isolated Harness home and verify its canonical listing paths and exact preview bytes.
 * A sibling private-state sentinel must never appear in the artifact listing.
 * @param home - Disposable home belonging exclusively to this packaging smoke.
 * @param request - Authenticated request to the running packaged Host, using the supplied local path.
 * @returns Resolves when the platform-specific media directory is correctly indexed and readable.
 */
export async function smokeGeneratedArtifacts(home: string, request: (path: string) => Promise<Response>): Promise<void> {
  const directory = join(home, 'plugin-data', 'credits', 'media')
  const image = join(directory, 'desktop-smoke-generated.png')
  const privateState = join(home, 'plugin-data', 'credits', 'desktop-smoke-private.json')
  await mkdir(directory, { recursive: true })
  await writeFile(image, IMAGE)
  await writeFile(privateState, '{"fixture":"private-state"}\n')
  const [indexedDirectory, indexedImage, indexedPrivateState] = await Promise.all([
    realpath(directory), realpath(image), realpath(privateState),
  ])
  const response = await request('/artifacts/api/list')
  if (!response.ok) throw new Error('desktop runtime: generated artifact listing failed')
  const body: unknown = await response.json()
  if (body === null || typeof body !== 'object' || !('items' in body) || !Array.isArray(body.items)
    || !('roots' in body) || !Array.isArray(body.roots)
    || body.roots.length !== 1 || body.roots[0] !== indexedDirectory) {
    throw new Error('desktop runtime: artifact roots must select the current home media directory')
  }
  const items: readonly unknown[] = body.items
  const found = items.find(entry => entry !== null && typeof entry === 'object' && 'path' in entry && entry.path === indexedImage)
  if (found === undefined || found === null || typeof found !== 'object'
    || !('kind' in found) || found.kind !== 'image' || !('size' in found) || found.size !== IMAGE.length
    || items.some(entry => entry !== null && typeof entry === 'object' && 'path' in entry && entry.path === indexedPrivateState)) {
    throw new Error('desktop runtime: generated image was not indexed or private state was exposed')
  }
  const raw = await request(`/artifacts/api/raw?path=${encodeURIComponent(indexedImage)}`)
  if (!raw.ok || !Buffer.from(await raw.arrayBuffer()).equals(IMAGE)) {
    throw new Error('desktop runtime: generated image preview changed its bytes')
  }
}
