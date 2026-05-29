import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

export function normalizeIconHex(value) {
  const hex = String(value || "").replace(/^#/, "").slice(0, 6).toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : "";
}

export function normalizeIconColors(values, fallback = "") {
  const source = Array.isArray(values) ? values : [values];
  const colors = [];
  for (const value of source) {
    const color = normalizeIconHex(value);
    if (color && !colors.includes(color)) colors.push(color);
  }

  const fallbackColor = normalizeIconHex(fallback);
  if (colors.length === 0 && fallbackColor) colors.push(fallbackColor);
  return colors;
}

export function normalizeIconColorType(value, colorCount) {
  if (colorCount < 2) return "single";
  const raw = String(value || "").toLowerCase();
  if (raw === "multi" || raw === "multicolor" || raw === "多色" || raw === "1") return "multi";
  if (raw === "gradient" || raw === "渐变" || raw === "0") return "gradient";
  return "gradient";
}

export function iconColorTypeLabel(value) {
  switch (value) {
    case "multi":
      return "多色";
    case "gradient":
      return "渐变";
    default:
      return "单色";
  }
}

export function colorIconDescriptor({ color = "", colors = [], colorType = "" } = {}) {
  const normalizedColors = normalizeIconColors(colors, color);
  const normalizedType = normalizeIconColorType(colorType, normalizedColors.length);
  const primary = normalizedColors[0] || normalizeIconHex(color);
  if (!primary) return null;

  return {
    key: `${normalizedType}:${normalizedColors.join(",")}`,
    colorType: normalizedType,
    colors: normalizedColors,
    primary
  };
}

function rgbFromHex(hex) {
  const normalized = normalizeIconHex(hex).slice(1);
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ];
}

function interpolate(left, right, ratio) {
  return [
    Math.round(left[0] + (right[0] - left[0]) * ratio),
    Math.round(left[1] + (right[1] - left[1]) * ratio),
    Math.round(left[2] + (right[2] - left[2]) * ratio)
  ];
}

function rgbForPixel(descriptor, x, width) {
  const colors = descriptor.colors.map(rgbFromHex);
  if (colors.length === 1 || descriptor.colorType === "single") return colors[0];

  if (descriptor.colorType === "multi") {
    const index = Math.min(colors.length - 1, Math.floor((x / width) * colors.length));
    return colors[index];
  }

  const spanCount = colors.length - 1;
  const position = width <= 1 ? 0 : (x / (width - 1)) * spanCount;
  const leftIndex = Math.min(spanCount - 1, Math.floor(position));
  const ratio = position - leftIndex;
  return interpolate(colors[leftIndex], colors[leftIndex + 1], ratio);
}

export function renderColorIconPng(descriptor, { width = 64, height = 64 } = {}) {
  if (!descriptor?.primary) return null;

  const scanlineLength = 1 + width * 4;
  const raw = Buffer.alloc(scanlineLength * height);

  for (let y = 0; y < height; y += 1) {
    const row = y * scanlineLength;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = rgbForPixel(descriptor, x, width);
      const offset = row + 1 + x * 4;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
      raw[offset + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND")
  ]);
}
