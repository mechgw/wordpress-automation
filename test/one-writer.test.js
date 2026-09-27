'use strict';

/**
 * #204: jeden pisarz stanu przebiegów. Numeracja odpowiada macierzy testów z opisu issue.
 *
 * 26.09 dwa ręczne importy GSC nałożyły się: przebieg odrzucony przez blokadę
 * dopisał wiersz BŁĄD i otworzył incydent, a przebieg trzymający blokadę nadpisał
 * ten wiersz i zapisał rekord wczytany przed pracą. Zginął wiersz i incydent.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const LOG = 'IMPORT LOG';
const TRIGGER = { triggerUid: 't-1' };
const BUSY_GSC = /Inne uruchomienie jeszcze trwa \(import GSC\)/;

const sheets = () => ({
  'Konfiguracja GSC': [['k', 'v'], ['siteUrl', 'https://www.example.pl/'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']],
  'GSC RAW': [['date']]
});
const okFetch = () => ({ code: 200, json: { rows: [] } });

/** Opcje zostają w teście, bo stub czyta `lockHeld` przy każdym `tryLock`. */
function options(extra = {}) {
  return Object.assign({ sheets: sheets(), fetch: okFetch, properties: { ALERT_EMAIL: 'alerty@example.pl' } }, extra);
}

const logRows = gas => (gas.$sheet(LOG) || []).slice(1);
const logKinds = gas => logRows(gas).map(r => r[1] + ' ' + r[4]);
const pendingKeys = gas => Object.keys(gas.$properties).filter(k => k.indexOf('PENDING_RUN_') === 0).sort();
const record = (gas, prop) => JSON.parse(gas.$properties[prop] || '{}');
const subjects = gas => gas.$mails.map(m => m.subject);
const udany = () => ({ rows: 2, detail: 'dwa wiersze' });

/** Wpis oczekujący po odrzuconym triggerze GSC, potem blokada wolna. */
function withPendingGsc() {
  const opts = options({ lockHeld: true });
  const gas = loadProject(opts);
  assert.throws(() => gas.importDzienny(TRIGGER), BUSY_GSC);
  opts.lockHeld = false;
  return gas;
}

describe('#204: odmowa blokady nie jest przebiegiem', () => {
  test('1: odmowa z menu — wyjątek z dotychczasową treścią, stan i poczta bez zmian', () => {
    const gas = loadProject(options({ lockHeld: true, fetch: () => { throw new Error('bez blokady nie wolno pytać API'); } }));

    assert.throws(() => gas.importOstatniZakres(), BUSY_GSC);

    assert.equal(gas.$properties.LAST_IMPORT_GSC, undefined, 'bez rekordu');
    assert.deepEqual(logRows(gas), [], 'bez wiersza IMPORT LOG');
    assert.equal(gas.$cell('Konfiguracja GSC', 'B8'), '', 'komórka statusu bez zmian');
    assert.deepEqual(gas.$mails, [], 'bez maila');
    assert.deepEqual(pendingKeys(gas), [], 'z menu bez wpisu oczekującego');
  });

  test('2: odmowa z triggera — jeden wpis oczekujący i nic poza nim', () => {
    const gas = loadProject(options({ lockHeld: true }));
    const before = Object.assign({}, gas.$properties);

    assert.throws(() => gas.importDzienny(TRIGGER), BUSY_GSC);

    const keys = pendingKeys(gas);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^PENDING_RUN_GSC_/);
    const entry = JSON.parse(gas.$properties[keys[0]]);
    assert.equal(entry.job, 'GSC');
    assert.equal(entry.trigger, true);
    assert.match(entry.error, BUSY_GSC);
    assert.ok(!isNaN(Date.parse(entry.at)), 'znacznik czasu odmowy');
    const after = Object.assign({}, gas.$properties);
    delete after[keys[0]];
    assert.deepEqual(after, before, 'żadna inna właściwość nie zmieniona');
    assert.deepEqual(logRows(gas), []);
    assert.deepEqual(gas.$mails, []);
  });
});

