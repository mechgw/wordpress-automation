'use strict';

/**
 * #275: rozbite rejestratory przebiegów w pełni zabijają mutanty Strykera.
 *
 * `failImportRun_`, `importRunEntry_`, `finishImportRun_`, `failJobRun_` i
 * `finishJobRun_` (wydzielone z `recordImportRunLocked_` i `recordJobRunLocked_`)
 * mają zbiegłe mutanty z pilotażu #234: normalizacja komunikatu błędu, argumenty
 * przejęcia odmów, czas trwania, wynik niebędący obiektem, ostrzeżenia z notami.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const MIN = 60 * 1000;
const projekt = () => loadProject({ properties: { ALERT_EMAIL: 'alerty@example.pl' } });
const importRecord = gas => JSON.parse(gas.$properties.LAST_IMPORT_GA4);
const jobRecord = (gas, key) => JSON.parse(gas.$properties['LAST_RUN_' + key]);
const logi = gas => (gas.$sheet('IMPORT LOG') || []).slice(1).filter(r => String(r[1] || '') !== '');
const stary = (gas, job, id = 'stary') => {
  gas.$properties['RUNNING_' + job + '_' + id] = JSON.stringify({ job, runId: id, startedAt: new Date(Date.now() - 10 * MIN).toISOString(), trigger: true });
};
const oczekujace = gas => Object.keys(gas.$properties).filter(k => k.indexOf('PENDING_RUN_') === 0);
const wPrzyszlosci = (gas, nazwa) => {
  const wpis = JSON.parse(gas.$properties[nazwa]);
  wpis.at = new Date(Date.now() + 60 * MIN).toISOString();
  gas.$properties[nazwa] = JSON.stringify(wpis);
};
const przebiegiImportu = (gas, fn) => gas.recordImportRun_('GA4', true, fn);
const przebiegiZadania = (gas, fn, key = 'PERFORMANCE') => gas.recordJobRun_(key, true, fn);
const rzuca = fn => { try { fn(); } catch (e) { return e; } return null; };

describe('#275: failImportRun_ i failJobRun_', () => {
  test('komunikat błędu: białe znaki zwinięte do spacji, napis i obiekt z message obsłużone', () => {
    const gas = projekt();

    rzuca(() => przebiegiImportu(gas, () => { throw new Error('pierwsza\n   druga \t trzecia'); }));
    assert.equal(importRecord(gas).lastRun.error, 'pierwsza druga trzecia');
    rzuca(() => przebiegiImportu(gas, () => { throw 'czysty napis'; }));
    assert.equal(importRecord(gas).lastRun.error, 'czysty napis');
    rzuca(() => przebiegiImportu(gas, () => { throw { message: 'z message' }; }));
    assert.equal(importRecord(gas).lastRun.error, 'z message');

    rzuca(() => przebiegiZadania(gas, () => { throw new Error('a\n   b \t c'); }));
    assert.equal(jobRecord(gas, 'PERFORMANCE').lastRun.error, 'a b c');
    rzuca(() => przebiegiZadania(gas, () => { throw 'napis zadania'; }));
    assert.equal(jobRecord(gas, 'PERFORMANCE').lastRun.error, 'napis zadania');
  });

  test('komunikat błędu jest ucięty do 300 znaków', () => {
    const gas = projekt();

    rzuca(() => przebiegiImportu(gas, () => { throw new Error('ab '.repeat(200)); }));

    assert.equal(importRecord(gas).lastRun.error.length, 300);

    rzuca(() => przebiegiZadania(gas, () => { throw new Error('ab '.repeat(200)); }));

    assert.equal(jobRecord(gas, 'PERFORMANCE').lastRun.error.length, 300);
  });

  test('czas trwania nieudanego przebiegu to różnica, nie suma', () => {
    const gas = projekt();

    rzuca(() => przebiegiImportu(gas, () => { throw new Error('x'); }));
    rzuca(() => przebiegiZadania(gas, () => { throw new Error('x'); }));

    assert.ok(importRecord(gas).lastRun.durationMs >= 0 && importRecord(gas).lastRun.durationMs < 5000);
    assert.ok(jobRecord(gas, 'PERFORMANCE').lastRun.durationMs >= 0 && jobRecord(gas, 'PERFORMANCE').lastRun.durationMs < 5000);
  });

  test('odmowa późniejsza niż nieudany przebieg czeka na następnego posiadacza blokady', () => {
    const gas = projekt();
    gas.recordPendingRun_('GA4', 'odmowa importu');
    gas.recordPendingRun_('PERFORMANCE', 'odmowa zadania');
    oczekujace(gas).forEach(n => wPrzyszlosci(gas, n));

    rzuca(() => przebiegiImportu(gas, () => { throw new Error('x'); }));
    rzuca(() => przebiegiZadania(gas, () => { throw new Error('x'); }));

    assert.equal(oczekujace(gas).length, 2, 'obie odmowy z przyszłości zostają');
  });

  test('odmowa wcześniejsza niż nieudany przebieg jest przejmowana', () => {
    const gas = projekt();
    gas.recordPendingRun_('GA4', 'odmowa importu');

    rzuca(() => przebiegiImportu(gas, () => { throw new Error('x'); }));

    assert.deepEqual(oczekujace(gas), []);
    assert.ok(logi(gas).some(r => /odmowa importu/.test(String(r[8]))), 'ślad odmowy w IMPORT LOG');
  });

  test('rekord zadania zapisany także wtedy, gdy obsługa incydentu nic nie zapisze', () => {
    const gas = projekt();
    gas.updateImportIncident_ = () => '';

    rzuca(() => przebiegiZadania(gas, () => { throw new Error('boom'); }));

    assert.equal(jobRecord(gas, 'PERFORMANCE').lastRun.ok, false);
    assert.equal(jobRecord(gas, 'PERFORMANCE').lastRun.error, 'boom');
  });

  test('wiersz IMPORT LOG tylko dla zadań z log: true', () => {
    const gas = projekt();

    rzuca(() => przebiegiZadania(gas, () => { throw new Error('x'); }, 'SEO_LIVE'));
    assert.deepEqual(logi(gas), [], 'SEO_LIVE nie loguje');

    rzuca(() => przebiegiZadania(gas, () => { throw new Error('y'); }, 'PERFORMANCE'));
    assert.equal(logi(gas).length, 1, 'PERFORMANCE loguje');
  });
});

describe('#275: importRunEntry_ i finishImportRun_', () => {
  test('wpis bez pól wyniku: puste napisy i zera, brak abandoned', () => {
    const gas = projekt();

    przebiegiImportu(gas, () => ({}));

    const run = importRecord(gas).lastRun;
    assert.equal(run.dataFrom, '');
    assert.equal(run.dataTo, '');
    assert.equal(run.detail, '');
    assert.equal(run.warning, '');
    assert.equal(run.rows, 0);
    assert.equal(run.days, 0);
    assert.equal('abandoned' in run, false);
  });

  test('wynik niebędący obiektem (undefined, null, napis) nie przerywa przebiegu i daje zera', () => {
    const gas = projekt();

    assert.equal(przebiegiImportu(gas, () => undefined), undefined);
    assert.equal(przebiegiImportu(gas, () => null), null);
    assert.equal(przebiegiImportu(gas, () => 'napis'), 'napis');

    assert.equal(importRecord(gas).lastRun.rows, 0);
  });

  test('ostrzeżenie zadania łączy się z notami porzuconych przebiegów; abandoned to same noty', () => {
    const gas = projekt();
    stary(gas, 'GA4', 'a');
    stary(gas, 'GA4', 'b');

    przebiegiImportu(gas, () => ({ rows: 5, warning: 'ostrzeżenie' }));

    const run = importRecord(gas).lastRun;
    const czesci = run.warning.split(' | ');
    assert.equal(czesci[0], 'ostrzeżenie');
    assert.equal(czesci.length, 3);
    assert.equal(run.abandoned.split(' | ').length, 2);
    assert.equal(run.abandoned, czesci.slice(1).join(' | '));
  });

  test('sama nota bez ostrzeżenia zadania: warning bez pustego członu', () => {
    const gas = projekt();
    stary(gas, 'GA4');

    przebiegiImportu(gas, () => ({ rows: 5 }));

    const run = importRecord(gas).lastRun;
    assert.equal(run.warning, run.abandoned);
    assert.ok(!run.warning.startsWith(' | '));
  });

  test('czas obsługi wyniku w logu to różnica (liczby małe, nie sumy znaczników czasu)', () => {
    const gas = projekt();

    przebiegiImportu(gas, () => ({ rows: 1 }));

    const linia = gas.$console.map(([, t]) => t).find(t => t.startsWith('[import GA4] obsługa wyniku: '));
    const m = /obsługa wyniku: (\d+) ms \(osobny pomiar; od startu przebiegu (\d+) ms\)/.exec(linia);
    assert.ok(m, linia);
    assert.ok(Number(m[1]) < 10000 && Number(m[2]) < 10000, linia);
  });

  test('czas trwania udanego importu to różnica', () => {
    const gas = projekt();

    przebiegiImportu(gas, () => ({ rows: 1 }));

    assert.ok(importRecord(gas).lastRun.durationMs >= 0 && importRecord(gas).lastRun.durationMs < 5000);
  });
});

describe('#275: finishJobRun_', () => {
  test('wpis udanego zadania: rows, detail, warning z wyniku; bez nich zera i puste napisy', () => {
    const gas = projekt();

    przebiegiZadania(gas, () => ({ rows: 7, detail: 'szczegół', warning: 'uwaga' }));
    const pelny = jobRecord(gas, 'PERFORMANCE').lastRun;
    assert.equal(pelny.rows, 7);
    assert.equal(pelny.detail, 'szczegół');
    assert.equal(pelny.warning, 'uwaga');

    przebiegiZadania(gas, () => ({}));
    const pusty = jobRecord(gas, 'PERFORMANCE').lastRun;
    assert.equal(pusty.rows, 0);
    assert.equal(pusty.detail, '');
    assert.equal(pusty.warning, '');
  });

  test('wynik niebędący obiektem nie przerywa przebiegu', () => {
    const gas = projekt();

    assert.equal(przebiegiZadania(gas, () => undefined), undefined);
    assert.equal(przebiegiZadania(gas, () => null), null);
    assert.equal(jobRecord(gas, 'PERFORMANCE').lastRun.rows, 0);
  });

  test('ostrzeżenie łączy się z notami; sama nota nie zostawia pustego członu', () => {
    const gas = projekt();
    stary(gas, 'PERFORMANCE');

    przebiegiZadania(gas, () => ({ warning: 'moje' }));
    const dwa = jobRecord(gas, 'PERFORMANCE').lastRun.warning.split(' | ');
    assert.equal(dwa[0], 'moje');
    assert.equal(dwa.length, 2);

    stary(gas, 'PERFORMANCE', 'drugi');
    przebiegiZadania(gas, () => ({}));
    const sama = jobRecord(gas, 'PERFORMANCE').lastRun.warning;
    assert.ok(sama.length > 0 && !sama.startsWith(' | '));
  });

  test('czas trwania udanego zadania to różnica', () => {
    const gas = projekt();

    przebiegiZadania(gas, () => ({ rows: 1 }));

    const t = jobRecord(gas, 'PERFORMANCE').lastRun.durationMs;
    assert.ok(t >= 0 && t < 5000, String(t));
  });

  test('plain(): rejestrator zwraca wynik pracy bez zmian', () => {
    const gas = projekt();

    assert.deepEqual(plain(przebiegiZadania(gas, () => ({ rows: 2, x: 'y' }))), { rows: 2, x: 'y' });
  });
});
