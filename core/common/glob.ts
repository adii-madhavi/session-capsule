// Small gitignore-style glob matcher.
// - A pattern without "/" matches any single path segment ("*.pem", "node_modules").
// - A pattern with "/" is anchored at the project root ("docs/private/**").
// - "**" crosses folders, "*" and "?" stay within one segment.
// A match on a folder also covers everything inside it.

interface Compiled {
  re: RegExp;
  anchored: boolean;
}

const cache = new Map<string, Compiled>();

function compile(glob: string): Compiled {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (g.endsWith('/')) g = g.slice(0, -1);
  const anchored = g.includes('/');
  if (g.startsWith('/')) g = g.slice(1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return { re: new RegExp(`^${re}$`, 'i'), anchored };
}

export function matchGlob(glob: string, relPath: string): boolean {
  let c = cache.get(glob);
  if (!c) cache.set(glob, (c = compile(glob)));
  const segs = relPath.split('/');
  if (!c.anchored) return segs.some((s) => c.re.test(s));
  for (let i = segs.length; i > 0; i--) if (c.re.test(segs.slice(0, i).join('/'))) return true;
  return false;
}

export function matchAny(globs: readonly string[], relPath: string): string | null {
  for (const g of globs) if (matchGlob(g, relPath)) return g;
  return null;
}