describe('#204: przejęcie wpisów oczekujących', () => {
  test('3: wpis innego zadania — wiersz BŁĄD przed wierszem przejmującego, incydent z mailem, wpis usunięty', () => {
    const gas = withPendingGsc();

    gas.recordJobRun_('PERFORMANCE', true, udany);

    assert.deepEqual(logKinds(gas), ['GSC BŁĄD', 'PERFORMANCE OK']);
    const [refusal, own] = logRows(gas);
    assert.ok(new Date(refusal[0]).getTime() <= new Date(own[0]).getTime(), 'w kolejności czasu');
    assert.match(String(refusal[8]), BUSY_GSC);
    assert.equal(record(gas, 'LAST_IMPORT_GSC').lastRun.ok, false);
    assert.equal(record(gas, 'LAST_IMPORT_GSC').incident.open, true);
    assert.match(gas.$cell('Konfiguracja GSC', 'B8'), /BŁĄD/);
    assert.deepEqual(subjects(gas), ['[wordpress-automation] BŁĄD importu: Search Console (GSC)']);
    assert.deepEqual(pendingKeys(gas), []);
  });

  test('4: wpis tego samego zadania przed jego udanym przebiegiem — tylko wiersz w logu, bez incydentu i maili', () => {
    const gas = withPendingGsc();

    gas.importDzienny(TRIGGER);

    assert.deepEqual(logKinds(gas), ['GSC BŁĄD', 'GSC OK']);
    assert.equal(record(gas, 'LAST_IMPORT_GSC').lastRun.ok, true);
    assert.equal(record(gas, 'LAST_IMPORT_GSC').incident, undefined);
    assert.deepEqual(gas.$mails, []);
    assert.deepEqual(pendingKeys(gas), []);
  });

  test('4b: wpis tego samego zadania i nieudany przebieg przejmującego — incydent jak dziś', () => {
    // Stub zapamiętuje funkcję `fetch` przy tworzeniu projektu, więc awarię przełącza flaga.
    let failing = false;
    const opts = options({ lockHeld: true, fetch: () => (failing ? { code: 500, text: 'awaria' } : okFetch()) });
    const gas = loadProject(opts);
    assert.throws(() => gas.importDzienny(TRIGGER), BUSY_GSC);
    opts.lockHeld = false;
    failing = true;

    assert.throws(() => gas.importDzienny(TRIGGER), /Search Console API HTTP 500/);

    assert.deepEqual(logKinds(gas), ['GSC BŁĄD', 'GSC BŁĄD']);
    assert.equal(record(gas, 'LAST_IMPORT_GSC').incident.open, true);
    assert.equal(subjects(gas).length, 1, 'jeden mail otwierający, drugi błąd przy otwartym incydencie milczy');
    assert.deepEqual(pendingKeys(gas), []);
  });

  test('3b: wpis zadania bez log:true — rekord i incydent, ale bez wiersza w IMPORT LOG', () => {
    const opts = options({ lockHeld: true });
    const gas = loadProject(opts);
    assert.throws(() => gas.recordJobRun_('SEO_LIVE', true, udany), /Inne uruchomienie jeszcze trwa \(live check SEO\)/);
    opts.lockHeld = false;

    gas.recordJobRun_('PERFORMANCE', true, udany);

    assert.deepEqual(logKinds(gas), ['PERFORMANCE OK']);
    assert.equal(record(gas, 'LAST_RUN_SEO_LIVE').lastRun.ok, false);
    assert.equal(record(gas, 'LAST_RUN_SEO_LIVE').incident.open, true);
    assert.deepEqual(pendingKeys(gas), []);
  });

  test('wpis nieczytelny, nieznanego zadania albo bez prawidłowej daty zostaje nietknięty', () => {
    const gas = loadProject(options());
    gas.$properties.PENDING_RUN_GSC_zepsuty = 'to nie jest JSON';
    gas.$properties.PENDING_RUN_NIEZNANE_1 = JSON.stringify({ job: 'NIEZNANE', at: new Date().toISOString(), error: 'x' });
    gas.$properties.PENDING_RUN_GSC_2 = JSON.stringify({ job: 'GSC', at: 'wczoraj', error: 'x' });

    gas.recordJobRun_('PERFORMANCE', true, udany);

    assert.deepEqual(pendingKeys(gas), ['PENDING_RUN_GSC_2', 'PENDING_RUN_GSC_zepsuty', 'PENDING_RUN_NIEZNANE_1']);
    assert.deepEqual(logKinds(gas), ['PERFORMANCE OK']);
  });
});

describe('#204: scenariusz z 26.09', () => {
  test('5: A trzyma blokadę, B z menu odrzucony w trakcie pracy A — w logu wyłącznie A, bez maila od B', () => {
    let gas;
    let refused = null;
    gas = loadProject(options({
      fetch: () => {
        if (!refused) {
          try {
            gas.$asOtherExecution(() => gas.importOstatniZakres());
          } catch (e) {
            refused = e;
          }
        }
        return { code: 200, json: { rows: [] } };
      }
    }));

    gas.importOstatniZakres();

    assert.match(String(refused && refused.message), BUSY_GSC);
    assert.deepEqual(logKinds(gas), ['GSC OK'], 'jeden wiersz, przebiegu A');
    assert.equal(record(gas, 'LAST_IMPORT_GSC').lastRun.ok, true);
    assert.deepEqual(gas.$mails, [], 'bez maila od B');
    assert.deepEqual(pendingKeys(gas), []);
  });

  test('6: incydent zapisany w trakcie pracy A — rekord czytany po pracy, pod blokadą; sukces go zamyka mailem', () => {
    let gas;
    let written = false;
    gas = loadProject(options({
      fetch: () => {
        if (!written) {
          // Stan zapisany w trakcie pracy A. Przed #204 A zapisywał rekord wczytany
          // przed pracą i ten incydent ginął bez maila „ponownie działa”.
          gas.$properties.LAST_IMPORT_GSC = JSON.stringify({
            incident: { open: true, reason: 'error', detail: 'wczorajszy błąd', openedAt: '2026-09-26T09:08:35.000Z', notifiedAt: '2026-09-26T09:08:35.000Z' }
          });
          written = true;
        }
        return { code: 200, json: { rows: [] } };
      }
    }));

    gas.importOstatniZakres();

    assert.equal(record(gas, 'LAST_IMPORT_GSC').incident.open, false);
    assert.deepEqual(subjects(gas), ['[wordpress-automation] Import ponownie działa: Search Console (GSC)']);
  });

  test('7: ubicie po zapisie wiersza, a przed usunięciem wpisu — wpis przejęty ponownie, najwyżej jeden duplikat', () => {
    const gas = withPendingGsc();
    const [key] = pendingKeys(gas);
    let kills = 1;
    gas.$faults.deleteProperty = name => name === key && kills-- > 0;

    gas.recordJobRun_('PERFORMANCE', true, udany);
    assert.deepEqual(pendingKeys(gas), [key], 'wpis nie zginął');

    gas.recordJobRun_('PERFORMANCE', true, udany);

    assert.deepEqual(pendingKeys(gas), []);
    const refusals = logRows(gas).filter(r => r[1] === 'GSC');
    assert.equal(refusals.length, 2, 'jeden duplikat, bez utraty');
    assert.equal(subjects(gas).length, 1, 'drugie przejęcie przy otwartym incydencie nie wysyła maila');
  });
});

