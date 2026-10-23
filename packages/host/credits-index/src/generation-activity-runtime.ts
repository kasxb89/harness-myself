/** Live root-chat observations from Agent activity and owned media jobs. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { GenerationActivityReporter } from './generation-activity.ts'

/** Refreshable, plugin-owned root-chat observations. */
export interface GenerationActivityRuntime {
  /** Reconcile the current login and live runtime snapshots without awaiting network activity. */
  refresh(): void
  /**
   * Resolve current live ownership without consulting persisted fork lineage.
   * @param raw - Current Agent/session identity.
   * @returns Root session identity, or undefined when the Agent or provider is unavailable.
   */
  rootSessionId(raw: SessionId): SessionId | undefined
}

/**
 * Observe busy runtime roots without counting child Agents or storyboard jobs as additional chats.
 * Unreadable snapshots retain known leases and suspend report freshness until a complete snapshot succeeds.
 * @param ctx - Owning credits plugin; optional Agents and jobs may arrive or disappear later.
 * @param reporter - Synchronous, account-fenced chat observer.
 * @param currentEpoch - Current login identity, absent while signed out.
 * @returns A synchronous refresh for login changes; plugin disposal releases every observation.
 */
export function attachGenerationActivityRuntime(
  ctx: Context,
  reporter: Pick<GenerationActivityReporter, 'observeChat'>
    & Partial<Pick<GenerationActivityReporter, 'setRuntimeAvailable'>>,
  currentEpoch: () => string | undefined,
): GenerationActivityRuntime {
  const leases = new Map<Agent, { epoch: string; release: () => void }>()
  const jobOwners = new Map<JobId, Agent>()
  let agentsContext: Context | undefined
  let jobs: JobRegistry | undefined
  let closed = false
  let warned = false

  const warn = (): void => {
    if (warned) return
    warned = true
    try { ctx.logger.warn('Generation activity runtime observation is unavailable; generation continues.') }
    catch (_unavailableLogger: unknown) { /* Reporting cannot interrupt Agent or job notifications. */ }
  }
  const available = (value: boolean): void => {
    try { reporter.setRuntimeAvailable?.(value) }
    catch (_unavailableReporter: unknown) { warn() }
  }
  const release = (agent: Agent): boolean => {
    const lease = leases.get(agent)
    try { lease?.release(); leases.delete(agent); return true }
    catch (_unavailableReporter: unknown) { warn(); return false }
  }
  const clear = (): boolean => {
    let complete = true
    for (const agent of leases.keys()) if (!release(agent)) complete = false
    return complete
  }

  const snapshot = (scope: Context) => {
    const agents = scope.agents
    const live = agents.list()
    const roots = new Set(agents.roots())
    const rootOf = (agent: Agent): Agent | undefined => {
      if (!live.includes(agent)) return undefined
      const visited = new Set<Agent>()
      let owner: Agent | undefined = agent
      while (owner !== undefined && !visited.has(owner)) {
        if (roots.has(owner)) return owner
        visited.add(owner)
        const child: Agent = owner
        owner = live.find(candidate => agents.isOwnedBy(child.id, candidate))
      }
      return undefined
    }
    return { live, rootOf }
  }
  const rootSessionId = (raw: SessionId): SessionId | undefined => {
    const scope = agentsContext
    if (closed || scope === undefined) return undefined
    try {
      const agent = scope.agents.get(raw)
      return agent === undefined ? undefined : snapshot(scope).rootOf(agent)?.session.id
    } catch (_unavailableRuntime: unknown) { available(false); warn(); return undefined }
  }
  const reconcile = (): boolean => {
    const scope = agentsContext
    if (scope === undefined) return clear()
    const epoch = currentEpoch()
    let complete = epoch === undefined ? clear() : true
    const { live, rootOf } = snapshot(scope)
    const desired = new Set<Agent>()
    for (const agent of live) {
      let busy = agent.status === 'running'
      for (const job of jobs?.list(agent.id) ?? []) {
        if (job.owner !== agent.id || !['video-project', 'video-edit'].includes(job.kind)
          || !['running', 'stopping'].includes(job.status)) continue
        // A session id may be reused while an old owner's job is still draining.
        if (!jobOwners.has(job.id)) jobOwners.set(job.id, agent)
        if (jobOwners.get(job.id) === agent) busy = true
      }
      if (!busy) continue
      const root = rootOf(agent)
      if (root !== undefined) desired.add(root)
    }
    if (epoch === undefined) return complete
    for (const [agent, lease] of leases) {
      if ((lease.epoch !== epoch || !desired.has(agent)) && !release(agent)) complete = false
    }
    for (const agent of desired) {
      if (leases.has(agent)) continue
      try { leases.set(agent, { epoch, release: reporter.observeChat(epoch, agent.session.id) }) }
      catch (_unavailableReporter: unknown) { complete = false; warn() }
    }
    return complete
  }
  const refresh = (): void => {
    if (closed) return
    try { available(reconcile()) }
    catch (_unavailableRuntime: unknown) { available(false); warn() }
  }

  ctx.effect(() => () => { closed = true; available(clear()); jobOwners.clear() }, 'generation activity runtime')
  ctx.inject(['agents'], (scope) => {
    let active = true
    agentsContext = scope
    jobs = undefined
    jobOwners.clear()
    const changed = (agent: Agent): void => {
      if (!active || closed) return
      try { if (scope.agents.get(agent.id) === agent) refresh() }
      catch (_unavailableRuntime: unknown) { available(false); warn() }
    }
    scope.on('agent/created', ({ agent }) => { changed(agent); return undefined })
    scope.on('agent/status', ({ agent }) => { changed(agent) })
    scope.on('agent/disposed', () => { if (active) refresh() })
    scope.effect(() => () => {
      active = false
      if (agentsContext !== scope) return
      agentsContext = undefined
      jobs = undefined
      available(clear())
      jobOwners.clear()
    }, 'generation activity Agents')
    scope.inject(['jobs'], (jobScope) => {
      const registry = jobScope.jobs
      jobs = registry
      jobOwners.clear()
      const unsubscribe = registry.events.subscribe({ owners: 'all' }, (event) => {
        if (!active || jobs !== registry || event.type === 'output') return
        if (event.type === 'removed' || event.type === 'settled') jobOwners.delete(event.job.id)
        refresh()
      })
      jobScope.effect(() => () => {
        unsubscribe()
        if (jobs !== registry) return
        jobs = undefined
        jobOwners.clear()
        refresh()
      }, 'generation activity jobs')
      refresh()
    })
    refresh()
  })
  return { refresh, rootSessionId }
}
