import { readFile } from 'node:fs/promises'
import { crc32 } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import decodeHeic from 'heic-decode'
import {
  normalizeReferenceImage, ReferenceImageError, REFERENCE_IMAGE_INPUT_LIMIT, REFERENCE_IMAGE_OUTPUT_LIMIT,
} from '../src/reference-image.ts'

const create = () => sharp({ create: { width: 12, height: 8, channels: 3, background: '#eb7832' } })

function bmp(): Buffer {
  const bytes = Buffer.alloc(62)
  bytes.write('BM')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(2, 18)
  bytes.writeInt32LE(1, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  bytes.writeUInt32LE(8, 34)
  bytes.set([0, 0, 255, 0, 255, 0], 54)
  return bytes
}

describe('reference image normalization', () => {
  it.each(['png', 'jpeg', 'webp', 'avif', 'gif', 'tiff'] as const)('decodes actual %s bytes into a model-readable still image', async (format) => {
    const bytes = await create().toFormat(format).toBuffer()
    const result = await normalizeReferenceImage(bytes, `照片.${format}`)
    const decoded = await sharp(result.bytes).metadata()
    expect(result).toMatchObject({ sourceFormat: format, originalName: `照片.${format}`, width: 12, height: 8, firstFrameOnly: false })
    expect(result.mediaType).toMatch(/^image\/(png|jpeg)$/u)
    expect(decoded.format).toBe(result.mediaType === 'image/png' ? 'png' : 'jpeg')
    expect(result.bytes.length).toBeLessThanOrEqual(REFERENCE_IMAGE_OUTPUT_LIMIT)
    expect(decoded.exif).toBeUndefined()
    expect(decoded.icc).toBeUndefined()
  })

  it('detects valid image bytes despite a missing or incorrect suffix', async () => {
    const source = await create().webp().toBuffer()
    for (const name of ['照片', '照片.JPG', '照片.unknown']) {
      const result = await normalizeReferenceImage(source, name)
      expect(result).toMatchObject({ originalName: name, sourceFormat: 'webp', mediaType: 'image/jpeg', converted: true })
    }
  })

  it('decodes real BMP pixels and keeps separate red and green references intact', async () => {
    const result = await normalizeReferenceImage(bmp(), 'windows照片.bmp')
    expect(result).toMatchObject({ sourceFormat: 'bmp', mediaType: 'image/jpeg', width: 2, height: 1, converted: true })
    const pixels = await sharp(result.bytes).raw().toBuffer()
    expect(pixels[0]).toBeGreaterThan(240)
    expect(pixels[1]).toBeLessThan(15)
    expect(pixels[3]).toBeLessThan(15)
    expect(pixels[4]).toBeGreaterThan(240)
  })

  it.each([1, 4, 8])('preserves palette colors in %s-bit BMPs', async (bits) => {
    const source = Buffer.alloc(66)
    bmp().copy(source, 0, 0, 54)
    source.writeUInt32LE(source.length, 2)
    source.writeUInt32LE(62, 10)
    source.writeUInt16LE(bits, 28)
    source.writeUInt32LE(4, 34)
    source.writeUInt32LE(2, 46)
    source.set([0, 0, 255, 0, 0, 255, 0, 0], 54)
    source.set(bits === 1 ? [0x40] : bits === 4 ? [0x01] : [0, 1], 62)
    const result = await normalizeReferenceImage(source, '调色板.bmp')
    const pixels = await sharp(result.bytes).raw().toBuffer()
    expect(pixels[0]).toBeGreaterThan(240)
    expect(pixels[4]).toBeGreaterThan(240)
  })

  it('retains transparency in the normalized PNG', async () => {
    const bytes = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#12345680' } }).webp({ lossless: true }).toBuffer()
    const result = await normalizeReferenceImage(bytes, '透明.webp')
    expect(result.mediaType).toBe('image/png')
    const { data, info } = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(4)
    expect(data[3]).toBe(128)
  })

  it('applies EXIF orientation and strips source metadata', async () => {
    const bytes = await create().withMetadata({ orientation: 6 }).jpeg().toBuffer()
    const result = await normalizeReferenceImage(bytes, '旋转照片.jpg')
    expect(result).toMatchObject({ width: 8, height: 12, converted: true })
    expect((await sharp(result.bytes).metadata()).orientation).toBeUndefined()
  })

  it('returns the first animation frame and explicitly reports frame reduction', async () => {
    // Two solid-color 4 × 3 frames generated locally; no third-party image content.
    const bytes = Buffer.from('R0lGODlhBAADAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAABAADAAAICAABCBxIUGBAACH5BAEKAAEALAAAAAAEAAMAgQD/AAAAAAAAAAAAAAgIAAEIHEhQYEAAOw==', 'base64')
    const result = await normalizeReferenceImage(bytes, '动图.gif')
    expect(result).toMatchObject({ firstFrameOnly: true, sourceFormat: 'gif', width: 4, height: 3 })
    const pixels = await sharp(result.bytes).raw().toBuffer()
    expect(pixels[0]).toBeGreaterThan(240)
    expect(pixels[1]).toBeLessThan(15)
  })

  it('shrinks large dimensions to model-safe bounds without enlarging smaller sources', async () => {
    const source = await sharp({ create: { width: 5000, height: 10, channels: 3, background: '#99ccff' } }).png().toBuffer()
    const result = await normalizeReferenceImage(source, '全景.png')
    expect(result).toMatchObject({ width: 4096, height: 8, converted: true })
    expect(result.bytes.length).toBeLessThanOrEqual(REFERENCE_IMAGE_OUTPUT_LIMIT)
  })

  it('rejects empty, oversized, unsupported, and corrupted uploads using safe reason codes', async () => {
    await expect(normalizeReferenceImage(Buffer.alloc(0), '空图.png')).rejects.toMatchObject({ code: 'IMAGE_EMPTY' })
    await expect(normalizeReferenceImage(Buffer.alloc(REFERENCE_IMAGE_INPUT_LIMIT + 1), '大图.png')).rejects.toMatchObject({ code: 'IMAGE_INPUT_TOO_LARGE' })
    await expect(normalizeReferenceImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'vector.svg')).rejects.toMatchObject({ code: 'IMAGE_FORMAT_UNSUPPORTED' })
    await expect(normalizeReferenceImage(Buffer.from('not an image'), '照片.PNG')).rejects.toMatchObject({ code: 'IMAGE_FORMAT_UNSUPPORTED' })
    const valid = await create().png().toBuffer()
    try {
      await normalizeReferenceImage(valid.subarray(0, 36), '客户隐私文件名.png')
      expect.unreachable('truncated image should fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ReferenceImageError)
      expect(error).toMatchObject({ code: 'IMAGE_DECODE_FAILED', message: 'IMAGE_DECODE_FAILED' })
      expect(String(error)).not.toContain('客户隐私文件名')
    }
  })

  it('refuses excessive BMP dimensions before the decoder can allocate pixels', async () => {
    const source = bmp()
    source.writeInt32LE(100_000, 18)
    source.writeInt32LE(100_000, 22)
    await expect(normalizeReferenceImage(source, '巨大.bmp')).rejects.toMatchObject({ code: 'IMAGE_PIXEL_LIMIT' })
    await expect(normalizeReferenceImage(bmp().subarray(0, 58), '损坏.bmp')).rejects.toMatchObject({ code: 'IMAGE_DECODE_FAILED' })
  })

  it('refuses excessive PNG dimensions using metadata before decoding compressed pixels', async () => {
    const bytes = await create().png().toBuffer()
    bytes.writeUInt32BE(100_000, 16)
    bytes.writeUInt32BE(100_000, 20)
    bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29)
    await expect(normalizeReferenceImage(bytes, '巨大.png')).rejects.toMatchObject({ code: 'IMAGE_PIXEL_LIMIT' })
  })

  it('decodes HEIC to a model-readable JPEG without system codec extensions', async () => {
    // A solid-color 64 × 32 image encoded locally with sips, independent of customer photos.
    const bytes = await readFile(new URL('./fixtures/reference-normalization.heic', import.meta.url))
    const result = await normalizeReferenceImage(bytes, '手机照片.heic')
    expect(result).toMatchObject({ sourceFormat: 'heic', mediaType: 'image/jpeg', converted: true, width: 64, height: 32 })
    const decoded = await sharp(result.bytes).metadata()
    expect(decoded).toMatchObject({ format: 'jpeg', width: 64, height: 32 })
    const pixels = await sharp(result.bytes).raw().toBuffer()
    expect(pixels[0]).toBeGreaterThan(230)
    expect(pixels[1]).toBeGreaterThan(85)
    expect(pixels[1]).toBeLessThan(115)
  })

  it('checks the actual HEIC image dimensions before allocating pixels and frees every parsed image', async () => {
    const bytes = await readFile(new URL('./fixtures/reference-normalization.heic', import.meta.url))
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 64, height: 32 })
    const decode = vi.fn(async () => ({ width: 10_000, height: 10_000, data: new Uint8ClampedArray(0) }))
    const dispose = vi.fn()
    const images = Object.assign([
      { width: 10_000, height: 10_000, decode },
      { width: 64, height: 32, decode },
    ], { dispose })
    const all = vi.spyOn(decodeHeic, 'all').mockResolvedValueOnce(images)
    try {
      await expect(normalizeReferenceImage(bytes, '多图.heic')).rejects.toMatchObject({ code: 'IMAGE_PIXEL_LIMIT' })
      expect(decode).not.toHaveBeenCalled()
      expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
      all.mockRestore()
    }
  })

  it('frees parsed HEIC images when pixel decoding fails', async () => {
    const bytes = await readFile(new URL('./fixtures/reference-normalization.heic', import.meta.url))
    const decode = vi.fn(async () => { throw new Error('decoder failed') })
    const dispose = vi.fn()
    const images = Object.assign([{ width: 64, height: 32, decode }], { dispose })
    const all = vi.spyOn(decodeHeic, 'all').mockResolvedValueOnce(images)
    try {
      await expect(normalizeReferenceImage(bytes, '损坏图.heic')).rejects.toMatchObject({ code: 'IMAGE_DECODE_FAILED' })
      expect(decode).toHaveBeenCalledTimes(1)
      expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
      all.mockRestore()
    }
  })
})
