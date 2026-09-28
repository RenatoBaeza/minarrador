// Copies the renderer's pages and stylesheets next to their compiled scripts.
//
// tsc only emits JavaScript, and every window loads its page with loadFile from
// out/src/renderer — where the page's <script> and <link> tags expect to find
// siblings. Run after tsc, as part of `npm run build`.

import fs from 'node:fs';
import path from 'node:path';

// Compiled to out/scripts, two levels below the checkout.
const ROOT = path.join(__dirname, '..', '..');
const FROM = path.join(ROOT, 'src', 'renderer');
const TO = path.join(ROOT, 'out', 'src', 'renderer');

const STATIC = /\.(html|css)$/i;

fs.mkdirSync(TO, { recursive: true });
let copied = 0;
for (const name of fs.readdirSync(FROM)) {
  if (!STATIC.test(name)) continue;
  fs.copyFileSync(path.join(FROM, name), path.join(TO, name));
  copied++;
}
console.log(`copied ${copied} page and style files to ${path.relative(ROOT, TO)}`);
