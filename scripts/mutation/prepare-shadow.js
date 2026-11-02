'use strict';

// Pilot mutacji: StrykerJS nie rozpoznaje rozszerzenia `.gs`, więc przed uruchomieniem
// robimy kopie `.stryker-shadow/<Nazwa>.js` z plików `src/*.gs` (zob. vm-preload.js).
// Użycie: node scripts/mutation/prepare-shadow.js WordPress.gs [Inny.gs ...]
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SHADOW = path.join(ROOT, '.stryker-shadow');

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('Podaj nazwy plików z src/, np. WordPress.gs');
  process.exit(2);
}

fs.rmSync(SHADOW, { recursive: true, force: true });
fs.mkdirSync(SHADOW, { recursive: true });
for (const name of names) {
  if (!/^[A-Za-z0-9]+\.gs$/.test(name)) {
    console.error(`Nieprawidłowa nazwa pliku: ${name}`);
    process.exit(2);
  }
  fs.copyFileSync(path.join(ROOT, 'src', name), path.join(SHADOW, name.replace(/\.gs$/, '.js')));
  console.log(`${name} -> .stryker-shadow/${name.replace(/\.gs$/, '.js')}`);
}
