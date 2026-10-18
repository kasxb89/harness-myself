// @vitest-environment jsdom
// The built-bundle boot smoke: the assembled-jsdom test that owns the boot
// graph itself. Other files share the same scaffolding (assembled-boot.ts) to
// reach a surface only the built bundles expose; this one asserts that the
// graph assembles at all — staged activation across the immediately tier and
// the inject layers, per-plugin CSS injection, and a rendered journey reaching
// chat content from the keyless RemoteMock scenario.
//
// Component behavior remains owned by per-package suites (SlotTestRuntime
// benches over src). This smoke additionally pins the resident interaction
// fixture's cross-plugin projection because only the built connection,
// Controller, UI adapter, and Workspace graph can prove that transport-to-row
// path end to end.
import { resolve } from 'node:path'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

const buildEnvironmentModulePath = '../../../scripts/client-build-environment.ts'
const buildEnvironmentModule: unknown = await import(buildEnvironmentModulePath)
if (typeof buildEnvironmentModule !== 'object' || buildEnvironmentModule === null) {
  throw new TypeError('client build environment module must be an object')
}
const readClientBuildRecord: unknown = Reflect.get(buildEnvironmentModule, 'readClientBuildRecord')
if (!isBuildRecordReader(readClientBuildRecord)) {
  throw new TypeError('client build environment module must export readClientBuildRecord')
}
const record: unknown = readClientBuildRecord(resolve(import.meta.dirname, '../../..'))
if (typeof record !== 'object' || record === null) throw new TypeError('client build record must be an object')
const clientBuildEnvironment = requireObject(
  Reflect.get(record, 'environment'),
  'client build record environment must be an object',
)
const yunshuMarkPath = 'M6.4 8.9C7 4.3 10.7 2 14.5 3.5C18.1 4.9 19.3 8.1 18 11.6L16.8 14.2C16.8 11 15.6 8.7 13.3 7.5C11 6.4 8.6 6.9 6.4 8.9ZM17.4847 8.7003C21.1684 11.5199 21.3103 15.8742 18.1112 18.4151C15.0988 20.8328 11.7275 20.272 9.3464 17.3962L7.6947 15.0569C10.466 16.6569 13.0579 16.7677 15.2471 15.3758C17.3497 13.934 18.1167 11.6055 17.4847 8.7003ZM12.1153 18.3997C7.8316 20.1801 3.9897 18.1258 3.3888 14.0849C2.8012 10.2672 4.9725 7.628 8.6536 7.0038L11.5053 6.7431C8.734 8.3431 7.3421 10.5323 7.4529 13.1242C7.6503 15.666 9.2833 17.4945 12.1153 18.3997Z'

function isBuildRecordReader(value: unknown): value is (root: string) => unknown {
  return typeof value === 'function'
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) throw new TypeError(message)
  return value
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read one optional string from the verified client build record. */
function clientBuildValue(name: string): string | undefined {
  const value = clientBuildEnvironment[name]
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError(`client build record environment ${name} must be a string`)
  }
  return value
}

function renderedContainer(selector: string): Promise<HTMLElement> {
  return waitFor(() => {
    const container = document.querySelector<HTMLElement>(selector)
    if (container === null) throw new Error(`assembled fixture container missing: ${selector}`)
    return container
  })
}

