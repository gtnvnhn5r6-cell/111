/* Minimal ZIP reader/writer — no dependencies.
 *
 * Writer: store-only (method 0), UTF-8 filenames. Files are small JSON
 * documents, so compression would add complexity without much benefit.
 * Reader: store + deflate, CRC checked, bounded against zip bombs.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return encoder.encode(String(value ?? ''));
}

function dosDateTime(date) {
  const stamp = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, stamp.getFullYear()));
  const time =
    (stamp.getHours() << 11) | (stamp.getMinutes() << 5) | Math.floor(stamp.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate();
  return { time, date: day };
}

/**
 * Build a ZIP Blob from `{ name, data, date? }` entries.
 * `data` may be a string, Uint8Array or ArrayBuffer.
 */
export function createZip(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('没有可打包的文件');

  const entries = [];
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const name = String(file?.name || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (!name || name.includes('\0') || name.split('/').includes('..')) {
      throw new Error('压缩包内文件名不合法');
    }

    const data = toBytes(file.data);
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const stamp = dosDateTime(file.date);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 filenames
    localView.setUint16(8, 0, true); // stored
    localView.setUint16(10, stamp.time, true);
    localView.setUint16(12, stamp.date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, stamp.time, true);
    centralView.setUint16(14, stamp.date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    localChunks.push(local, data);
    centralChunks.push(central);
    entries.push({ offset });
    offset += local.length + data.length;
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localChunks, ...centralChunks, end], { type: 'application/zip' });
}

async function inflateRaw(bytes, maxSize) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压 deflate，请用未压缩的 ZIP');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxSize) {
      await reader.cancel();
      throw new Error('ZIP 解压后超出大小限制');
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function asZipBlob(source) {
  if (source instanceof Blob) return source;
  if (source instanceof Uint8Array) return new Blob([source]);
  if (source instanceof ArrayBuffer) return new Blob([source]);
  throw new Error('不支持的 ZIP 数据');
}

async function readBlobBytes(blob, start, end) {
  if (start < 0 || end < start || end > blob.size) {
    throw new Error('ZIP 文件数据被截断');
  }
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

async function findEndOfCentralDirectory(blob) {
  const tailLength = Math.min(blob.size, 22 + 0xffff);
  const tailStart = blob.size - tailLength;
  const bytes = await readBlobBytes(blob, tailStart, blob.size);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(i + 20, true);
    if (i + 22 + commentLength > bytes.length) continue;
    return {
      totalEntries: view.getUint16(i + 10, true),
      centralSize: view.getUint32(i + 12, true),
      centralOffset: view.getUint32(i + 16, true),
    };
  }
  throw new Error('找不到 ZIP 目录，文件可能不完整');
}

/**
 * Stream ZIP entries one at a time.
 *
 * `source` may be a Blob/File (recommended: only small slices are read at a
 * time), or an in-memory Uint8Array/ArrayBuffer. Each yielded entry is
 * `{ name, data: Uint8Array }`. Set `onEntryError(error, name)` to skip a
 * damaged entry and continue with the next one.
 */
export async function* readZipEntries(source, options = {}) {
  const {
    maxEntries = 1000,
    maxFileSize = 20 * 1024 * 1024,
    maxTotalSize = 100 * 1024 * 1024,
    onEntryError = null,
  } = options;

  const blob = asZipBlob(source);
  const directory = await findEndOfCentralDirectory(blob);
  const { totalEntries, centralSize, centralOffset } = directory;

  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('暂不支持 ZIP64 格式');
  }
  if (!totalEntries) throw new Error('ZIP 是空的');
  if (totalEntries > maxEntries) throw new Error(`ZIP 内文件过多（最多 ${maxEntries} 个）`);
  if (centralOffset + centralSize > blob.size) throw new Error('ZIP 目录损坏');
  if (centralSize > 64 * 1024 * 1024) throw new Error('ZIP 目录过大');

  const central = await readBlobBytes(blob, centralOffset, centralOffset + centralSize);
  const view = new DataView(central.buffer, central.byteOffset, central.byteLength);
  let pointer = 0;
  let totalSize = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (pointer + 46 > central.length || view.getUint32(pointer, true) !== 0x02014b50) {
      throw new Error('ZIP 目录项损坏');
    }

    const flags = view.getUint16(pointer + 8, true);
    const method = view.getUint16(pointer + 10, true);
    const crc = view.getUint32(pointer + 16, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const uncompressedSize = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);

    if (pointer + 46 + nameLength > central.length) throw new Error('ZIP 文件名损坏');
    const name = decoder.decode(central.subarray(pointer + 46, pointer + 46 + nameLength));
    pointer += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (!name || name.includes('\0')) throw new Error('ZIP 内文件名不合法');

    try {
      if (flags & 0x1) throw new Error('不支持加密的 ZIP');
      if (
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localOffset === 0xffffffff
      ) {
        throw new Error('暂不支持 ZIP64 格式');
      }
      if (uncompressedSize > maxFileSize) {
        throw new Error(`文件 ${name} 太大（单个最多 ${Math.floor(maxFileSize / 1024 / 1024)} MB）`);
      }
      if (compressedSize && uncompressedSize / compressedSize > 1000) {
        throw new Error(`文件 ${name} 压缩比异常，已拒绝`);
      }

      const local = await readBlobBytes(blob, localOffset, localOffset + 30);
      const localView = new DataView(local.buffer, local.byteOffset, local.byteLength);
      if (localView.getUint32(0, true) !== 0x04034b50) {
        throw new Error('ZIP 本地文件头损坏');
      }
      const localNameLength = localView.getUint16(26, true);
      const localExtraLength = localView.getUint16(28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > blob.size) throw new Error('ZIP 文件数据被截断');

      const raw = await readBlobBytes(blob, dataStart, dataStart + compressedSize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw, maxFileSize);
      else throw new Error(`不支持的 ZIP 压缩方式（method ${method}）`);

      if (data.length !== uncompressedSize) throw new Error(`文件 ${name} 解压后大小不符`);
      if (crc32(data) !== crc) throw new Error(`文件 ${name} 校验失败`);

      totalSize += data.length;
      if (totalSize > maxTotalSize) {
        throw new Error(`ZIP 解压后总大小超出限制（最多 ${Math.floor(maxTotalSize / 1024 / 1024)} MB）`);
      }

      yield { name, data };
    } catch (error) {
      if (typeof onEntryError === 'function') {
        onEntryError(error, name);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Read a ZIP file into `{ name, data: Uint8Array }` entries.
 * Kept for callers that need the whole archive; imports use
 * `readZipEntries()` so only one entry is held in memory at a time.
 */
export async function readZip(source, options = {}) {
  const files = [];
  for await (const entry of readZipEntries(source, options)) files.push(entry);
  return files;
}
