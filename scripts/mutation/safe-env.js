'use strict';

// Minimalne środowisko dla CAŁEGO drzewa procesów pilota mutacji (Stryker, loader, testy).
// To lista dozwolonych nazw (allowlista), a nie filtr po wzorcu: wszystko, czego tu nie ma, w tym
// poświadczenia i każde GIT_*, nie przechodzi do procesów potomnych.
const ALLOWED = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'CI'
];
/** Zmienne pilota, które muszą przejść (id mutanta i plik wyboru testów). */
const PILOT = ['__STRYKER_ACTIVE_MUTANT__', 'MUTATION_SELECTION'];

function safeEnv(env, extra = {}) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (ALLOWED.includes(upper) || PILOT.includes(name)) out[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (PILOT.includes(name)) out[name] = value;
    else throw new Error(`safeEnv: zmienna ${name} nie jest na liście pilota`);
  }
  for (const name of Object.keys(out)) {
    if (/^GIT_/i.test(name)) delete out[name];
  }
  return out;
}

module.exports = { safeEnv, ALLOWED, PILOT };
