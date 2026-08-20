'use strict';

// The renderer runs under CSP `script-src 'self'`, so it can only load scripts
// from inside src/. Copy the pdf.js legacy build there after install.

const fs = require('fs');
const path = require('path');

const pkg = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist');
const from = path.join(pkg, 'legacy', 'build');
const to = path.join(__dirname, '..', 'src', 'vendor');

if (!fs.existsSync(pkg)) {
  console.warn('[vendor-pdfjs] pdfjs-dist not found at', pkg, '- skipping.');
  process.exit(0);
}

fs.mkdirSync(to, { recursive: true });

for (const name of ['pdf.mjs', 'pdf.worker.mjs']) {
  const src = path.join(from, name);
  if (!fs.existsSync(src)) {
    console.warn('[vendor-pdfjs] missing', src);
    continue;
  }
  fs.copyFileSync(src, path.join(to, name));
  console.log('[vendor-pdfjs] copied', name);
}

// CJK character maps and the Type1 substitutes. Without these, books that embed
// non-Latin or non-embedded fonts render with missing glyphs on the cover.
for (const dir of ['cmaps', 'standard_fonts']) {
  const src = path.join(pkg, dir);
  if (!fs.existsSync(src)) {
    console.warn('[vendor-pdfjs] missing', src);
    continue;
  }
  fs.cpSync(src, path.join(to, dir), { recursive: true });
  console.log('[vendor-pdfjs] copied', dir + '/');
}
