// Snappy block format decoder (https://github.com/google/snappy/blob/main/format_description.txt), for the
// compressed attestation bundles GitHub links (client/provenance.ts). Decoding only; bounded by `limit`.

/** The decompressed bytes of a snappy block; throws on malformed input or output larger than `limit`. */
export function snappyDecode(input: Buffer, limit: number): Buffer {
  let pos = 0;
  // Preamble: the uncompressed length as a little-endian base-128 varint
  let length = 0;
  for (let shift = 0; ; shift += 7) {
    if (pos >= input.length || shift > 28) throw new Error('snappy: bad length');
    const b = input[pos++];
    length += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) break;
  }
  if (length > limit) throw new Error('snappy: output exceeds the limit');
  const out = Buffer.alloc(length);
  let at = 0;
  const need = (n: number) => { if (pos + n > input.length) throw new Error('snappy: truncated input'); };
  const le = (n: number) => { need(n); let v = 0; for (let i = 0; i < n; i++) v += input[pos + i] * 2 ** (8 * i); pos += n; return v; };
  while (pos < input.length) {
    const tag = input[pos++];
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      n = n < 60 ? n + 1 : le(n - 59) + 1;
      need(n);
      if (at + n > length) throw new Error('snappy: literal beyond the declared length');
      input.copy(out, at, pos, pos + n);
      pos += n; at += n;
      continue;
    }
    let n: number;
    let offset: number;
    if (kind === 1) {
      n = 4 + ((tag >> 2) & 7);
      need(1);
      offset = ((tag >> 5) << 8) | input[pos++];
    } else {
      n = (tag >> 2) + 1;
      offset = le(kind === 2 ? 2 : 4);
    }
    if (offset === 0 || offset > at || at + n > length) throw new Error('snappy: bad copy');
    // Copies may overlap their own output (a repeated run): byte by byte
    for (let i = 0; i < n; i++, at++) out[at] = out[at - offset];
  }
  if (at !== length) throw new Error('snappy: output shorter than declared');
  return out;
}
