'use strict';

/**
 * #281: funkcje detektora anomalii w pełni zabijają mutanty Strykera.
 *
 * Funkcje przeniesione ze Status.gs do ImportAnomaly.gs i nowe (`importSourceSamples_`)
 * mają zbiegłe mutanty z pilotażu #234: sortowanie, granica okna retencji, filtr
 * historii, brak mutacji wejścia. Testy wołają funkcje wprost.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const DAY = 24 * 3600 * 1000;
const RETENTION = 90 * DAY;
const gas = loadProject({});
const now = new Date('2026-10-20T10:00:00Z');
const wpis = (ago, extra = {}) => Object.assign({
  at: new Date(now.getTime() - ago), source: 'GSC', trigger: true, days: 1, ok: true, rows: 100, rangeKey: ''
}, extra);
const run = (extra = {}) => Object.assign({ trigger: true, days: 1, finishedAt: now.toISOString() }, extra);
const ids = lista => plain(lista.map(h => h.rows));

describe('#281: medianOf_', () => {
  test('nie zmienia tablicy wejściowej', () => {
    const wejscie = [3, 1, 2];

    assert.equal(gas.medianOf_(wejscie), 2);
    assert.deepEqual(plain(wejscie), [3, 1, 2]);
  });

  test('mediana parzystej i nieparzystej liczby, sortowanie liczbowe', () => {
    assert.equal(gas.medianOf_([10, 9, 100]), 10);
    assert.equal(gas.medianOf_([1, 2, 10, 20]), 6);
  });
});

describe('#281: importAnomalySamples_ i importSourceSamples_ - filtr, okno retencji, sortowanie', () => {
  const rozne = [
    wpis(1 * DAY, { rows: 1 }),
    wpis(2 * DAY, { rows: 2, ok: false }),
    wpis(3 * DAY, { rows: 3, source: 'GA4' }),
    wpis(4 * DAY, { rows: 4, trigger: false }),
    wpis(5 * DAY, { rows: 5, at: new Date('nieprawidłowa') }),
    wpis(RETENTION + DAY, { rows: 6 })
  ];

  test('profil: odrzuca nieudane, inne źródło, inny typ uruchomienia, inne dni, nieczytelną datę i wygasłe', () => {
    const historia = rozne.concat([wpis(6 * DAY, { rows: 7, days: 2 }), wpis(7 * DAY, { rows: 8 })]);

    const out = gas.importAnomalySamples_('GSC', run(), historia, now);

    assert.deepEqual(ids(out), [8, 1]);
  });

  test('źródło: te same odrzucenia, ale dowolna liczba dni', () => {
    const historia = rozne.concat([wpis(6 * DAY, { rows: 7, days: 2 }), wpis(7 * DAY, { rows: 8 })]);

    const out = gas.importSourceSamples_('GSC', run(), historia, now);

    assert.deepEqual(ids(out), [8, 7, 1]);
  });

  test('granica okna: próbka dokładnie na granicy wchodzi, o milisekundę starsza nie', () => {
    const naGranicy = wpis(RETENTION, { rows: 11 });
    const starsza = wpis(RETENTION + 1, { rows: 12 });

    assert.deepEqual(ids(gas.importAnomalySamples_('GSC', run(), [naGranicy, starsza], now)), [11]);
    assert.deepEqual(ids(gas.importSourceSamples_('GSC', run(), [naGranicy, starsza], now)), [11]);
  });

  test('sortuje rosnąco po czasie, niezależnie od kolejności w historii', () => {
    const historia = [wpis(1 * DAY, { rows: 1 }), wpis(5 * DAY, { rows: 5 }), wpis(3 * DAY, { rows: 3 })];

    assert.deepEqual(ids(gas.importAnomalySamples_('GSC', run(), historia, now)), [5, 3, 1]);
    assert.deepEqual(ids(gas.importSourceSamples_('GSC', run(), historia, now)), [5, 3, 1]);
  });

  test('bez parametru now okno liczy się od finishedAt przebiegu, z now - od now', () => {
    const stary = wpis(RETENTION - DAY, { rows: 20 });
    const przebieg = run({ finishedAt: new Date(now.getTime() + 2 * DAY).toISOString() });

    assert.deepEqual(ids(gas.importAnomalySamples_('GSC', przebieg, [stary])), [], 'od finishedAt (2 dni później) próbka wygasła');
    assert.deepEqual(ids(gas.importAnomalySamples_('GSC', przebieg, [stary], now)), [20], 'od now próbka mieści się w oknie');
    assert.deepEqual(ids(gas.importSourceSamples_('GSC', przebieg, [stary])), []);
    assert.deepEqual(ids(gas.importSourceSamples_('GSC', przebieg, [stary], now)), [20]);
  });

  test('źródło: zakres bieżącego przebiegu jest wykluczony, pozostałe zakresy zostają', () => {
    const historia = [wpis(DAY, { rows: 1, rangeKey: '2026-10-01..2026-10-01' }), wpis(2 * DAY, { rows: 2, rangeKey: '2026-09-30..2026-09-30' })];
    const przebieg = run({ dataFrom: '2026-10-01', dataTo: '2026-10-01' });

    assert.deepEqual(ids(gas.importSourceSamples_('GSC', przebieg, historia, now)), [2]);
  });
});

describe('#281: baza źródła dedupluje po zakresie jak baza profilu', () => {
  const A = '2026-10-01..2026-10-01';
  const B = '2026-10-02..2026-10-02';

  test('ponowny import zakresu z zerem zastępuje wcześniejszy wynik z danymi, także w bazie źródła', () => {
    const historia = [wpis(3 * DAY, { rows: 100, rangeKey: A, days: 2 }), wpis(2 * DAY, { rows: 0, rangeKey: A, days: 2 })];
    const przebieg = run({ rows: 0, dataFrom: '2026-10-02', dataTo: '2026-10-02' });

    assert.deepEqual(ids(gas.importSourceSamples_('GSC', przebieg, historia, now)), [0]);
    assert.equal(gas.importAnomaly_('GSC', przebieg, historia, now), '', 'zero po zakresie, który sam ostatnio dał zero, nie alarmuje');
  });

  test('różne zakresy zostają osobno, a przebiegi bez zakresu liczą się każdy z osobna', () => {
    const historia = [
      wpis(5 * DAY, { rows: 1, rangeKey: A }), wpis(4 * DAY, { rows: 2, rangeKey: B }),
      wpis(3 * DAY, { rows: 3 }), wpis(2 * DAY, { rows: 4 }), wpis(DAY, { rows: 5, rangeKey: A })
    ];

    assert.deepEqual(ids(gas.importSourceSamples_('GSC', run(), historia, now)), [2, 3, 4, 5]);
  });
});

describe('#281: importDataClass_ i importAnomaly_ - brzegi', () => {
  test('klucz zakresu musi zaczynać się od daty', () => {
    assert.equal(gas.importDataClass_('x2026-10-05..2026-10-05'), '');
    assert.equal(gas.importDataClass_('2026-10-05..2026-10-05'), 'roboczy');
    assert.equal(gas.importDataClass_('2026-10-04..2026-10-04'), 'weekend');
    assert.equal(gas.importDataClass_(undefined), '');
  });

  test('siedem próbek z zerem i zero w bieżącym przebiegu: bez alarmu (źródło bez danych to nie spadek)', () => {
    const historia = Array.from({ length: 7 }, (_, i) => wpis((i + 1) * DAY, { rows: 0 }));

    assert.equal(gas.importAnomaly_('GSC', run({ rows: 0 }), historia, now), '');
  });

  test('niski niezerowy wynik przy medianie 0 lub braku bazy: bez alarmu', () => {
    const zera = Array.from({ length: 7 }, (_, i) => wpis((i + 1) * DAY, { rows: 0 }));

    assert.equal(gas.importAnomaly_('GSC', run({ rows: 3 }), zera, now), '');
    assert.equal(gas.importAnomaly_('GSC', run({ rows: 3 }), [], now), '');
  });
});
