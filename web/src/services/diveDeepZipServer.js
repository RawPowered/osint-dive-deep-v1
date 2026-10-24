const zlib = require('zlib');

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function zipError(message, code = 'DIVEDEEP_IMPORT_ZIP_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeEntryName(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || segments.includes('..')) {
    throw zipError(`Unsafe ZIP entry name: ${normalized || '<empty>'}`);
  }
  return normalized;
}

function normalizeBundlePath(value) {
  const raw = safeEntryName(value).replace(/^\/+/, '');
  if (raw === 'manifest.json' || raw.endsWith('/manifest.json')) return 'manifest.json';
  const findingIndex = raw.lastIndexOf('/findings/');
  if (findingIndex >= 0) return raw.slice(findingIndex + 1);
  if (raw.startsWith('findings/')) return raw;
  const evidenceIndex = raw.lastIndexOf('/evidence/');
  if (evidenceIndex >= 0) return raw.slice(evidenceIndex + 1);
  if (raw.startsWith('evidence/')) return raw;
  const baseName = raw.split('/').pop();
  if (/^findings-\d+\.json$/i.test(baseName)) return `findings/${baseName}`;
  if (/^ev_[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(baseName)) return `evidence/${baseName}`;
  return baseName;
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  return -1;
}

function extractZipBuffer(input, options = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const maxArchiveBytes = Number(options.maxArchiveBytes) || 150 * 1024 * 1024;
  const maxExpandedBytes = Number(options.maxExpandedBytes) || 250 * 1024 * 1024;
  const maxEntryBytes = Number(options.maxEntryBytes) || 25 * 1024 * 1024;
  const maxEntries = Number(options.maxEntries) || 2100;
  if (buffer.length < 22) throw zipError('The uploaded ZIP is empty or incomplete.');
  if (buffer.length > maxArchiveBytes) throw zipError(`The uploaded ZIP exceeds the ${Math.floor(maxArchiveBytes / 1024 / 1024)} MB server import limit.`, 'DIVEDEEP_IMPORT_ZIP_TOO_LARGE', 413);

  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw zipError('The uploaded file is not a supported ZIP archive.');
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) throw zipError('Multi-volume ZIP archives are not supported.');
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw zipError('ZIP64 archives are not supported.');
  if (!totalEntries || totalEntries > maxEntries) throw zipError(`The ZIP contains an invalid number of entries (${totalEntries}).`);
  if (centralOffset + centralSize > buffer.length) throw zipError('The ZIP central directory is incomplete.');

  const records = [];
  const names = new Set();
  let offset = centralOffset;
  let expandedTotal = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw zipError('The ZIP central directory is malformed.');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > buffer.length) throw zipError('The ZIP entry table is truncated.');
    if (flags & 0x0001) throw zipError('Password-protected ZIP archives are not supported.');
    if (![0, 8].includes(method)) throw zipError(`ZIP compression method ${method} is not supported.`);
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) throw zipError('ZIP64 entries are not supported.');
    const originalName = safeEntryName(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += recordLength;
    if (originalName.endsWith('/') || originalName.startsWith('__MACOSX/') || originalName.endsWith('/.DS_Store') || originalName === '.DS_Store') continue;
    const name = normalizeBundlePath(originalName);
    if (names.has(name)) throw zipError(`The ZIP contains a duplicate normalized entry: ${name}`);
    names.add(name);
    if (!uncompressedSize || uncompressedSize > maxEntryBytes) throw zipError(`ZIP entry ${name} exceeds the ${Math.floor(maxEntryBytes / 1024 / 1024)} MB per-file import limit.`);
    expandedTotal += uncompressedSize;
    if (expandedTotal > maxExpandedBytes) throw zipError(`The ZIP exceeds the ${Math.floor(maxExpandedBytes / 1024 / 1024)} MB expanded import limit.`);
    records.push({ name, flags, method, checksum, compressedSize, uncompressedSize, localOffset });
  }
  if (!records.length) throw zipError('The ZIP does not contain importable files.');

  const entries = new Map();
  for (const record of records) {
    if (record.localOffset + 30 > buffer.length || buffer.readUInt32LE(record.localOffset) !== 0x04034b50) {
      throw zipError(`ZIP entry ${record.name} has an invalid local header.`);
    }
    const localNameLength = buffer.readUInt16LE(record.localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(record.localOffset + 28);
    const dataOffset = record.localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + record.compressedSize > buffer.length) throw zipError(`ZIP entry ${record.name} is truncated.`);
    const compressed = buffer.subarray(dataOffset, dataOffset + record.compressedSize);
    let bytes;
    try {
      bytes = record.method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
    } catch (cause) {
      throw zipError(`ZIP entry ${record.name} could not be decompressed: ${cause.message}`);
    }
    if (bytes.length !== record.uncompressedSize) throw zipError(`ZIP entry ${record.name} has an invalid expanded size.`);
    if (crc32(bytes) !== record.checksum) throw zipError(`ZIP entry ${record.name} failed CRC verification.`);
    entries.set(record.name, bytes);
  }
  return { entries, archiveBytes: buffer.length, expandedBytes: expandedTotal };
}

module.exports = { crc32, safeEntryName, normalizeBundlePath, extractZipBuffer };
