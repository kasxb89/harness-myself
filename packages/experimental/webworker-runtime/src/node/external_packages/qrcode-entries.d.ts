/** Narrow declarations for qrcode's pure rendering entries used by the Worker. */
declare module 'qrcode/lib/core/qrcode.js' {
  interface QrMatrix {
    readonly modules: { readonly size: number; readonly data: Uint8Array }
  }
  interface Options {
    margin?: number
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }
  const QRCode: { create(text: string, options?: Options): QrMatrix }
  export default QRCode
}

declare module 'qrcode/lib/renderer/svg-tag.js' {
  import type QRCode from 'qrcode/lib/core/qrcode.js'
  const renderer: {
    render(matrix: ReturnType<typeof QRCode.create>, options?: { margin?: number; width?: number }): string
  }
  export default renderer
}
