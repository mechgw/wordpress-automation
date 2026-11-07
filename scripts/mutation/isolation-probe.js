'use strict';

// Sondy izolacji przed uruchomieniem jakiegokolwiek mutanta (wymóg #234, fail-closed): przebieg
// mutacyjny rusza tylko wtedy, gdy KAŻDA sonda potwierdzi odcięcie. Brak odcięcia = wynik
// `no-go-izolacja` i brak biegu; nie ma flagi, która to wyłącza.
//   1. sieć: połączenie TCP z publicznym adresem musi się nie udać,
//   2. zapis poza katalogiem przebiegu: plik kontrolny w katalogu nadrzędnym musi się nie zapisać,
//   3. odczyt konfiguracji użytkownika (np. ~/.npmrc, ~/.gitconfig, ~/.ssh) musi się nie udać,
//   4. otoczenie: brak poświadczeń, GIT_* i plików .clasp*.
// Użycie: node scripts/mutation/isolation-probe.js   (kod wyjścia 0 = izolacja potwierdzona)
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SECRET_NAME = /TOKEN|SECRET|PASS|KEY|CRED|AUTH|^CC_|^CLAUDE|^GOOGLE|^GH_|^GITHUB|^NPM_/i;

function connectSucceeds(host, port, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

function canWriteOutside() {
  const target = path.join(path.dirname(ROOT), `.mutation-probe-${process.pid}`);
  try {
    fs.writeFileSync(target, 'x');
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

function readableUserConfig() {
  const home = os.homedir();
  return ['.npmrc', '.gitconfig', '.ssh', '.config'].map(n => path.join(home, n)).filter(p => {
    try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; }
  });
}

async function probe(env = process.env) {
  const failures = [];
  for (const [host, port] of [['1.1.1.1', 443], ['8.8.8.8', 53]]) {
    if (await connectSucceeds(host, port, 3000)) failures.push(`sieć nie jest odcięta (połączenie z ${host}:${port} się udało)`);
  }
  if (canWriteOutside()) failures.push('zapis poza katalogiem przebiegu jest możliwy (katalog nadrzędny repozytorium)');
  const readable = readableUserConfig();
  if (readable.length) failures.push(`odczyt konfiguracji użytkownika jest możliwy (${readable.map(p => path.basename(p)).join(', ')})`);
  const secrets = Object.keys(env).filter(n => SECRET_NAME.test(n) || /^GIT_/i.test(n));
  if (secrets.length) failures.push(`w otoczeniu są zmienne z poświadczeniami lub GIT_*: ${secrets.length} szt.`);
  if (fs.readdirSync(ROOT).some(n => /^\.clasp/.test(n) && n !== '.claspignore')) failures.push('w katalogu repozytorium są pliki .clasp*');
  return failures;
}

/** Używane przez run-file.js i validate-selection.js: kończy proces kodem 3, gdy izolacji brak. */
function assertIsolatedSync() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'isolation-probe.js')], { encoding: 'utf8', env: process.env });
  if (r.status !== 0) {
    console.error(['no-go-izolacja: przebieg mutacyjny NIE wystartował.', r.stdout, r.stderr].join(' ').trim());
    process.exit(3);
  }
}

if (require.main === module) {
  probe().then(failures => {
    console.log(failures.length ? `NIEIZOLOWANE:\n- ${failures.join('\n- ')}` : 'izolacja potwierdzona');
    process.exit(failures.length ? 3 : 0);
  });
}
module.exports = { probe, assertIsolatedSync };
