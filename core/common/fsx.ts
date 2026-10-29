import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeAll(fd: number, data: Buffer): void {
  let off = 0;
  while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
}

export function readExact(fd: number, buf: Buffer, length: number, position: number): void {
  let off = 0;
  while (off < length) {
    const n = fs.readSync(fd, buf, off, length - off, position + off);
    if (n === 0) throw new Error('unexpected end of file');
    off += n;
  }
}

// On Windows, antivirus and indexers briefly lock freshly written files; retry the rename.
export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw err;
      sleepSync(25 * (attempt + 1));
    }
  }
}

export function tempSibling(target: string, tag: string): string {
  return `${target}.${tag}-${randomBytes(4).toString('hex')}`;
}

// Write to a temporary file in the same directory, flush it, then rename over the target.
export function writeFileAtomic(target: string, data: Buffer | string, mode = 0o644): void {
  const tmp = tempSibling(target, 'tmp');
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    writeAll(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try {
    renameWithRetry(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeJsonAtomic(target: string, value: unknown): void {
  writeFileAtomic(target, JSON.stringify(value, null, 2) + '\n');
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function isCaseInsensitivePlatform(platform: string): boolean {
  return platform === 'darwin' || platform === 'win32';
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r = path.resolve(p);
    try {
      r = fs.realpathSync.native(r);
    } catch {
      // keep the resolved path when it doesn't exist
    }
    r = r.normalize('NFC').replace(/[\\/]+$/, '');
    return isCaseInsensitivePlatform(process.platform) ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export function homeRelative(p: string): string {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}
