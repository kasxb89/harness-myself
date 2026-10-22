/**
 * `@earendil-works/pi-ai` stub, including its `/providers/all` and `/api/*.lazy`
 * subpaths. The package is Node-only (no `require`/`browser` conditions, Node
 * builtins plus five cloud SDKs in its transport layer) and `llm-pi-ai` imports it
 * statically at module scope, so the row cannot mount without it.
 *
 * Catalog readers and configured model collections retain metadata during boot.
 * Protocol factories construct transport descriptors without starting a request;
 * every request, credential mutation, and dynamic refresh still refuses explicitly.
 */
import { notImplementedFail } from '../notImplementedFail.ts'

const MODULE = '@earendil-works/pi-ai'

/** Provider factory (unavailable). */
export const createProvider = notImplementedFail(MODULE, 'createProvider')

/** Model-list factory (unavailable). */
export const createModels = notImplementedFail(MODULE, 'createModels')

/** Thinking-level catalog (unavailable). */
export const getSupportedThinkingLevels = notImplementedFail(MODULE, 'getSupportedThinkingLevels')

/** Context-overflow predicate (unavailable). */
export const isContextOverflow = notImplementedFail(MODULE, 'isContextOverflow')

/** Model identity read by the adapter; the original descriptor object remains intact. */
interface PreviewModel { readonly id: string }

/** Configured provider metadata consumed by the model selector. */
interface PreviewProvider {
  readonly id: string
  getModels(): readonly PreviewModel[]
}

/** Request functions always refuse before returning a value. */
type UnavailableRequest = (...args: never[]) => never

/** Configured catalog operations and explicit refusals retained by a Worker collection. */
interface PreviewModels {
  clearProviders(): void
  setProvider(provider: PreviewProvider): void
  deleteProvider(id: string): void
  getProviders(): readonly PreviewProvider[]
  getProvider(id: string): PreviewProvider | undefined
  getModels(provider?: string): readonly PreviewModel[]
  getModel(provider: string, id: string): PreviewModel | undefined
  getAllModels(provider?: string): readonly PreviewModel[]
  getModelsOfType: UnavailableRequest
  getModelOfType: UnavailableRequest
  refresh: UnavailableRequest
  checkAuth: UnavailableRequest
  getAvailable: UnavailableRequest
  getAvailableOfType: UnavailableRequest
  getAllAvailable: UnavailableRequest
  getAuth: UnavailableRequest
  login: UnavailableRequest
  logout: UnavailableRequest
  stream: UnavailableRequest
  complete: UnavailableRequest
  streamSimple: UnavailableRequest
  completeSimple: UnavailableRequest
  streamDeferred: UnavailableRequest
  fetchDeferred: UnavailableRequest
  cancelDeferred: UnavailableRequest
  generateImages: UnavailableRequest
  classify: UnavailableRequest
}

/** Transport descriptors expose request refusals without starting a request. */
interface PreviewTransport {
  stream: UnavailableRequest
  streamSimple: UnavailableRequest
}

/**
 * Construct a metadata-only collection for the configured model routes.
 * @returns Mutable provider membership and exact configured model descriptors; request methods refuse.
 */
