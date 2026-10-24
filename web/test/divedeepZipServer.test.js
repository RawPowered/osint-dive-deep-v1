const assert = require('assert/strict');
const zlib = require('zlib');
const { crc32, extractZipBuffer } = require('../src/services/diveDeepZipServer');
const browserZip = require('../public/js/divedeep-zip');

function le16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function le32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; }
function deflatedZip(name, content) {
  const nameBytes = Buffer.from(name);
  const raw = Buffer.from(content);
  const compressed = zlib.deflateRawSync(raw);
  const checksum = crc32(raw);
  const local = Buffer.concat([
    Buffer.from('504b0304', 'hex'), le16(20), le16(0), le16(8), le16(0), le16(0),
    le32(checksum), le32(compressed.length), le32(raw.length), le16(nameBytes.length), le16(0), nameBytes, compressed,
  ]);
  const central = Buffer.concat([
    Buffer.from('504b0102', 'hex'), le16(20), le16(20), le16(0), le16(8), le16(0), le16(0),
    le32(checksum), le32(compressed.length), le32(raw.length), le16(nameBytes.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(0), nameBytes,
  ]);
  const eocd = Buffer.concat([
    Buffer.from('504b0506', 'hex'), le16(0), le16(0), le16(1), le16(1), le32(central.length), le32(local.length), le16(0),
  ]);
  return Buffer.concat([local, central, eocd]);
}

const stored = Buffer.from(browserZip.createStoredZipBytes([
  { name: 'manifest.json', data: Buffer.from('{"packetType":"divedeep.recon-result-manifest"}') },
  { name: 'findings/findings-0001.json', data: Buffer.from('{"findings":[]}') },
]));
const storedResult = extractZipBuffer(stored);
assert.equal(storedResult.entries.get('manifest.json').toString(), '{"packetType":"divedeep.recon-result-manifest"}');
assert.equal(storedResult.entries.get('findings/findings-0001.json').toString(), '{"findings":[]}');

const deflated = deflatedZip('evidence/ev_test.txt', 'durable background import');
const deflatedResult = extractZipBuffer(deflated);
assert.equal(deflatedResult.entries.get('evidence/ev_test.txt').toString(), 'durable background import');

const unsafe = deflatedZip('../manifest.json', '{}');
assert.throws(() => extractZipBuffer(unsafe), /Unsafe ZIP entry name/);
console.log('DiveDeep server ZIP tests passed');