describe('#204: strażnik aktualności pod blokadą', () => {
  test('8: zajęta blokada — żadnych zapisów rekordów, tylko wpis oczekujący ALERTS', () => {
    const gas = loadProject(options({ lockHeld: true }));
    const before = Object.assign({}, gas.$properties);

    assert.throws(() => gas.sprawdzAktualnoscImportow(), /Inne uruchomienie jeszcze trwa \(strażnik alertów\)/);

    const keys = pendingKeys(gas);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^PENDING_RUN_ALERTS_/);
    const after = Object.assign({}, gas.$properties);
    delete after[keys[0]];
    assert.deepEqual(after, before);
  });

  test('8b: strażnik z menu przy zajętej blokadzie — okno z błędem, bez wpisu oczekującego', () => {
    const gas = loadProject(options({ lockHeld: true }));
    assert.throws(() => gas.sprawdzAktualnoscImportowZMenu(), /Inne uruchomienie jeszcze trwa \(strażnik alertów\)/);
    assert.deepEqual(pendingKeys(gas), []);
  });

  test('8c: strażnik przejmuje wpisy oczekujące i zapisuje własny przebieg', () => {
    const gas = withPendingGsc();

    gas.sprawdzAktualnoscImportow();

    assert.deepEqual(logKinds(gas), ['GSC BŁĄD']);
    assert.equal(record(gas, 'LAST_IMPORT_GSC').incident.open, true);
    assert.equal(record(gas, 'LAST_RUN_ALERTS').lastRun.ok, true);
    assert.deepEqual(pendingKeys(gas), []);
  });
});

describe('#204: kolejność przy zwolnieniu blokady', () => {
  const lastIndex = (events, pred) => events.reduce((at, e, i) => (pred(e) ? i : at), -1);

  for (const [name, fetch, expectThrow] of [
    ['udany import', okFetch, false],
    ['nieudany import', () => ({ code: 500, text: 'awaria' }), true]
  ]) {
    test('9: ' + name + ' — zapisy stanu, potem flush, potem releaseLock', () => {
      const gas = loadProject(options({ fetch }));

      if (expectThrow) assert.throws(() => gas.importDzienny(TRIGGER));
      else gas.importDzienny(TRIGGER);

      const events = plain(gas.$events);
      const lastWrite = lastIndex(events, e => (e[0] === 'setProperty' && e[1] === 'LAST_IMPORT_GSC') || (e[0] === 'appendRow' && e[1] === LOG));
      const flushAt = lastIndex(events, e => e[0] === 'flush');
      const releaseAt = lastIndex(events, e => e[0] === 'releaseLock');
      assert.ok(lastWrite >= 0, 'stan zapisany');
      assert.ok(lastWrite < flushAt, 'flush po ostatnim zapisie');
      assert.ok(flushAt < releaseAt, 'releaseLock po flush');
      assert.equal(events.filter(e => e[0] === 'tryLock').length, 1, 'jedna blokada na cały przebieg');
    });
  }

  test('rejestrator wywołany pod blokadą już trzymaną nie przejmuje jej ponownie i jej nie zwalnia', () => {
    const gas = loadProject(options());

    gas.withScriptLock_('komendy WordPress', () => gas.recordJobRun_('PERFORMANCE', true, udany));

    assert.deepEqual(plain(gas.$lock), [['tryLock', 5000], ['releaseLock']]);
    assert.deepEqual(logKinds(gas), ['PERFORMANCE OK']);
  });

  test('odmowa z triggera Business Profile zachowuje dotychczasową nazwę w komunikacie', () => {
    const gas = loadProject(options({ lockHeld: true }));
    assert.throws(() => gas.recordJobRun_('GBP', true, udany), /Inne uruchomienie jeszcze trwa \(import Business Profile\)/);
  });
});
