// A minimal tar writer: `docker cp -` takes a tar stream, which keeps the file modes (executable bits) the
// same on every client OS, Windows included; `docker load` takes uploaded images as one (image-store.ts).

export interface TarEntry {
  /** Path inside the archive, relative, with "/" separators. */
  name: string;
  mode: number;
  data: string | Buffer;
}

function field(buf: Buffer, offset: number, length: number, value: string) {
  buf.write(value, offset, length, 'utf8');
}

function octal(buf: Buffer, offset: number, length: number, value: number) {
  field(buf, offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
}

/** The 512-byte header of a regular file owned by root; the data and padding to 512 bytes follow it. */
export function tarHeader(name: string, mode: number, size: number, mtime = Math.floor(Date.now() / 1000)): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar: name too long: ${name}`);
  if (size >= 8 * 1024 ** 3) throw new Error(`tar: file too large: ${name}`);
  const h = Buffer.alloc(512);
  field(h, 0, 100, name);
  octal(h, 100, 8, mode);
  octal(h, 108, 8, 0); // uid: root
  octal(h, 116, 8, 0); // gid
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime);
  field(h, 148, 8, '        '); // checksum is computed with this field as spaces
  field(h, 156, 1, '0'); // regular file
  field(h, 257, 6, 'ustar\0');
  field(h, 263, 2, '00');
  let sum = 0;
  for (const b of h) sum += b;
  field(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

export const tarPadding = (size: number) => Buffer.alloc((512 - (size % 512)) % 512);
/** Two empty blocks end an archive. */
export const TAR_END = Buffer.alloc(1024);

export function tarOf(entries: TarEntry[], mtime = Math.floor(Date.now() / 1000)): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    parts.push(tarHeader(e.name, e.mode, data.length, mtime), data, tarPadding(data.length));
  }
  parts.push(TAR_END);
  return Buffer.concat(parts);
}
