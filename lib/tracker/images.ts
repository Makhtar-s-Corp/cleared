import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';

export function checkedImage(path, roots) {
  const file = realpathSync(path);
  const allowed = (roots || '').split(',').map((item) => item.trim()).filter(Boolean).some((root) => {
    const expanded = root.startsWith('~/') ? resolve(homedir(), root.slice(2)) : resolve(root);
    if (expanded.includes('*')) {
      const pattern = expanded.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(`[^${sep}]+`);
      return new RegExp(`^${pattern}${sep === '\\' ? '\\\\' : sep}`).test(file);
    }
    try {
      const normalized = realpathSync(expanded);
      return file.startsWith(normalized.endsWith(sep) ? normalized : normalized + sep);
    } catch { return false; }
  });
  if (!allowed) throw new Error('Capture is outside [tracker] capture_roots');
  if (statSync(file).size > 5_000_000) throw new Error('Capture exceeds 5 MB');
  const bytes = readFileSync(file);
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if (!png && !jpeg) throw new Error('Capture must be PNG or JPEG');
  return { file, bytes, mime: png ? 'image/png' : 'image/jpeg', extension: png ? 'png' : 'jpg' };
}
