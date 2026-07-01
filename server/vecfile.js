// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Shared binary vector-file format ("HKV1"), used by BOTH the knowledge library
// (one .vec per doc, vectors per block) and the conversation-archive embedding
// index (one .hk-embeddings.vec, one vector per archive). Single source of truth
// so the two never drift.
//
// On disk: zstd( [header][model name][pad→4B][fp32 vectors] ). fp32 = FULL precision
// (lossless cosine); zstd shrinks it (zero-vector slots compress away). The header
// records the EMBEDDING MODEL so vectors can be validated against the model a query
// uses (mismatched model → different vector space → skip / rebuild).
//   [0..4) "HKV1" | [4] dtype(0=fp32,1=fp16) | [5] version(1) | [6..8) modelLen u16
//   [8..12) dim u32 | [12..16) count u32 | [16..16+modelLen) model utf8 | pad→4B | data
// No backward-compat: bytes without this header decode as empty (re-embed to migrate).

const zlib = require("zlib");

const HAS_ZSTD = typeof zlib.zstdCompressSync === "function";
const VEC_MAGIC = "HKV1";
const VEC_HEADER = 16;
const _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
function f16to32(h) {   // read-only support for a dtype=1 (fp16) file; we always WRITE fp32
  const sign = (h & 0x8000) << 16; let exp = (h >>> 10) & 0x1f, mant = h & 0x3ff, out;
  if (exp === 0) { if (mant === 0) out = sign; else { exp = 1; while (!(mant & 0x400)) { mant <<= 1; exp--; } mant &= 0x3ff; out = sign | ((exp + 112) << 23) | (mant << 13); } }
  else if (exp === 0x1f) out = sign | 0x7f800000 | (mant << 13);
  else out = sign | ((exp + 112) << 23) | (mant << 13);
  _u32[0] = out >>> 0; return _f32[0];
}
const isZstd = (b) => b.length >= 4 && b[0] === 0x28 && b[1] === 0xB5 && b[2] === 0x2F && b[3] === 0xFD;
const isGzip = (b) => b.length >= 2 && b[0] === 0x1F && b[1] === 0x8B;
const vecDataOff = (modelLen) => (VEC_HEADER + modelLen + 3) & ~3;   // fp32 must be 4-byte aligned

// vectors: array of (Float32Array | number[] | null); null → zero row. Returns the
// compressed Buffer ready to write to disk.
function encodeVectors(vectors, model = "") {
  const dim = (vectors.find(Boolean) || []).length || 0;
  const count = vectors.length;
  const modelBuf = Buffer.from(String(model || ""), "utf-8");
  const header = Buffer.alloc(vecDataOff(modelBuf.length));   // zero-padded to 4B
  header.write(VEC_MAGIC, 0, "ascii");
  header.writeUInt8(0, 4);   // dtype 0 = fp32
  header.writeUInt8(1, 5);   // format version 1 (no backward-compat)
  header.writeUInt16LE(modelBuf.length, 6);
  header.writeUInt32LE(dim, 8);
  header.writeUInt32LE(count, 12);
  modelBuf.copy(header, VEC_HEADER);
  const flat = new Float32Array(count * dim);
  vectors.forEach((v, b) => { if (v) for (let i = 0; i < dim; i++) flat[b * dim + i] = v[i]; });
  const raw = Buffer.concat([header, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength)]);
  return HAS_ZSTD ? zlib.zstdCompressSync(raw) : zlib.gzipSync(raw);
}

// buf: raw file bytes (compressed or not). → { vectors:[Float32Array], model, dim, count }.
// Non-HKV1 (legacy/absent) → empty vectors.
function decodeVectors(buf) {
  try { if (isZstd(buf)) buf = zlib.zstdDecompressSync(buf); else if (isGzip(buf)) buf = zlib.gunzipSync(buf); } catch { /* not compressed */ }
  if (!(buf.length >= VEC_HEADER && buf.toString("ascii", 0, 4) === VEC_MAGIC)) return { vectors: [], model: "", dim: 0, count: 0 };
  const dtype = buf.readUInt8(4), modelLen = buf.readUInt16LE(6), dim = buf.readUInt32LE(8), count = buf.readUInt32LE(12);
  const model = buf.toString("utf-8", VEC_HEADER, VEC_HEADER + modelLen);
  const dataOff = vecDataOff(modelLen);
  const out = [];
  if (dtype === 1) {                       // fp16 (read-only)
    let o = dataOff;
    for (let b = 0; b < count; b++) { const v = new Float32Array(dim); for (let i = 0; i < dim; i++) { v[i] = f16to32(buf.readUInt16LE(o)); o += 2; } out.push(v); }
  } else {                                 // fp32
    const off = buf.byteOffset + dataOff;
    const flat = (off % 4 === 0)
      ? new Float32Array(buf.buffer, off, dim * count)
      : new Float32Array(Uint8Array.prototype.slice.call(buf, dataOff).buffer, 0, dim * count);
    for (let b = 0; b < count; b++) out.push(flat.slice(b * dim, (b + 1) * dim));
  }
  return { vectors: out, model, dim, count };
}

module.exports = { encodeVectors, decodeVectors, isZstd, isGzip };
