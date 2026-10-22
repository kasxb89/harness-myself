/** Worker-only deployment overlays leave the packed Node/Web/Desktop composition intact. */
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'

type Overlay = ProfileContext['overlays'][number]

/**
 * Derive Worker deployment settings from the original composed rows.
 * @param rows - Parsed original composition; rows and nested configuration are never mutated.
 * @returns Plaintext VFS logs and, when present by exact identity, a disabled host-native Cua provider.
 */
export function workerProfileOverlays(rows: unknown): Overlay[] {
  const find = (entries: unknown, id: string): Record<string, unknown> | undefined => {
    if (!Array.isArray(entries)) return undefined
    for (const entry of entries as Array<Record<string, unknown>>) {
      if (entry.id === id) return entry
      const nested = find(entry.config, id)
      if (nested !== undefined) return nested
    }
    return undefined
  }
  const patches: Overlay[] = []
  const jsonl = find(rows, 'session-persistence-jsonl')
  if (jsonl !== undefined) {
    const config = typeof jsonl.config === 'object' && jsonl.config !== null && !Array.isArray(jsonl.config)
      ? jsonl.config : {}
    patches.push({ id: 'session-persistence-jsonl', config: { ...config, compression: 'none' } })
  }
  const nativeCua = find(rows, 'computer-use-cua-driver-native')
  if (nativeCua?.name === '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native') {
    patches.push({ id: 'computer-use-cua-driver-native', disabled: true })
  }
  return patches
}
