/** Exact gateway declarations and signed content URLs for retained image results. @module */
import { apiUrl } from './api-url.ts'
import type { CreativeImageServerTaskId } from './creative-types.ts'
import type { ImageRetainedResult } from './image-result-store.ts'

/** A valid local source or an original server task whose private source cannot currently be read. */
export type ImageRecoverySources = { readonly kind: 'local'; readonly result: ImageRetainedResult } | { readonly kind: 'server' }

/**
 * Keep a failed local source read from hiding an independently retained server task.
 * @param load - Owner-verified private source read; errors remain authoritative without a server receipt.
 * @param serverTaskId - Previously validated original server identity, never a new submission instruction.
 * @returns Local sources when readable, otherwise the original server recovery path.
 */
export async function loadImageRecoverySources(
  load: () => Promise<ImageRetainedResult>, serverTaskId: CreativeImageServerTaskId | undefined,
): Promise<ImageRecoverySources> {
  try { return { kind: 'local', result: await load() } }
  catch (error) {
    if (serverTaskId === undefined) throw error
    return { kind: 'server' }
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Accept only exact image models with reviewed retained-result protocols.
 * @param rows - Current gateway pricing records, before menu projection.
 * @param model - Exact model selected by the account-bound image request.
 * @returns Whether new submissions may retain the gateway's result task header.
 */
export function imageServerResultRecovery(rows: readonly unknown[], model: string): boolean {
  if (model.length === 0) return false
  const matches = rows.map(object).filter(row => row?.model_name === model)
  if (matches.length !== 1) return false
  const row = matches[0]
  const parameters = object(row?.parameters)
  const plugin = object(parameters?.['x-task-plugin'])
  const kind = row?.kind ?? parameters?.['x-model-kind']
  const support = object(parameters?.['x-image-receipt-recovery'])
  const ycapiReady = support !== undefined && Object.keys(support).length === 3 && support.schema_version === 1
    && support.submit_model_metadata === true && support.original_task_artifacts === true
  const supportedPlugin = plugin !== undefined && Object.keys(plugin).length === 3 && plugin.api_version === 1
    && plugin.version === '1.0.0' && (plugin.key === 'codebloom-image' || plugin.key === 'ycapi')
  return kind === 'image' && (parameters?.['x-model-kind'] === undefined || parameters['x-model-kind'] === 'image')
    && (row?.route === undefined || row.route === '/v1/images/generations')
    && supportedPlugin && (plugin.key !== 'ycapi' || ycapiReady)
}

/**
 * Stop new YCAPI image submissions until the gateway declares the corrected receipt handling.
 * @param rows - Current gateway pricing records before menu projection.
 * @param model - Exact account-selected image model.
 * @returns Whether submission must stop before a potentially paid request; original-task recovery remains available.
 */
export function imageServerSubmissionRequiresUpdate(rows: readonly unknown[], model: string): boolean {
  const ycapi = rows.map(object).some(row => row?.model_name === model
    && object(object(row.parameters)?.['x-task-plugin'])?.key === 'ycapi')
  return ycapi && !imageServerResultRecovery(rows, model)
}

/**
 * Keep artifact downloads on the original gateway's exact task and artifact path.
 * @param baseUrl - Captured backend root, including its deployment prefix.
 * @param taskId - Original gateway task identifier retained from the accepted response.
 * @param key - Image artifact key from that task's authenticated manifest.
 * @param value - Signed content URL returned by the manifest.
 * @returns A normalized URL, or undefined when the advertised destination is unrelated or malformed.
 */
export function imageServerArtifactUrl(baseUrl: string, taskId: string, key: string, value: string): string | undefined {
  if (!/^task_[A-Za-z0-9][A-Za-z0-9._:-]{0,250}$/u.test(taskId)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(key)
    || value.length > 8192 || value.trim() !== value || /[\u0000-\u0020\u007f]/u.test(value)) return undefined
  try {
    const expected = new URL(apiUrl(baseUrl,
      `/v1/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(key)}/content`))
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== expected.origin
      || url.pathname !== expected.pathname || url.username !== '' || url.password !== '' || url.hash !== '') return undefined
    const access = url.searchParams.getAll('access')
    if (access.length !== 1 || access[0] === '' || (access[0]?.length ?? 0) > 4096
      || [...url.searchParams.keys()].some(name => name !== 'access')) return undefined
    return url.href
  } catch (_invalidArtifactUrl: unknown) {
    return undefined
  }
}
