const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP1 = 0xe1;
const APP2 = 0xe2;
const COMMENT = 0xfe;
const ORIENTATION_TAG = 0x0112;
const GPS_IFD_TAG = 0x8825;

/**
 * APPn segments dropped when sanitizing. APP1 carries Exif (GPS, capture time,
 * device) and XMP; APP13 carries Photoshop/IPTC records. APP0 (JFIF) and APP2
 * (ICC colour profile) are kept because they affect rendering, not privacy.
 */
function isPrivacyBearingSegment(marker: number): boolean {
  if (marker === APP1 || marker === COMMENT) return true;
  return marker >= 0xe3 && marker <= 0xef;
}

function readSegmentLength(bytes: Buffer, offset: number): number | undefined {
  if (offset + 4 > bytes.length) return undefined;
  const length = bytes.readUInt16BE(offset + 2);
  return length >= 2 ? length : undefined;
}

function findExifTiff(bytes: Buffer): { start: number; end: number } | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === SOS || marker === EOI) return undefined;
    if (marker === SOI) {
      offset += 2;
      continue;
    }
    const length = readSegmentLength(bytes, offset);
    if (length === undefined) return undefined;
    if (marker === APP1 && bytes.toString("ascii", offset + 4, offset + 8) === "Exif") {
      return { start: offset + 10, end: offset + 2 + length };
    }
    offset += 2 + length;
  }
  return undefined;
}

interface TiffView {
  buffer: Buffer;
  littleEndian: boolean;
  ifd0: number;
}

function readTiffView(bytes: Buffer, start: number, end: number): TiffView | undefined {
  const buffer = bytes.subarray(start, end);
  if (buffer.length < 8) return undefined;
  const byteOrder = buffer.toString("ascii", 0, 2);
  if (byteOrder !== "II" && byteOrder !== "MM") return undefined;
  const littleEndian = byteOrder === "II";
  const ifd0 = littleEndian ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
  if (ifd0 + 2 > buffer.length) return undefined;
  return { buffer, littleEndian, ifd0 };
}

function readIfdEntry(
  view: TiffView,
  entryOffset: number,
): { tag: number; shortValue: number } | undefined {
  const { buffer, littleEndian } = view;
  if (entryOffset + 12 > buffer.length) return undefined;
  const tag = littleEndian ? buffer.readUInt16LE(entryOffset) : buffer.readUInt16BE(entryOffset);
  // SHORT values are stored left-aligned in the 4-byte value field.
  const shortValue = littleEndian
    ? buffer.readUInt16LE(entryOffset + 8)
    : buffer.readUInt16BE(entryOffset + 8);
  return { tag, shortValue };
}

function forEachIfd0Entry(
  bytes: Buffer,
  visit: (entry: { tag: number; shortValue: number }) => void,
): void {
  const located = findExifTiff(bytes);
  if (!located) return;
  const view = readTiffView(bytes, located.start, located.end);
  if (!view) return;
  const { buffer, littleEndian, ifd0 } = view;
  const count = littleEndian ? buffer.readUInt16LE(ifd0) : buffer.readUInt16BE(ifd0);
  for (let index = 0; index < count; index += 1) {
    const entry = readIfdEntry(view, ifd0 + 2 + index * 12);
    if (!entry) return;
    visit(entry);
  }
}

/**
 * Reads the Exif orientation tag (1-8) from a JPEG, or undefined when absent.
 */
export function readExifOrientation(bytes: Buffer): number | undefined {
  let orientation: number | undefined;
  forEachIfd0Entry(bytes, (entry) => {
    if (entry.tag === ORIENTATION_TAG && entry.shortValue >= 1 && entry.shortValue <= 8) {
      orientation = entry.shortValue;
    }
  });
  return orientation;
}

/** True when the JPEG carries GPS coordinates. Used by tests and diagnostics. */
export function hasExifGpsData(bytes: Buffer): boolean {
  let found = false;
  forEachIfd0Entry(bytes, (entry) => {
    if (entry.tag === GPS_IFD_TAG) found = true;
  });
  return found;
}

/** Orientations 5-8 transpose the stored frame, so width and height swap. */
export function orientationSwapsAxes(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8;
}

function buildOrientationOnlyExif(orientation: number): Buffer {
  // TIFF header (8) + entry count (2) + one 12-byte entry + next-IFD offset (4).
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "ascii");
  tiff.writeUInt16BE(0x002a, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(ORIENTATION_TAG, 10);
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(orientation, 18); // left-aligned in the value field
  tiff.writeUInt32BE(0, 22); // no IFD1
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = APP1;
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([segment, payload]);
}

/**
 * Removes privacy-bearing JPEG metadata (GPS, capture time, device, XMP,
 * comments) while preserving the Exif orientation tag.
 *
 * Orientation must survive: Azure Face normalizes face coordinates against it,
 * and browsers need it to display the photo upright. Dropping it would rotate
 * the frame Azure reports rectangles in, silently invalidating stored faceBox
 * values. Pixels are never re-encoded, so this is lossless.
 *
 * Non-JPEG input is returned unchanged.
 */
export function sanitizeJpegMetadata(bytes: Buffer): Buffer {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return bytes;
  const orientation = readExifOrientation(bytes);
  const parts: Buffer[] = [bytes.subarray(0, 2)];
  if (orientation !== undefined && orientation !== 1) {
    parts.push(buildOrientationOnlyExif(orientation));
  }
  let offset = 2;
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return bytes; // Unparseable: keep the original.
    const marker = bytes[offset + 1]!;
    if (marker === SOS) {
      parts.push(bytes.subarray(offset));
      return Buffer.concat(parts);
    }
    if (marker === EOI) {
      parts.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (marker === SOI) {
      offset += 2;
      continue;
    }
    const length = readSegmentLength(bytes, offset);
    if (length === undefined) return bytes;
    const end = offset + 2 + length;
    if (end > bytes.length) return bytes;
    const isIccProfile = marker === APP2 &&
      bytes.toString("ascii", offset + 4, offset + 15) === "ICC_PROFILE";
    if (!isPrivacyBearingSegment(marker) || isIccProfile) {
      parts.push(bytes.subarray(offset, end));
    }
    offset = end;
  }
  return Buffer.concat(parts);
}
