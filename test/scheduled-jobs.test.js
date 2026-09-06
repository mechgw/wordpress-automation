'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadProject } = require('./helpers/gas');

const ROOT = path.resolve(__dirname, '..');

/**
 * Statyczny skan źródeł: wyciąga handler z każdego `ScriptApp.newTrigger(...)`.
 * Argument bywa literałem ('importDzienny') albo stałą (RECRAWL_TRIGGER_HANDLER),
 * więc stałe rozwiązujemy po deklaracji w tym samym pliku.
 */
function declaredTriggerHandlers() {
  const found = [];
  for (const file of fs.readdirSync(ROOT).filter(f => f.endsWith('.gs'))) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const calls = code.match(/newTrigger\(\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*\)/g) || [];
    for (const call of calls) {
      const literal = /newTrigger\(\s*'([^']+)'/.exec(call);
      if (literal) { found.push({ file, handler: literal[1] }); continue; }
      const ident = /newTrigger\(\s*([A-Za-z_$][\w$]*)/.exec(call)[1];
      const decl = new RegExp('const[ ]+' + ident + '[ ]*=[ ]*\'([^\']+)\'').exec(code);
      assert.ok(decl, `Nie udało się rozwiązać stałej ${ident} w ${file}`);
      found.push({ file, handler: decl[1] });
    }
  }
  return found;
}

describe('#100: rejestr zadań cyklicznych', () => {
  const gas = loadProject({});
  const registry = gas.scheduledJobs_();

  test('rejestr zna każdy handler triggera zakładany przez kod', () => {
    const known = registry.map(j => j.handler);
    const declared = declaredTriggerHandlers();
    assert.ok(declared.length >= 7, 'skan powinien znaleźć wszystkie instalatory triggerów');
    for (const { file, handler } of declared) {
      assert.ok(
        known.includes(handler),
        `Handler "${handler}" z ${file} nie jest w scheduledJobs_(). ` +
        'Dopisz go tam, inaczej diagnostyka i monitoring go nie zobaczą.'
      );
    }
  });

  test('rejestr nie zawiera zadań, których nikt nie instaluje', () => {
    const declared = declaredTriggerHandlers().map(d => d.handler);
    for (const job of registry) {
      assert.ok(declared.includes(job.handler), `Zadanie "${job.key}" nie ma instalatora triggera.`);
    }
  });

  test('klucze, handlery i etykiety są unikalne i niepuste', () => {
    for (const field of ['key', 'handler', 'label']) {
      const values = registry.map(j => j[field]);
      assert.ok(values.every(Boolean), `puste ${field} w rejestrze`);
      assert.equal(new Set(values).size, values.length, `powtórzone ${field} w rejestrze`);
    }
  });

  test('diagnostyka wypisuje każde zadanie z rejestru', () => {
    const withTriggers = loadProject({ triggers: registry.map(j => j.handler) });
    const line = withTriggers.smokeTriggers_();
    for (const job of registry) {
      assert.ok(line.includes(job.label + ': TAK'), `brak "${job.label}" w linii diagnostyki`);
    }
  });
});
