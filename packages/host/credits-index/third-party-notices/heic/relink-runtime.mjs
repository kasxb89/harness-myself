/** Offline maintenance for an owner's extracted application copy; never runs at startup. */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Refresh library entries only after verifying every other runtime file is unchanged.
 * @param {string} directory - Extracted dsh directory containing desktop-runtime.json.
 * @returns {number} Number of decoder files in the refreshed inventory.
 */
export function relinkRuntime(directory) {
  const root = resolve(directory);
  const descriptorPath = join(root, 'desktop-runtime.json');
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  if (descriptor.schemaVersion !== 1 || !Array.isArray(descriptor.files)
    || !['darwin', 'win32', 'linux'].includes(descriptor.platform)) {
    throw new Error('Unsupported Desktop runtime descriptor. No files changed.');
  }
  const library = /(?:^|\/)node_modules\/(?:heic-decode|libheif-js)\//u;
  if (!descriptor.files.some(file => library.test(file.path))) {
    throw new Error('This runtime contains no separately packaged HEIC decoder. No files changed.');
  }
  const files = [];
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (name === 'desktop-runtime.json' || entry.name === '.gitkeep') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, name);
      else if (entry.isFile()) {
        const body = readFileSync(path);
        files.push({ path: name, bytes: body.byteLength,
          sha256: createHash('sha256').update(body).digest('hex'),
          executable: descriptor.platform !== 'win32' && (lstatSync(path).mode & 0o111) !== 0 });
      } else throw new Error(`Unsupported filesystem entry: ${name}. No files changed.`);
    }
  };
  visit(root, '');
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const unchanged = items => items.filter(file => !library.test(file.path));
  if (JSON.stringify(unchanged(files)) !== JSON.stringify(unchanged(descriptor.files))) {
    throw new Error('Files outside heic-decode/libheif-js changed. No files changed.');
  }
  const temporary = mkdtempSync(join(dirname(root), '.heic-relink-'));
  try {
    const next = join(temporary, 'desktop-runtime.json');
    writeFileSync(next, `${JSON.stringify({ ...descriptor, files }, null, 2)}\n`);
    renameSync(next, descriptorPath);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return files.filter(file => library.test(file.path)).length;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    console.error('Usage: node relink-runtime.mjs <extracted-app/dsh>');
    process.exitCode = 1;
  } else {
    try {
      console.log(`Refreshed HEIC decoder inventory (${relinkRuntime(process.argv[2])} files).`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
