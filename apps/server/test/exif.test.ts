import { describe, expect, it } from "vitest";
import {
  hasExifGpsData,
  orientationSwapsAxes,
  readExifOrientation,
  sanitizeJpegMetadata,
} from "../src/exif.js";

/**
 * Builds a JPEG whose Exif IFD0 carries an orientation tag and, optionally, a
 * GPS IFD pointer — the shape a phone camera produces.
 */
function jpegWithExif(options: {
  orientation?: number;
  withGps?: boolean;
  littleEndian?: boolean;
}): Buffer {
  const { orientation, withGps = false, littleEndian = false } = options;
  const entries: Array<{ tag: number; type: number; value: number }> = [];
  if (orientation !== undefined) entries.push({ tag: 0x0112, type: 3, value: orientation });
  if (withGps) entries.push({ tag: 0x8825, type: 4, value: 0 });

  const tiff = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
  tiff.write(littleEndian ? "II" : "MM", 0, "ascii");
  const u16 = (offset: number, value: number) => littleEndian
    ? tiff.writeUInt16LE(value, offset)
    : tiff.writeUInt16BE(value, offset);
  const u32 = (offset: number, value: number) => littleEndian
    ? tiff.writeUInt32LE(value, offset)
    : tiff.writeUInt32BE(value, offset);
  u16(2, 0x002a);
  u32(4, 8);
  u16(8, entries.length);
  entries.forEach((entry, index) => {
    const base = 10 + index * 12;
    u16(base, entry.tag);
    u16(base + 2, entry.type);
    u32(base + 4, 1);
    // SHORT values sit left-aligned in the 4-byte value field; LONG fills it.
    if (entry.type === 3) u16(base + 8, entry.value);
    else u32(base + 8, entry.value);
  });

  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const app1Header = Buffer.alloc(4);
  app1Header[0] = 0xff;
  app1Header[1] = 0xe1;
  app1Header.writeUInt16BE(payload.length + 2, 2);

  // A minimal but structurally valid frame: SOF0, then SOS with scan data.
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x01, 0x2c, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1Header, payload, sof0, sos, Buffer.from([0xff, 0xd9])]);
}

describe("Exif 解析与元数据剥离", () => {
  it("读取 orientation，big-endian 与 little-endian 都支持", () => {
    expect(readExifOrientation(jpegWithExif({ orientation: 6 }))).toBe(6);
    expect(readExifOrientation(jpegWithExif({ orientation: 8, littleEndian: true }))).toBe(8);
  });

  it("没有 Exif 或没有 orientation 时返回 undefined", () => {
    expect(readExifOrientation(jpegWithExif({}))).toBeUndefined();
    expect(readExifOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
  });

  it("只有 5-8 会交换宽高轴", () => {
    for (const orientation of [1, 2, 3, 4]) {
      expect(orientationSwapsAxes(orientation)).toBe(false);
    }
    for (const orientation of [5, 6, 7, 8]) {
      expect(orientationSwapsAxes(orientation)).toBe(true);
    }
    expect(orientationSwapsAxes(undefined)).toBe(false);
  });

  it("剥离 GPS 等隐私元数据，但保留 orientation", () => {
    const original = jpegWithExif({ orientation: 6, withGps: true });
    expect(hasExifGpsData(original)).toBe(true);

    const sanitized = sanitizeJpegMetadata(original);
    expect(hasExifGpsData(sanitized)).toBe(false);
    // Orientation must survive: Azure reports face rectangles against it, so
    // dropping it would silently invalidate every stored faceBox.
    expect(readExifOrientation(sanitized)).toBe(6);
    expect(sanitized.length).toBeLessThan(original.length);
    expect(sanitized.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("保留图像数据，剥离后仍是可解析的 JPEG", () => {
    const sanitized = sanitizeJpegMetadata(jpegWithExif({ orientation: 3, withGps: true }));
    // SOF0 and the SOS scan payload must both still be present.
    expect(sanitized.includes(Buffer.from([0xff, 0xc0]))).toBe(true);
    expect(sanitized.includes(Buffer.from([0xff, 0xda]))).toBe(true);
    expect(sanitized.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it("orientation=1 时不写回多余的 Exif 段", () => {
    const sanitized = sanitizeJpegMetadata(jpegWithExif({ orientation: 1, withGps: true }));
    expect(hasExifGpsData(sanitized)).toBe(false);
    expect(sanitized.includes(Buffer.from("Exif", "ascii"))).toBe(false);
  });

  it("非 JPEG 输入原样返回", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sanitizeJpegMetadata(png)).toEqual(png);
  });
});
