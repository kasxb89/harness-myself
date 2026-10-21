/** QR payment images rendered with qrcode's pure matrix and SVG implementation, without Node PNG codecs. */
import { notImplementedFail } from '../notImplementedFail.ts'
import QRCode from 'qrcode/lib/core/qrcode.js'
import SvgRenderer from 'qrcode/lib/renderer/svg-tag.js'

/** Image options used by the payment-order routes. */
export interface QrCodeOptions {
  margin?: number
  width?: number
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
}

/**
 * Render the encoded QR matrix as a browser-displayable SVG data URL.
 * @param text - Text encoded into the QR matrix, never inserted into the SVG markup.
 * @param options - Margin, image width, and QR error-correction level.
 * @returns The percent-encoded SVG image URI.
 */
export async function toDataURL(text: string, options?: QrCodeOptions): Promise<string> {
  const matrix = QRCode.create(text, options)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SvgRenderer.render(matrix, options))}`
}

/** Node PNG buffers used by native IM transports require a Node Host. */
export const toBuffer = notImplementedFail('qrcode', 'toBuffer')

/** CommonJS interop marker consumed by the worker module loader. */
export const __esModule = true

/** The payment routes' QR image API. */
export default { toDataURL, toBuffer }