export function builtinModels(): PreviewModels {
  const providers = new Map<string, PreviewProvider>()
  const getModels = (provider?: string): readonly PreviewModel[] => provider === undefined
    ? [...providers.values()].flatMap(value => value.getModels())
    : providers.get(provider)?.getModels() ?? []
  return {
    clearProviders: (): void => { providers.clear() },
    setProvider: (provider: PreviewProvider): void => { providers.set(provider.id, provider) },
    deleteProvider: (id: string): void => { providers.delete(id) },
    getProviders: (): readonly PreviewProvider[] => [...providers.values()],
    getProvider: (id: string): PreviewProvider | undefined => providers.get(id),
    getModels,
    getModel: (provider: string, id: string): PreviewModel | undefined => getModels(provider).find(model => model.id === id),
    getAllModels: getModels,
    getModelsOfType: notImplementedFail(MODULE, 'Models.getModelsOfType'),
    getModelOfType: notImplementedFail(MODULE, 'Models.getModelOfType'),
    refresh: notImplementedFail(MODULE, 'Models.refresh'),
    checkAuth: notImplementedFail(MODULE, 'Models.checkAuth'),
    getAvailable: notImplementedFail(MODULE, 'Models.getAvailable'),
    getAvailableOfType: notImplementedFail(MODULE, 'Models.getAvailableOfType'),
    getAllAvailable: notImplementedFail(MODULE, 'Models.getAllAvailable'),
    getAuth: notImplementedFail(MODULE, 'Models.getAuth'),
    login: notImplementedFail(MODULE, 'Models.login'),
    logout: notImplementedFail(MODULE, 'Models.logout'),
    stream: notImplementedFail(MODULE, 'Models.stream'),
    complete: notImplementedFail(MODULE, 'Models.complete'),
    streamSimple: notImplementedFail(MODULE, 'Models.streamSimple'),
    completeSimple: notImplementedFail(MODULE, 'Models.completeSimple'),
    streamDeferred: notImplementedFail(MODULE, 'Models.streamDeferred'),
    fetchDeferred: notImplementedFail(MODULE, 'Models.fetchDeferred'),
    cancelDeferred: notImplementedFail(MODULE, 'Models.cancelDeferred'),
    generateImages: notImplementedFail(MODULE, 'Models.generateImages'),
    classify: notImplementedFail(MODULE, 'Models.classify'),
  }
}

/**
 * Builtin provider ids as pi-ai 0.84.2 listed them, in catalog order. The list
 * is a fixed copy that pi-ai upgrades do not regenerate, so it omits providers
 * added since.
 */
const BUILTIN_PROVIDER_IDS: readonly string[] = [
  'amazon-bedrock', 'ant-ling', 'anthropic', 'azure-openai-responses', 'baseten', 'cerebras',
  'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'deepseek', 'fireworks', 'github-copilot',
  'google', 'google-vertex', 'groq', 'huggingface', 'kimi-coding', 'minimax', 'minimax-cn',
  'mistral', 'moonshotai', 'moonshotai-cn', 'nvidia', 'openai', 'openai-codex', 'opencode',
  'opencode-go', 'openrouter', 'qwen-token-plan', 'qwen-token-plan-cn',
  'qwen-token-plan-individual', 'together',
  'vercel-ai-gateway', 'xai', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp', 'zai', 'zai-coding-cn',
]

/**
 * Installed catalog providers, read while `llm-pi-ai` activates. `llm-pi-ai`
 * registers the whole catalog as configurable the moment it mounts and rejects
 * an empty registration, so these carry pi-ai's ids instead of being an empty
 * list. Each has the api-key auth marker the adapter filters on, and no
 * models, so every request path lands on a loud symbol above.
 * @returns one entry per builtin provider.
 */
export function builtinProviders(): unknown[] {
  return BUILTIN_PROVIDER_IDS.map(id => ({
    id,
    name: id,
    auth: { apiKey: { type: 'api-key' } },
    models: [],
    getModels: () => [],
    ...unavailableStreams(),
  }))
}

/**
 * Models of one installed catalog provider.
 * @returns no models.
 */
export function getBuiltinModels(): unknown[] {
  return []
}

/**
 * Models of every type of one installed catalog provider.
 * @returns no models.
 */
export function getAllBuiltinModels(): unknown[] {
  return []
}

/** Request transports remain unavailable after metadata construction. */
function unavailableStreams(): PreviewTransport {
  return {
    stream: notImplementedFail(MODULE, 'Provider.stream'),
    streamSimple: notImplementedFail(MODULE, 'Provider.streamSimple'),
  }
}

/**
 * Construct the Anthropic transport descriptor without starting a request.
 * @returns Explicitly refusing stream functions.
 */
export function anthropicMessagesApi(): PreviewTransport { return unavailableStreams() }

/**
 * Construct the OpenAI completions descriptor without starting a request.
 * @returns Explicitly refusing stream functions.
 */
export function openAICompletionsApi(): PreviewTransport { return unavailableStreams() }

/**
 * Construct the OpenAI responses descriptor without starting a request.
 * @returns Explicitly refusing stream functions.
 */
export function openAIResponsesApi(): PreviewTransport { return unavailableStreams() }

/** CommonJS interop marker: the worker loader hands `default` to default imports. */
export const __esModule = true

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  createProvider, createModels, getSupportedThinkingLevels, isContextOverflow, builtinModels, builtinProviders,
  getBuiltinModels, getAllBuiltinModels, anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi,
}