it('boots the built plugin graph and renders a fixture session end to end', async () => {
  mountAssembledApp()

  // The sidebar renders from the boot graph: every inject layer activated.
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  if (clientBuildValue('DSH_CLIENT_BUILD_PROFILE') === 'official') {
    expect(document.querySelector('svg[viewBox="26 0 156 24"]')).not.toBeNull()
    expect(screen.queryByText('DSH Local Build')).toBeNull()
  } else {
    expect(document.querySelector(`svg[viewBox="0 0 24 24"] path[d="${yunshuMarkPath}"][fill="currentColor"]`)).not.toBeNull()
    const version = clientBuildValue('DSH_CLIENT_VERSION')
    if (version === undefined) throw new Error('default client build record must carry DSH_CLIENT_VERSION')
    const commit = clientBuildValue('DSH_CLIENT_COMMIT_HASH')
    const buildVersion = version
      + (commit === undefined ? '' : `-${commit}`)
      + (clientBuildValue('DSH_CLIENT_GIT_DIRTY') === 'true' ? '-dirty' : '')
    screen.getByText('Yunshu', { exact: true })
    expect(screen.queryByText('DSH Local Build')).toBeNull()
    screen.getByText(buildVersion)
  }
  // The compact layout dropped group session counts; the fixture workspace
  // group row renders immediately with its sessions beneath it.
  const fixtureGroup = (await within(tree).findAllByText('fixture'))
    .map(el => el.closest<HTMLElement>('[role="treeitem"]'))
    .find(el => el?.getAttribute('aria-expanded') !== null)
  if (fixtureGroup === undefined) throw new Error('fixture Workspace group missing')

  // The resident fixture has both a question and an approval; composer routing
  // exposes the question first, and the assembled workspace plugin mirrors that
  // actionable wait instead of the underlying running state.
  const waitingTitle = await within(tree).findByText('Fixture 历史会话')
  const waitingRow = waitingTitle.closest<HTMLElement>('[role="treeitem"]')
  if (waitingRow === null) throw new Error('fixture Session title must belong to a tree row')
  expect(waitingRow.querySelector('[data-state="warning"]')).not.toBeNull()
  expect(waitingRow.querySelector('[data-state="ongoing"]')).toBeNull()
  within(waitingRow).getByText('Waiting for answer')
  within(waitingRow).getByText('Answer')

  // Opening a session reaches chat content through the RemoteMock transport.
  fireEvent.click(waitingTitle)
  await waitFor(() => {
    expect(document.querySelector('[data-sample="bash"]')).not.toBeNull()
    expect(document.querySelector('[data-chat-running]')?.parentElement?.getAttribute('data-slot'))
      .toBe('conversation.chat.flow')
  }, { timeout: 10_000 })
  // The generated bundle roster mounts the question UI before the approval UI.
  // Skip the resident fixture's three questions, then resolve its approval so
  // the ordinary composer bar (which owns ContextMeter) resumes.
  for (let index = 0; index < 3; index += 1) {
    const question = await renderedContainer('[data-question-key]')
    fireEvent.click(await within(question).findByRole('button', { name: 'Skip' }))
  }
  const approval = await renderedContainer('[data-approval-key]')
  const allowOnce = await within(approval).findByRole('button', { name: 'Allow once' })
  await waitFor(() => {
    within(waitingRow).getByText('Waiting for approval')
    within(waitingRow).getByText('Approval')
  })
  fireEvent.click(allowOnce)

  // The fixture mirrors all three token-meter projections, so the assembled
  // ContextMeter reaches its composition panel instead of only the occupancy
  // fallback path.
  const composer = await renderedContainer('[data-slot="conversation.composer.bar"]')
  const contextTrigger = await within(composer).findByRole('button', { name: /of context used/ })
  fireEvent.click(contextTrigger)
  const contextPanel = await screen.findByRole('dialog', { name: 'of context used' })
  within(contextPanel).getByText('System prompt')
  within(contextPanel).getByText('Tool definitions')
  within(contextPanel).getByText('Messages')

  // The built ToolRow and DiffBlock share the write fixture's trailing-newline
  // semantics: `hello fixture\n` contributes one addition. Counts belong to the
  // tool row; the diff's line markers are CSS pseudo-elements, absent from textContent.
  const mutationRows = [...document.querySelectorAll<HTMLElement>('[data-variant="write"],[data-variant="edit"]')]
  expect(mutationRows.length).toBeGreaterThan(0)
  const writeRow = mutationRows.find(row => row.getAttribute('data-variant') === 'write'
    && row.textContent?.includes('new-demo.txt'))
  if (writeRow === undefined) throw new Error('fixture write row missing')
  expect(within(writeRow).getAllByText('+1', { exact: true })).toHaveLength(1)
  expect(within(writeRow).getAllByText('-0', { exact: true })).toHaveLength(1)
  expect(writeRow.querySelector('[data-diff]')).toBeNull()
  for (const row of mutationRows) {
    const toggle = row.querySelector('[data-expandable]')
    if (toggle !== null) act(() => { fireEvent.click(toggle) })
  }
  const diffCards = [...document.querySelectorAll('[data-diff]')]
  expect(diffCards.length).toBeGreaterThan(0)
  const writeDiff = writeRow.querySelector<HTMLElement>('[data-diff]')
  if (writeDiff === null) throw new Error('expanded fixture write diff missing')
  within(writeDiff).getByText('hello fixture', { exact: true })
  expect(within(writeRow).getAllByText('+1', { exact: true })).toHaveLength(1)
  expect(within(writeRow).getAllByText('-0', { exact: true })).toHaveLength(1)
  expect(writeDiff.textContent).not.toContain('+1 -0')

  // The web render intent reaches the assembled boot graph: the fixture's
  // web_search / web_fetch turns render their keyed WebRow cards, proving the
  // registration, wire projection, and card rendering survive the real bundle
  // path (not just the per-package src benches). WebRow composes ToolRow, so the
  // card is collapsed behind the row; the keyed row is pinned by its `data-tool`
  // (ToolRow sets it from the wire tool name).
  const webSearchRow = await waitFor(() => {
    const row = document.querySelector('[data-tool="web_search"]')
    expect(row).not.toBeNull()
    expect(document.querySelector('[data-tool="web_fetch"]')).not.toBeNull()
    return row!
  }, { timeout: 10_000 })
  // Expand the web_search row to prove its WebBlock card renders end to end.
  const webToggle = webSearchRow.querySelector('[data-expandable]')
  if (webToggle !== null) act(() => { fireEvent.click(webToggle) })
  await waitFor(() => {
    expect(webSearchRow.querySelector('[data-web]')).not.toBeNull()
  }, { timeout: 10_000 })

  // Every bundle injected its plugin-owned style tag (the loader's CSS path).
  const styleOwners = [...document.head.querySelectorAll('style[data-plugin]')]
    .map(style => style.getAttribute('data-plugin'))
  for (const plugin of ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-tool']) {
    expect(styleOwners).toContain(plugin)
  }
})

it('boots without ui-chat and does not select another conversation view implicitly', async () => {
  mountAssembledApp({ exclude: ['@deepseek-ai/dsh-client-ui-chat'] })

  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const boot = Reflect.get(window, '__DSH_BOOT__') as { entries: Array<{ id: string }> } | undefined
  expect(boot?.entries.some(entry => entry.id === '@deepseek-ai/dsh-client-ui-chat')).toBe(false)
  const sessionTitle = await within(tree).findByText('Fixture 历史会话')
  fireEvent.click(sessionTitle)
  await waitFor(() => {
    expect(document.querySelector('[data-slot="conversation.session"]')).not.toBeNull()
  }, { timeout: 10_000 })
  expect(document.querySelector('[data-slot="conversation.view"]')).toBeNull()
})
