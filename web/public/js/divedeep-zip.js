(function attachDiveDeepZip(root) {
  'use strict';

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function le16(value) {
    return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
  }

  function le32(value) {
    const number = value >>> 0;
    return new Uint8Array([number & 0xff, (number >>> 8) & 0xff, (number >>> 16) & 0xff, (number >>> 24) & 0xff]);
  }

  function joinBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function safeEntryName(value) {
    const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const segments = normalized.split('/');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || segments.includes('..')) {
      throw new Error(`Unsafe ZIP entry name: ${normalized || '<empty>'}`);
    }
    return normalized;
  }

  function createStoredZipBytes(entries) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('ZIP entries are required.');
    const encoder = new TextEncoder();
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;
    for (const entry of entries) {
      const normalizedName = safeEntryName(entry.name);
      const name = encoder.encode(normalizedName);
      const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      const checksum = crc32(data);
      const localHeader = joinBytes([
        le32(0x04034b50), le16(20), le16(0x0800), le16(0), le16(0), le16(0),
        le32(checksum), le32(data.length), le32(data.length), le16(name.length), le16(0), name,
      ]);
      localChunks.push(localHeader, data);
      centralChunks.push(joinBytes([
        le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(0), le16(0), le16(0),
        le32(checksum), le32(data.length), le32(data.length), le16(name.length), le16(0), le16(0),
        le16(0), le16(0), le32(0), le32(offset), name,
      ]));
      offset += localHeader.length + data.length;
    }
    const central = joinBytes(centralChunks);
    return joinBytes([
      ...localChunks,
      central,
      le32(0x06054b50), le16(0), le16(0), le16(entries.length), le16(entries.length),
      le32(central.length), le32(offset), le16(0),
    ]);
  }

  function createStoredZipBlob(entries) {
    return new Blob([createStoredZipBytes(entries)], { type: 'application/zip' });
  }

  function mimeForName(name) {
    const lower = String(name || '').toLowerCase();
    if (lower.endsWith('.json')) return 'application/json';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'application/octet-stream';
  }

  function findEndOfCentralDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) !== 0x06054b50) continue;
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.byteLength) return offset;
    }
    return -1;
  }

  async function inflateRaw(bytes) {
    if (typeof root.DecompressionStream !== 'function') {
      throw new Error('This browser cannot open compressed ZIP files. Use a current Chromium, Firefox, or Safari release, or select the extracted folder.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new root.DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function extractZipFile(file, options = {}) {
    if (!file || typeof file.slice !== 'function' || typeof file.size !== 'number') throw new Error('A ZIP file is required.');
    const maxArchiveBytes = Number(options.maxArchiveBytes) || 550 * 1024 * 1024;
    const maxExpandedBytes = Number(options.maxExpandedBytes) || 525 * 1024 * 1024;
    const maxEntryBytes = Number(options.maxEntryBytes) || 25 * 1024 * 1024;
    const maxEntries = Number(options.maxEntries) || 2100;
    if (file.size < 22) throw new Error('The selected ZIP is empty or incomplete.');
    if (file.size > maxArchiveBytes) throw new Error('The selected ZIP exceeds the 550 MB import limit.');

    const tailStart = Math.max(0, file.size - 65557);
    const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
    const eocdOffset = findEndOfCentralDirectory(tail);
    if (eocdOffset < 0) throw new Error('The selected file is not a supported ZIP archive.');
    const eocd = new DataView(tail.buffer, tail.byteOffset + eocdOffset, 22);
    const diskNumber = eocd.getUint16(4, true);
    const centralDisk = eocd.getUint16(6, true);
    const entriesOnDisk = eocd.getUint16(8, true);
    const totalEntries = eocd.getUint16(10, true);
    const centralSize = eocd.getUint32(12, true);
    const centralOffset = eocd.getUint32(16, true);
    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) throw new Error('Multi-volume ZIP archives are not supported.');
    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported; rebuild the DiveDeep bundle with standard limits.');
    if (!totalEntries || totalEntries > maxEntries) throw new Error(`The ZIP contains an invalid number of entries (${totalEntries}).`);
    if (centralOffset + centralSize > file.size) throw new Error('The ZIP central directory is incomplete.');

    const centralBytes = new Uint8Array(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
    const central = new DataView(centralBytes.buffer, centralBytes.byteOffset, centralBytes.byteLength);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const records = [];
    const names = new Set();
    let offset = 0;
    let expandedTotal = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      if (offset + 46 > centralBytes.length || central.getUint32(offset, true) !== 0x02014b50) throw new Error('The ZIP central directory is malformed.');
      const flags = central.getUint16(offset + 8, true);
      const method = central.getUint16(offset + 10, true);
      const checksum = central.getUint32(offset + 16, true);
      const compressedSize = central.getUint32(offset + 20, true);
      const uncompressedSize = central.getUint32(offset + 24, true);
      const nameLength = central.getUint16(offset + 28, true);
      const extraLength = central.getUint16(offset + 30, true);
      const commentLength = central.getUint16(offset + 32, true);
      const localOffset = central.getUint32(offset + 42, true);
      const recordLength = 46 + nameLength + extraLength + commentLength;
      if (offset + recordLength > centralBytes.length) throw new Error('The ZIP entry table is truncated.');
      if (flags & 0x0001) throw new Error('Password-protected ZIP archives are not supported.');
      if (![0, 8].includes(method)) throw new Error(`ZIP compression method ${method} is not supported.`);
      if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) throw new Error('ZIP64 entries are not supported.');
      const rawName = centralBytes.subarray(offset + 46, offset + 46 + nameLength);
      const name = safeEntryName(decoder.decode(rawName));
      offset += recordLength;
      if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.endsWith('/.DS_Store') || name === '.DS_Store') continue;
      if (names.has(name)) throw new Error(`The ZIP contains a duplicate entry: ${name}`);
      names.add(name);
      if (!uncompressedSize || uncompressedSize > maxEntryBytes) throw new Error(`ZIP entry ${name} exceeds the 25 MB per-file import limit.`);
      expandedTotal += uncompressedSize;
      if (expandedTotal > maxExpandedBytes) throw new Error('The ZIP exceeds the 525 MB expanded import limit.');
      records.push({ name, flags, method, checksum, compressedSize, uncompressedSize, localOffset });
    }
    if (!records.length) throw new Error('The ZIP does not contain importable files.');

    const entries = [];
    for (const record of records) {
      const localHeaderBytes = new Uint8Array(await file.slice(record.localOffset, record.localOffset + 30).arrayBuffer());
      if (localHeaderBytes.length !== 30 || new DataView(localHeaderBytes.buffer, localHeaderBytes.byteOffset, 30).getUint32(0, true) !== 0x04034b50) {
        throw new Error(`ZIP entry ${record.name} has an invalid local header.`);
      }
      const local = new DataView(localHeaderBytes.buffer, localHeaderBytes.byteOffset, 30);
      const localNameLength = local.getUint16(26, true);
      const localExtraLength = local.getUint16(28, true);
      const dataOffset = record.localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + record.compressedSize > file.size) throw new Error(`ZIP entry ${record.name} is truncated.`);
      const compressed = new Uint8Array(await file.slice(dataOffset, dataOffset + record.compressedSize).arrayBuffer());
      const bytes = record.method === 0 ? compressed : await inflateRaw(compressed);
      if (bytes.length !== record.uncompressedSize) throw new Error(`ZIP entry ${record.name} has an invalid expanded size.`);
      if (crc32(bytes) !== record.checksum) throw new Error(`ZIP entry ${record.name} failed CRC verification.`);
      const fileName = record.name.split('/').pop();
      entries.push({
        path: record.name,
        file: new File([bytes], fileName, { type: mimeForName(record.name), lastModified: file.lastModified || Date.now() }),
      });
    }
    return entries;
  }

  const api = { crc32, createStoredZipBytes, createStoredZipBlob, extractZipFile };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DiveDeepZip = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
