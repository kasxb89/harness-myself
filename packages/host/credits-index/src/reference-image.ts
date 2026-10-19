/** Decodes uploaded reference images and produces bounded, model-readable still images. */
import sharp, { type Metadata, type Sharp } from 'sharp'
import { decode as decodeBmp } from 'bmp-ts'
import decodeHeic from 'heic-decode'

/** Maximum compressed upload bytes accepted before decoding an image. */
export const REFERENCE_IMAGE_INPUT_LIMIT = 32 * 1024 * 1024
/** Maximum normalized bytes accepted by the image and video model routes. */
export const REFERENCE_IMAGE_OUTPUT_LIMIT = 6 * 1024 * 1024
/** Pixel budget enforced before allocating a full decoded image. */
export const REFERENCE_IMAGE_PIXEL_LIMIT = 40_000_000

/** Machine-readable image upload failures; the receiving UI owns localized explanations. */
export type ReferenceImageErrorCode = 'IMAGE_EMPTY' | 'IMAGE_INPUT_TOO_LARGE' | 'IMAGE_FORMAT_UNSUPPORTED'
  | 'IMAGE_DECODE_FAILED' | 'IMAGE_PIXEL_LIMIT' | 'IMAGE_OUTPUT_TOO_LARGE' | 'IMAGE_DECODER_UNAVAILABLE'

/** A failed conversion has no persisted bytes and cannot replace an existing reference. */
export class ReferenceImageError extends Error {
  /** Stable reason available to the upload endpoint without exposing decoder diagnostics. */
  readonly code: ReferenceImageErrorCode

  /**
   * Create a safe conversion failure while preserving its diagnostic cause locally.
   * @param code Reason the receiving UI localizes.
   * @param cause Decoder failure retained for host diagnostics, never rendered directly.
   */
  constructor(code: ReferenceImageErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'ReferenceImageError'
    this.code = code
  }
}

/** Accepted source image families, detected from file bytes rather than suffixes or MIME claims. */
export type ReferenceImageFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'gif' | 'bmp' | 'tiff' | 'heic'

/** Normalization facts returned with the committed upload and its model-safe preview. */
export interface NormalizedReferenceImage {
  /** Re-encoded still image with metadata removed. */
  readonly bytes: Buffer
  /** Media type matching the actual normalized bytes. */
  readonly mediaType: 'image/png' | 'image/jpeg'
  /** Original display name, independent of the stored normalized extension. */
  readonly originalName: string
  /** Actual source format, including uploads with an incorrect or absent suffix. */
  readonly sourceFormat: ReferenceImageFormat
  /** Whether format, orientation, or dimensions changed during normalization. */
  readonly converted: boolean
  /** Whether an animation or multipage source was reduced to its first frame. */
  readonly firstFrameOnly: boolean
  /** Width of the normalized still image in pixels. */
  readonly width: number
  /** Height of the normalized still image in pixels. */
  readonly height: number
}

type ImageMetadata = Pick<Metadata, 'width' | 'height' | 'hasAlpha' | 'orientation' | 'pages' | 'pageHeight'>
  & { readonly autoOrient?: { readonly width: number; readonly height: number } }

// heic-decode 2.1.0 exposes these fields before pixel decoding; @types 2.0.0 omits them.
type HeicImageCollection = (Awaited<ReturnType<typeof decodeHeic.all>>[number]
  & { readonly width: number; readonly height: number })[] & { dispose(): void }

function detectFormat(bytes: Buffer): ReferenceImageFormat {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'gif'
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'bmp'
  if (bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0]))
    || bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))) return 'tiff'
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const boxLength = bytes.readUInt32BE(0)
    const brands = bytes.toString('ascii', 8, Math.min(bytes.length, boxLength, 128))
    if (/avif|avis/u.test(brands)) return 'avif'
    if (/heic|heix|hevc|hevx|mif1|msf1/u.test(brands)) return 'heic'
  }
  throw new ReferenceImageError('IMAGE_FORMAT_UNSUPPORTED')
}

function assertDimensions(width: number | undefined, height: number | undefined): void {
  if (width === undefined || height === undefined || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0) throw new ReferenceImageError('IMAGE_DECODE_FAILED')
  if (width * height > REFERENCE_IMAGE_PIXEL_LIMIT) throw new ReferenceImageError('IMAGE_PIXEL_LIMIT')
}

function bmpInput(bytes: Buffer): { pipeline: Sharp; metadata: ImageMetadata } {
  // bmp-ts allocates in its constructor, so inspect its fixed header before invoking the decoder.
  if (bytes.length < 54) throw new ReferenceImageError('IMAGE_DECODE_FAILED')
  const width = bytes.readInt32LE(18)
  const height = Math.abs(bytes.readInt32LE(22))
  assertDimensions(width, height)
  const headerSize = bytes.readUInt32LE(14)
  const pixelOffset = bytes.readUInt32LE(10)
  const fileSize = bytes.readUInt32LE(2)
  const bits = bytes.readUInt16LE(28)
  const compression = bytes.readUInt32LE(30)
  const paletteEntries = bytes.readUInt32LE(46)
  if (![40, 52, 56, 108, 124].includes(headerSize) || bytes.readUInt16LE(26) !== 1
    || ![1, 4, 8, 16, 24, 32].includes(bits) || ![0, 3, 6].includes(compression)
    || pixelOffset < 14 + headerSize || pixelOffset >= bytes.length || fileSize < pixelOffset || fileSize > bytes.length
    || paletteEntries > 256) throw new ReferenceImageError('IMAGE_DECODE_FAILED')
  if ((compression === 0 || compression === 3 || compression === 6)
    && pixelOffset + Math.ceil(width * bits / 32) * 4 * height > bytes.length) {
    throw new ReferenceImageError('IMAGE_DECODE_FAILED')
  }
  // The library's default output is ABGR with a reserved zero alpha for opaque BMPs.
  // Normalize it explicitly because its RGBA option does not cover paletted images.
  const decoded = decodeBmp(bytes)
  const hasAlpha = (headerSize >= 56 || compression === 6) && bytes.readUInt32LE(66) !== 0
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    const alpha = decoded.data[offset] ?? 0
    const blue = decoded.data[offset + 1] ?? 0
    const green = decoded.data[offset + 2] ?? 0
    const red = decoded.data[offset + 3] ?? 0
    decoded.data.set([red, green, blue, hasAlpha ? alpha : 255], offset)
  }
  return {
    pipeline: sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }),
    metadata: { width, height, hasAlpha, pages: 1 },
  }
}

