const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type ZipEntry = {
  path: string;
  data: Uint8Array;
};

const crcTable = new Uint32Array(256);
for (let i = 0; i < crcTable.length; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[i] = c >>> 0;
}

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of data) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function uint16(value: number) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concat(parts: Uint8Array[]) {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function assertZipSize(value: number, label: string) {
  if (value > 0xffffffff) throw new Error(`${label} is too large for ZIP32.`);
}

export function createZipBlob(entries: ZipEntry[]) {
  const fileParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.path);
    const data = entry.data;
    const crc = crc32(data);

    if (nameBytes.byteLength > 0xffff) throw new Error(`ZIP path is too long: ${entry.path}`);
    assertZipSize(data.byteLength, entry.path);
    assertZipSize(offset, "ZIP offset");

    const localHeader = concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(crc),
      uint32(data.byteLength),
      uint32(data.byteLength),
      uint16(nameBytes.byteLength),
      uint16(0),
      nameBytes,
    ]);

    fileParts.push(localHeader, data);

    const centralHeader = concat([
      uint32(0x02014b50),
      uint16(20),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(crc),
      uint32(data.byteLength),
      uint32(data.byteLength),
      uint16(nameBytes.byteLength),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0),
      uint32(offset),
      nameBytes,
    ]);

    centralParts.push(centralHeader);
    offset += localHeader.byteLength + data.byteLength;
  }

  const centralOffset = offset;
  const centralDirectory = concat(centralParts);
  const endRecord = concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(centralDirectory.byteLength),
    uint32(centralOffset),
    uint16(0),
  ]);

  return new Blob([...fileParts, centralDirectory, endRecord], { type: "application/x-minipaint" });
}

export async function readZipEntries(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<string, Uint8Array>();

  let endOffset = -1;
  for (let i = bytes.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      endOffset = i;
      break;
    }
  }

  if (endOffset < 0) throw new Error("Invalid project file: ZIP end record not found.");

  const entryCount = view.getUint16(endOffset + 10, true);
  let centralOffset = view.getUint32(endOffset + 16, true);

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(centralOffset, true) !== 0x02014b50) {
      throw new Error("Invalid project file: bad ZIP central directory.");
    }

    const flags = view.getUint16(centralOffset + 8, true);
    const method = view.getUint16(centralOffset + 10, true);
    const compressedSize = view.getUint32(centralOffset + 20, true);
    const uncompressedSize = view.getUint32(centralOffset + 24, true);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localOffset = view.getUint32(centralOffset + 42, true);

    if (method !== 0) throw new Error("Unsupported project file: ZIP compression is not supported yet.");
    if (compressedSize !== uncompressedSize) throw new Error("Invalid project file: compressed size mismatch.");

    const nameStart = centralOffset + 46;
    const name = textDecoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    if ((flags & 0x0800) === 0 && /[^\x00-\x7f]/.test(name)) {
      throw new Error("Unsupported project file: non-UTF8 ZIP path.");
    }

    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error("Invalid project file: bad ZIP local header.");
    }

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + uncompressedSize;
    entries.set(name, bytes.slice(dataStart, dataEnd));

    centralOffset = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}
