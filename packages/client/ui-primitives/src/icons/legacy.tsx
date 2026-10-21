/**
 * Size-suffixed icon exports used by dsh-better-sidebar 0.19.1. These names
 * retain their original defaults and share the current Regular artwork.
 */
import {
  IconLinkOutlineRegular, IconRefreshOutlineRegular, IconSendOutlineRegular, IconWarningOutlineRegular,
} from './index.tsx'
import type { IconProps } from './props.ts'

export {
  IconApiOutlineRegular as IconApiOutline14,
  IconBrowseOutlineRegular as IconBrowseOutline16,
  IconCheckOutlineRegular as IconCheckOutline16,
  IconChevronDownOutlineRegular as IconChevronDownOutline14,
  IconChevronLeftOutlineRegular as IconChevronLeftOutline14,
  IconChevronRightOutlineRegular as IconChevronRightOutline14,
  IconCloseFillRegular as IconCloseFill14,
  IconCloseOutlineRegular as IconCloseOutline16,
  IconCodeOutlineRegular as IconCodeOutline16,
  IconCopyOutlineRegular as IconCopyOutline16,
  IconDownloadOutlineRegular as IconDownloadOutline16,
  IconEditOutlineRegular as IconEditOutline16,
  IconFolderOpenRegular as IconFolderOpen16,
  IconLinkOutlineRegular as IconLinkOutline16,
  IconListPenOutlineRegular as IconListPenOutline16,
  IconNewChatOutlineRegular as IconNewChatOutline16,
  IconPanelLeftOutlineRegular as IconPanelLeftOutline16,
  IconPlusOutlineRegular as IconPlusOutline16,
  IconRefreshOutlineRegular as IconRefreshOutline16,
  IconRightUpOutlineRegular as IconRightUpOutline16,
  IconSearchOutlineRegular as IconSearchOutline16,
  IconSettingsOutlineRegular as IconSettingsOutline16,
  IconSparkleRegular as IconSparkle16,
  IconStopFillRegular as IconStopFill16,
  IconTrashOutlineRegular as IconTrashOutline16,
} from './index.tsx'

/**
 * Legacy link glyph with a 14px default.
 * @param props - Icon size and layout class.
 * @returns the Regular link artwork at the requested size.
 */
export const IconLinkOutline14 = ({ size = 14, ...props }: IconProps) => (
  <IconLinkOutlineRegular {...props} size={size} />
)

/**
 * Legacy refresh glyph with a 14px default.
 * @param props - Icon size and layout class.
 * @returns the Regular refresh artwork at the requested size.
 */
export const IconRefreshOutline14 = ({ size = 14, ...props }: IconProps) => (
  <IconRefreshOutlineRegular {...props} size={size} />
)

/**
 * Legacy send glyph with a 16px default; the modern export defaults to 14px.
 * @param props - Icon size and layout class.
 * @returns the Regular send artwork at the requested size.
 */
export const IconSendOutline16 = ({ size = 16, ...props }: IconProps) => (
  <IconSendOutlineRegular {...props} size={size} />
)

/**
 * Legacy warning glyph with its original 14px default despite its 16 suffix.
 * @param props - Icon size and layout class.
 * @returns the Regular circled-warning artwork at the requested size.
 */
export const IconWarningOutline16 = ({ size = 14, ...props }: IconProps) => (
  <IconWarningOutlineRegular {...props} size={size} />
)
