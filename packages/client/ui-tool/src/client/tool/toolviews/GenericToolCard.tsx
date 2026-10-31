import type { ReactNode } from 'react'
import {
  IconApiOutlineRegular, IconBrowseOutlineRegular, IconCodeOutlineRegular, IconEditOutlineRegular, IconSearchOutlineRegular,
  IconSparkleRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallOwnerProps, ToolTreeProps } from '../../contract/slots.ts'
import { readCardModel } from '../models/read-card-model.ts'
import { diffCardModel } from '../models/diff-card-model.ts'
import { searchCardModel } from '../models/search-card-model.ts'
import { terminalCardModel, terminalFailed } from '../models/terminal-card-model.ts'
import { webCardModel } from '../models/web-card-model.ts'
import { toolRowModel, type ToolRowVariant } from '../models/tool-call-model.ts'
import { localizeAutoReviewDenial } from '../models/auto-review-denial.ts'
import { mediaFailure } from '../models/media-failure.ts'
import { ToolRow } from '../components/ToolRow.tsx'

/** Variant leading icons (figma table); all glyphs render at 14 inside the 16px leading box. */
const VARIANT_ICONS: Record<ToolRowVariant, ReactNode> = {
  search: <IconSearchOutlineRegular size={14} />,
  read: <IconBrowseOutlineRegular size={14} />,
  bash: <IconApiOutlineRegular size={14} />,
  write: <IconEditOutlineRegular size={14} />,
  edit: <IconEditOutlineRegular size={14} />,
  code: <IconCodeOutlineRegular size={14} />,
  others: <IconSparkleRegular size={14} />,
}

/** Card props: the owner payload plus the render site's locale seat (plain prop). */
export type GenericToolCardProps = ToolCallOwnerProps & {
  t: ToolTreeProps['t']
}

const MEDIA_FAILURE_KEYS = {
  'accepted-queued': 'error.mediaTaskQueued',
  'accepted-pending': 'error.mediaTaskPending',
  'model-parameters': 'error.mediaParameters',
  'plan-parameters': 'error.creationPlanParameters',
  'video-count-limit': 'error.videoCountLimit',
  'video-intent-unavailable': 'error.videoIntentUnavailable',
  'video-quote-unavailable': 'error.videoQuoteUnavailable',
  'video-quote-changed': 'error.videoQuoteChanged',
  'video-choice-unavailable': 'error.videoModelChoiceUnavailable',
  'sign-in': 'error.signInRequired',
  'signed-out': 'error.signInRequired',
  'insufficient-credits': 'error.creditsRequired',
  'cancelled': 'error.cancelled',
  'unknown-outcome': 'error.mediaOutcomeUnknown',
  'balance-unknown-outcome': 'error.balanceOutcomeUnknown',
  'network': 'error.networkFailure',
  'timeout': 'error.requestTimeout',
  'invalid-input': 'error.invalidInput',
  'forbidden': 'error.permissionDenied',
  'service': 'error.serviceUnavailable',
  'upstream': 'error.upstreamUnavailable',
  'local': 'error.localFailure',
  'busy': 'error.requestBusy',
  'unknown': 'error.operationFailed',
} as const

/** @param props - current tool stage and locale. @returns its preparation or dispatched card. */
export function GenericToolCard({ toolName, block, cwd, home, openFile, inspect, useDisclosure, t }: GenericToolCardProps) {
  const model = toolRowModel(toolName, block, cwd, home)
  const mediaError = mediaFailure(toolName, block)
  const pending = mediaError === 'accepted-pending' || mediaError === 'accepted-queued'
  const mediaFailureText = mediaError === null ? null : t(MEDIA_FAILURE_KEYS[mediaError])
  const mediaFailureSummary = mediaError === 'plan-parameters' ? `${toolName} · ${mediaFailureText}` : mediaFailureText
  const autoReview = model.autoReviewDenial === null
    ? null
    : localizeAutoReviewDenial(model.autoReviewDenial, t)
  const terminal = terminalCardModel(block, cwd)
  const read = readCardModel(block, cwd, home)
  const diff = diffCardModel(block)
  const search = searchCardModel(block)
  const web = webCardModel(block)
  // A failing exit status is the terminal card's own error signal (the call
  // itself settles isError:false), surfaced through the row's error summary.
  const state = model.state === 'ok' && terminal !== null && terminalFailed(terminal)
    ? 'error'
    : model.state
  const singleFile = model.filePath !== undefined
  return (
    <ToolRow
      useDisclosure={useDisclosure}
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={VARIANT_ICONS[model.variant]}
      title={t(model.titleKey)}
      summary={pending ? mediaFailureText ?? model.summary : model.summary}
      // Single-file tools never expose an args body — the path link is the only
      // args interaction. A card is not an args body: a read/write/edit row is
      // single-file AND carries a card, so the card expands under the path link.
      bodyRaw={singleFile || autoReview !== null || mediaError !== null ? null : model.bodyRaw}
      output={mediaFailureText ?? autoReview?.output ?? model.output}
      errorSummary={mediaFailureSummary ?? autoReview?.summary ?? model.errorSummary}
      terminal={terminal}
      diff={diff}
      read={read}
      search={search}
      web={web}
      state={mediaError === null ? state : pending ? 'running' : mediaError === 'cancelled' ? 'stopped' : 'error'}
      filePath={model.filePath}
      onOpenFile={singleFile ? openFile : undefined}
      inspect={mediaError === null ? inspect : undefined}
    />
  )
}
