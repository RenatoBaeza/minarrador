// Copies the pages, their stylesheets and the app icon next to the compiled
// scripts in out/renderer — the folder Tauri serves the windows from.
// tsc only emits JavaScript, so this runs after it in `npm run build`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROM = path.join(ROOT, 'src', 'renderer');
const TO = path.join(ROOT, 'out', 'renderer');

fs.mkdirSync(TO, { recursive: true });
let copied = 0;
for (const name of fs.readdirSync(FROM)) {
  if (!/\.(html|css)$/i.test(name)) continue;
  fs.copyFileSync(path.join(FROM, name), path.join(TO, name));
  copied++;
}
fs.copyFileSync(path.join(ROOT, 'assets', 'icon.png'), path.join(TO, 'icon.png'));
console.log(`copied ${copied} page and style files and the icon to ${path.relative(ROOT, TO)}`);
