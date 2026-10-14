/**
 * Minimal declarations for the `qrcode` package: this plugin uses exactly one
 * entry point to turn a `weixin://` payment URL into a data-URL image.
 */
declare module 'qrcode' {
  export interface ToDataUrlOptions {
    margin?: number
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }

  export function toDataURL(text: string, options?: ToDataUrlOptions): Promise<string>

  const QRCode: { toDataURL: typeof toDataURL }
  export default QRCode
}