function orientDecodedImage(pipeline: Sharp, orientation: number | undefined): Sharp {
  switch (orientation) {
    case 2: return pipeline.flop()
    case 3: return pipeline.rotate(180)
    case 4: return pipeline.flip()
    case 5: return pipeline.flip().rotate(90)
    case 6: return pipeline.rotate(90)
    case 7: return pipeline.flop().rotate(90)
    case 8: return pipeline.rotate(270)
    default: return pipeline
  }
}

/**
 * Decode by actual bytes, orient and resize, then produce a PNG/JPEG under the model upload limit.
 * Successful and failed conversions write no files; the caller owns atomic upload persistence.
 * SVG and unknown binary formats are rejected; animated and multipage files use their first frame.
 * HEIC uses the bundled libheif decoder independently of operating-system codec extensions.
 * @param bytes Compressed user upload bounded before image decoding.
 * @param originalName Original filename retained for per-file display, never used as a storage path.
 * @returns A metadata-free still image and explicit conversion facts for the upload UI.
 */
export async function normalizeReferenceImage(bytes: Buffer, originalName: string): Promise<NormalizedReferenceImage> {
  if (bytes.length === 0) throw new ReferenceImageError('IMAGE_EMPTY')
  if (bytes.length > REFERENCE_IMAGE_INPUT_LIMIT) throw new ReferenceImageError('IMAGE_INPUT_TOO_LARGE')
  const sourceFormat = detectFormat(bytes)
  let metadata: ImageMetadata
  let pipeline: Sharp
  try {
    if (sourceFormat === 'bmp') {
      ({ metadata, pipeline } = bmpInput(bytes))
    } else {
      // A header read cannot allocate an oversized decoded image. Pixel limits are applied after inspection
      // to distinguish a readable oversized file from a corrupt upload without parsing decoder messages.
      metadata = await sharp(bytes, { failOn: 'warning', limitInputPixels: false, pages: 1 }).metadata()
      assertDimensions(metadata.width, metadata.pageHeight ?? metadata.height)
      if (sourceFormat === 'heic') {
        const images = await decodeHeic.all({ buffer: bytes }) as HeicImageCollection
        let decoded: Awaited<ReturnType<typeof decodeHeic>>
        try {
          const image = images[0]
          if (image === undefined) throw new ReferenceImageError('IMAGE_DECODE_FAILED')
          // The primary image inspected by Sharp need not be libheif's first image.
          assertDimensions(image.width, image.height)
          decoded = await image.decode()
          metadata = { ...metadata, pages: images.length }
        } finally {
          images.dispose()
        }
        assertDimensions(decoded.width, decoded.height)
        if (decoded.data.length !== decoded.width * decoded.height * 4) throw new ReferenceImageError('IMAGE_DECODE_FAILED')
        pipeline = orientDecodedImage(sharp(Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength), {
          raw: { width: decoded.width, height: decoded.height, channels: 4 },
        }), metadata.orientation)
      } else {
        pipeline = sharp(bytes, { failOn: 'warning', limitInputPixels: REFERENCE_IMAGE_PIXEL_LIMIT, pages: 1 }).autoOrient()
      }
    }
  } catch (error) {
    if (error instanceof ReferenceImageError) throw error
    throw new ReferenceImageError('IMAGE_DECODE_FAILED', error)
  }
  const sourceWidth = metadata.autoOrient?.width ?? metadata.width
  const sourceHeight = metadata.autoOrient?.height ?? metadata.pageHeight ?? metadata.height
  const firstFrameOnly = (metadata.pages ?? 1) > 1
  const mediaType = metadata.hasAlpha ? 'image/png' : 'image/jpeg'
  try {
    // Bound the dimensions on each attempt without enlarging smaller references.
    for (const edge of [4096, 3072, 2048, 1024]) {
      const resized = pipeline.clone().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .timeout({ seconds: 15 })
      const { data, info } = await (mediaType === 'image/png'
        ? resized.png({ compressionLevel: 6 })
        : resized.jpeg({ quality: 90, chromaSubsampling: '4:4:4' })).toBuffer({ resolveWithObject: true })
      if (data.length <= REFERENCE_IMAGE_OUTPUT_LIMIT) {
        return {
          bytes: data, mediaType, originalName, sourceFormat, firstFrameOnly,
          width: info.width, height: info.height,
          converted: sourceFormat !== (mediaType === 'image/png' ? 'png' : 'jpeg') || firstFrameOnly
            || (metadata.orientation ?? 1) !== 1 || info.width !== sourceWidth || info.height !== sourceHeight,
        }
      }
    }
  } catch (error) {
    throw new ReferenceImageError('IMAGE_DECODE_FAILED', error)
  }
  throw new ReferenceImageError('IMAGE_OUTPUT_TOO_LARGE')
}
