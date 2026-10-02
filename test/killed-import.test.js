'use strict';

/**
 * #209: ubity import GSC znika bez śladu.
 *
 * 27.09.2026 twardy limit Apps Script ubił codzienny import GSC po 360,9 s. Nie
 * zostawił wiersza w IMPORT LOG ani maila, a luka 24.09 sama się nie zapełniła,
 * bo import dzienny pobierał jeden dzień. Numeracja odpowiada macierzy z #209.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain, fetchRouter } = require('./helpers/gas');

const GSC_SHEET = 'Konfiguracja GSC';
const GA4_SHEET = 'Konfiguracja GA4';
const RAW = 'GSC RAW';
const LOG = 'IMPORT LOG';
const MIN = 60 * 1000;
const NOTA = /nie zakończył się kontrolowanie — możliwe przerwanie przez limit czasu wykonania Apps Script/;
const HEADER = ['date', 'query', 'page', 'country', 'device', 'clicks', 'impressions', 'ctr', 'position', 'downloaded'];
const FK = '=ARRAYFORMULA(IF(A2:A="",,G2:G*I2:I))';
const FL = '=ARRAYFORMULA(IF(A2:A="",,A2:A*1))';
const WZORZEC = JSON.stringify({ K: FK, L: FL });

/** Data lokalna sprzed `n` dni, jak `formatujDate_` w stubie (strefa maszyny). */
function localDate(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const CEL = localDate(2); // dailyLagDays = 2

function konfiguracja() {
  return {
    [GSC_SHEET]: [['Klucz', 'Wartość'], ['siteUrl', 'https://www.example.pl/'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']],
    [GA4_SHEET]: [['Klucz', 'Wartość'], ['propertyId', 'properties/111'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['', ''], ['', ''], ['', ''], ['status', '']]
  };
}

/** API GSC: `naDzien` wierszy dla każdego dnia zakresu z zapytania. */
function gscApi(naDzien = 1, hook) {
  return (url, params) => {
    if (hook) hook();
    const p = JSON.parse(params.payload);
    const rows = [];
    for (let d = p.startDate; d <= p.endDate; d = nastepny(d)) {
      for (let i = 0; i < naDzien; i++) rows.push({ keys: [d, 'fraza ' + i, '/s', 'pol', 'MOBILE'], clicks: 1, impressions: 10, ctr: 0.1, position: 3 });
    }
    return { code: 200, json: { rows } };
  };
}
function nastepny(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function projekt({ raw = { rows: [HEADER] }, properties = {}, fetch = gscApi(), sheets = {} } = {}) {
  return loadProject({
    sheets: Object.assign(konfiguracja(), { [RAW]: raw }, sheets),
    properties: Object.assign({ ALERT_EMAIL: 'alerty@example.pl' }, properties),
    triggers: ['importDzienny', 'importGA4Dzienny'],
    fetch
  });
}

const znaczniki = gas => Object.keys(gas.$properties).filter(k => k.indexOf('RUNNING_') === 0);
const znacznik = (gas, job, minutTemu, runId = 'stary') => {
  gas.$properties['RUNNING_' + job + '_' + runId] = JSON.stringify({
    job, runId, startedAt: new Date(gas.$Date.now() - minutTemu * MIN).toISOString(), trigger: true
  });
};
const logi = gas => (gas.$sheet(LOG) || []).slice(1).filter(r => String(r[1] || '') !== '');
const porzucone = gas => logi(gas).filter(r => r[4] === 'BŁĄD' && NOTA.test(String(r[8])));
const rekord = gas => JSON.parse(gas.$properties.LAST_IMPORT_GSC);
const tematy = gas => gas.$mails.map(m => m.subject);
const zapytanie = gas => JSON.parse(gas.$fetchCalls[0].params.payload);
const ostatniOk = (gas, dataTo) => {
  gas.$properties.LAST_IMPORT_GSC = JSON.stringify({ lastOk: { finishedAt: new Date().toISOString(), ok: true, dataFrom: dataTo, dataTo } });
};

describe('#209: znacznik wykonania importu', () => {
  test('1: porzucony znacznik odbiera następny udany import — wiersz BŁĄD przed bieżącym, ostrzeżenie, incydent warning', () => {
    let wTrakcie = null;
    const g2 = projekt({ fetch: gscApi(1, () => { wTrakcie = znaczniki(g2); }) });
    znacznik(g2, 'GSC', 10);

    g2.importDzienny({ triggerUid: 't' });

    assert.equal(wTrakcie.length, 1, 'w trakcie pracy jest wyłącznie własny znacznik');
    assert.notEqual(wTrakcie[0], 'RUNNING_GSC_stary');
    assert.deepEqual(znaczniki(g2), [], 'po zakończeniu nie zostaje żaden znacznik');
    const wiersze = logi(g2);
    assert.equal(wiersze.length, 2);
    assert.equal(wiersze[0][4], 'BŁĄD');
    assert.match(String(wiersze[0][8]), NOTA);
    assert.equal(wiersze[0][6], '', 'czas trwania porzuconego nieznany');
    assert.equal(wiersze[1][4], 'OK');
    assert.match(String(wiersze[1][8]), NOTA, 'bieżący przebieg niesie notę jako uwagę');
    assert.equal(rekord(g2).incident.reason, 'warning');
    assert.deepEqual(tematy(g2), ['[wordpress-automation] UWAGA: Search Console (GSC)']);
    assert.match(g2.$cell(GSC_SHEET, 'B8'), /^AKTYWNE/);
  });

  test('2: pierwszy odbiera go strażnik — wiersz, BŁĄD w statusie i incydent error z mailem; potem bez dubli', () => {
    const gas = projekt();
    znacznik(gas, 'GSC', 180);

    gas.sprawdzAktualnoscImportow();

    assert.deepEqual(znaczniki(gas), []);
    assert.equal(porzucone(gas).length, 1);
    const rec = rekord(gas);
    assert.equal(rec.lastRun.ok, false);
    assert.match(rec.lastRun.error, NOTA);
    assert.equal(rec.incident.reason, 'error');
    assert.match(gas.$cell(GSC_SHEET, 'B8'), /BŁĄD .*nie zakończył się kontrolowanie/);
    assert.ok(tematy(gas).includes('[wordpress-automation] BŁĄD importu: Search Console (GSC)'));

    const maile = gas.$mails.length;
    gas.sprawdzAktualnoscImportow();
    gas.importDzienny({ triggerUid: 't' });
    assert.equal(porzucone(gas).length, 1, 'kolejny strażnik i kolejny import nie dublują wiersza');
    assert.equal(gas.$mails.filter(m => /BŁĄD importu/.test(m.subject)).length, 1);
    assert.ok(gas.$mails.length >= maile);
  });

  test('2: strażnik nie nadpisuje nowszego przebiegu, ale zostawia wiersz o porzuconym', () => {
    const gas = projekt();
    znacznik(gas, 'GSC', 180);
    const nowszy = { finishedAt: new Date(gas.$Date.now() - 60 * MIN).toISOString(), ok: true, trigger: false, rows: 5 };
    gas.$properties.LAST_IMPORT_GSC = JSON.stringify({ lastRun: nowszy, lastOk: nowszy });

    gas.sprawdzAktualnoscImportow();

    assert.equal(porzucone(gas).length, 1);
    assert.deepEqual(plain(rekord(gas).lastRun), nowszy);
    assert.equal(rekord(gas).incident, undefined);
  });

  test('2: strażnik odbiera znaczniki obu źródeł importu', () => {
    const gas = projekt();
    znacznik(gas, 'GSC', 180, 'a');
    znacznik(gas, 'GA4', 120, 'b');
    gas.sprawdzAktualnoscImportow();
    assert.deepEqual(znaczniki(gas), []);
    assert.deepEqual(porzucone(gas).map(r => r[1]).sort(), ['GA4', 'GSC']);
  });

  test('3: znacznik młodszy niż 7 min zostaje — ani strażnik, ani inny przebieg go nie ruszają', () => {
    const gas = projekt();
    znacznik(gas, 'GSC', 3, 'trwa');
    gas.sprawdzAktualnoscImportow();
    gas.importDzienny({ triggerUid: 't' });
    assert.deepEqual(znaczniki(gas), ['RUNNING_GSC_trwa']);
    assert.equal(porzucone(gas).length, 0);
  });

  test('4: błąd w trakcie importu usuwa własny znacznik; wiersz BŁĄD bez noty o porzuceniu', () => {
    const gas = projekt({ fetch: () => ({ code: 500, text: 'awaria' }) });
    assert.throws(() => gas.importDzienny({ triggerUid: 't' }), /HTTP 500/);
    assert.deepEqual(znaczniki(gas), []);
    const wiersze = logi(gas);
    assert.equal(wiersze.length, 1);
    assert.equal(wiersze[0][4], 'BŁĄD');
    assert.doesNotMatch(String(wiersze[0][8]), NOTA);
  });

  test('4: błąd przy porzuconym poprzednim — nota dołącza do błędu', () => {
    const gas = projekt({ fetch: () => ({ code: 500, text: 'awaria' }) });
    znacznik(gas, 'GSC', 10);
    assert.throws(() => gas.importDzienny({ triggerUid: 't' }), /HTTP 500/);
    assert.match(rekord(gas).lastRun.error, /HTTP 500.* \| poprzedni przebieg .*nie zakończył się kontrolowanie/);
    assert.equal(porzucone(gas).length, 2, 'wiersz za porzucony i błąd bieżącego z notą');
  });
});

describe('#209: samonaprawa luki w imporcie dziennym', () => {
  test('5: dataTo dwa dni przed celem — zakres dwóch dni, Dni = 2', () => {
    const gas = projekt();
    ostatniOk(gas, localDate(4));
    const out = plain(gas.importDzienny({ triggerUid: 't' }));
    assert.deepEqual([zapytanie(gas).startDate, zapytanie(gas).endDate], [localDate(3), CEL]);
    assert.equal(out.days, 2);
    assert.equal(logi(gas).slice(-1)[0][3], 2);
    assert.equal(logi(gas).slice(-1)[0][9], localDate(3) + '..' + CEL);
  });

  test('6: dataTo równe celowi, dalsze niż cel albo brak dataTo — jeden dzień', () => {
    for (const dataTo of [CEL, localDate(1), null]) {
      const gas = projekt();
      if (dataTo) ostatniOk(gas, dataTo);
      gas.importDzienny({ triggerUid: 't' });
      assert.deepEqual([zapytanie(gas).startDate, zapytanie(gas).endDate], [CEL, CEL], String(dataTo));
    }
  });

  test('6: niepoprawne dataTo — jeden dzień', () => {
    const gas = projekt();
    ostatniOk(gas, '24.09.2026');
    gas.importDzienny({ triggerUid: 't' });
    assert.deepEqual([zapytanie(gas).startDate, zapytanie(gas).endDate], [CEL, CEL]);
  });

  test('6: luka dokładnie 7 dni — cała, bez ostrzeżenia', () => {
    const gas = projekt();
    ostatniOk(gas, localDate(9));
    const out = plain(gas.importDzienny({ triggerUid: 't' }));
    assert.deepEqual([zapytanie(gas).startDate, zapytanie(gas).endDate], [localDate(8), CEL]);
    assert.doesNotMatch(out.warning, /luka w danych/);
  });

  test('6: luka 10 dni — 7 najnowszych i ostrzeżenie o reszcie', () => {
    const gas = projekt();
    ostatniOk(gas, localDate(12));
    const out = plain(gas.importDzienny({ triggerUid: 't' }));
    assert.deepEqual([zapytanie(gas).startDate, zapytanie(gas).endDate], [localDate(8), CEL]);
    assert.equal(out.days, 7);
    assert.match(out.warning, new RegExp(`luka w danych: 10 dni od ${localDate(11)}; import dzienny pobrał 7 najnowszych, dni ${localDate(11)} – ${localDate(9)} uzupełnij ręcznym importem zakresu`));
    assert.match(gas.$cell(GSC_SHEET, 'B8'), /UWAGA: luka w danych/);
  });

  test('6: przesunięcie dnia nie zależy od zmiany czasu ani końca miesiąca', () => {
    const gas = projekt();
    assert.equal(gas.shiftDay_('2026-03-28', 1), '2026-03-29');
    assert.equal(gas.shiftDay_('2026-10-31', 1), '2026-11-01');
    assert.equal(gas.shiftDay_('2024-03-01', -1), '2024-02-29');
    assert.equal(gas.dayDiff_('2026-03-25', '2026-04-01'), 7);
  });

  test('8: przebieg dwudniowy nie wchodzi do bazy jednodniowej — porównanie po dniach danych (#180)', () => {
    const gas = projekt({ fetch: gscApi(1) });
    // 7 jednodniowych próbek po 100 wierszy: mediana 100.
    for (let i = 20; i > 13; i--) {
      gas.recordImportRun_('GSC', true, () => ({ rows: 100, days: 1, dataFrom: localDate(i), dataTo: localDate(i) }));
    }
    ostatniOk(gas, localDate(4));
    const out = plain(gas.importDzienny({ triggerUid: 't' }));
    assert.equal(out.days, 2);
    assert.equal(out.rows, 2, 'po jednym wierszu na dzień');
    assert.equal(rekord(gas).lastRun.anomaly, undefined, '2 wiersze z dwóch dni nie są porównywane z medianą 100 jednego dnia');
    assert.equal(logi(gas).slice(-1)[0][3], 2);
  });
});

/** Zakładka GSC RAW z kotwicami K–L w wierszu `wiersz` i opcjonalnymi wierszami pod danymi. */
function zakladka({ fk = FK, fl = FL, wiersz = 1, dane, ogon = 0, formulyNizej = [], maxRows } = {}) {
  const rows = [HEADER.concat(['Pozycja×wyświetlenia', 'Data_num'])];
  if (wiersz === 2) rows.push(['', '', '', '', '', '', '', '', '', '', '', '']);
  dane.forEach((d, i) => rows.push([d, 'q' + i, '/p', 'pol', 'MOBILE', 1, 10, 0.1, 2, '', 20, 46000 + i]));
  for (let i = 0; i < ogon; i++) rows.push(['', '', '', '', '', '', '', '', '', '', '', '']);
  const formulas = rows.map(() => Array(12).fill(''));
  if (fk !== null) formulas[wiersz - 1][10] = fk;
  if (fl !== null) formulas[wiersz - 1][11] = fl;
  formulyNizej.forEach(([r, c, f]) => { formulas[r - 1][c] = f; });
  return { rows, formulas, maxRows };
}
const arkusz = gas => gas.SpreadsheetApp.getActive().getSheetByName(RAW);
const formulyKL = gas => plain(arkusz(gas).getRange(1, 11, arkusz(gas).getLastRow(), 2).getFormulas());
const wartosciKL = gas => gas.$sheet(RAW).map(r => [r[10] === undefined ? '' : r[10], r[11] === undefined ? '' : r[11]]);
const zapisy = gas => plain(gas.$events).filter(e => ['setValues', 'clearContent', 'setNumberFormat', 'deleteRows'].includes(e[0]) && e[1] === RAW);
const dotykaKL = e => e[0] !== 'deleteRows' && e[3] <= 12 && e[3] + e[5] - 1 >= 11;

describe('#209: zapis tylko importowanych dni (kotwice K–L zatwierdzone)', () => {
  test('7: wiersze spoza zakresu nietknięte, dzień obecny usunięty z dwóch bloków, nowe za ostatnią niepustą A', () => {
    const stary = localDate(20);
    const raw = zakladka({ dane: [stary, CEL, stary, CEL, CEL, stary], ogon: 3 });
    const gas = projekt({ raw, properties: { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, fetch: gscApi(2) });
    const przed = gas.$sheet(RAW).filter(r => r[0] === stary).map(r => r.slice(0, 10));

    const out = plain(gas.importDzienny({ triggerUid: 't' }));

    const po = gas.$sheet(RAW);
    assert.deepEqual(po.filter(r => r[0] === stary).map(r => r.slice(0, 10)), przed, 'treść i kolejność spoza zakresu');
    assert.equal(po.filter(r => r[0] === CEL && /^q/.test(r[1])).length, 0, 'stare wiersze dnia usunięte');
    assert.deepEqual(po.slice(1, 6).map(r => r[0]), [stary, stary, stary, CEL, CEL], 'nowe zaraz za danymi, przed pustym ogonem');
    assert.deepEqual(po.slice(4, 6).map(r => r[1]), ['fraza 0', 'fraza 1']);
    assert.equal(arkusz(gas).getRange(5, 8).getNumberFormat(), '0.00%', 'formaty dostają dopisane wiersze');
    assert.doesNotMatch(out.warning, /K–L/);

    const ops = zapisy(gas);
    assert.deepEqual(ops.filter(e => e[0] === 'deleteRows').map(e => [e[2], e[4]]), [[5, 2], [3, 1]], 'bloki od dołu');
    assert.equal(ops.filter(e => e[0] === 'clearContent').length, 0);
    assert.deepEqual(ops.filter(dotykaKL), [], 'żadnego zapisu w K–L');
    assert.ok(ops.every(e => e[0] === 'deleteRows' || e[4] <= 2), 'żaden zapis nie obejmuje całej zakładki');
    assert.deepEqual(formulyKL(gas)[0], [FK, FL], 'kotwice nietknięte');
  });

  test('7: arkusz bez zapasu wierszy — dopisanie dokłada wiersze, zamiast wyjść poza siatkę', () => {
    const raw = zakladka({ dane: [localDate(20), CEL], maxRows: 3 });
    const gas = projekt({ raw, properties: { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, fetch: gscApi(3) });
    gas.importDzienny({ triggerUid: 't' });
    assert.equal(gas.$sheet(RAW).length, 5);
    assert.equal(gas.$sheet(RAW)[4][1], 'fraza 2');
  });

  test('7: dzień bez nowych wierszy — tylko usunięcie', () => {
    const raw = zakladka({ dane: [localDate(20), CEL] });
    const gas = projekt({ raw, properties: { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, fetch: gscApi(0) });
    gas.importDzienny({ triggerUid: 't' });
    assert.deepEqual(gas.$sheet(RAW).slice(1).map(r => r[0]), [localDate(20)]);
    assert.equal(zapisy(gas).filter(e => e[0] === 'setValues').length, 0);
  });

  test('7: pusta zakładka — nowe od wiersza 2', () => {
    const raw = zakladka({ dane: [] });
    const gas = projekt({ raw, properties: { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, fetch: gscApi(1) });
    gas.importDzienny({ triggerUid: 't' });
    assert.equal(gas.$sheet(RAW)[1][0], CEL);
  });

  test('7a: kotwice w wierszu 2 pod nagłówkiem-literałem — nowa ścieżka', () => {
    const raw = zakladka({ dane: [localDate(20)], wiersz: 2 });
    const gas = projekt({ raw, properties: { GSC_KL_ANCHOR_FORMULAS: WZORZEC } });
    const out = plain(gas.importDzienny({ triggerUid: 't' }));
    assert.doesNotMatch(out.warning, /K–L/);
    assert.equal(zapisy(gas).filter(e => e[0] === 'clearContent').length, 0);
  });

  test('7a: ręczny import zakresu zostaje przy zapisie całej zakładki, bez ostrzeżenia K–L', () => {
    const raw = zakladka({ dane: [localDate(20)] });
    const gas = projekt({ raw, properties: { GSC_KL_ANCHOR_FORMULAS: WZORZEC } });
    const out = plain(gas.importOstatniZakres());
    assert.equal(zapisy(gas).filter(e => e[0] === 'clearContent').length, 1);
    assert.equal(out.warning, '');
  });
});

describe('#209: fallback — zapis całej zakładki, K–L nietknięte', () => {
  const stary = localDate(20);
  const zly = '=ARRAYFORMULA(IF(A2:A="",,G2:G*I2:J))';
  const przypadki = [
    ['(i) brak właściwości przy kotwicach wyglądających na tablicowe', {}, {}, /K: brak zatwierdzonego wzorca w GSC_KL_ANCHOR_FORMULAS, kotwica: =ARRAYFORMULA/],
    ['(ii) ARRAYFORMULA(SUM(A2:A)) przy innym wzorcu', { fk: '=ARRAYFORMULA(SUM(A2:A))' }, { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, /K: kotwica różna od zatwierdzonego wzorca, kotwica: =ARRAYFORMULA\(SUM\(A2:A\)\)/],
    ['(iii) kotwica różna od wzorca jednym znakiem', { fk: zly }, { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, /K: kotwica różna od zatwierdzonego wzorca/],
    ['(iv) formuła skalarna w K1 i literały pod nią', { fk: '=G2*I2' }, { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, /K: kotwica różna od zatwierdzonego wzorca, kotwica: =G2\*I2/],
    ['(v) formuły wpisane w wiersze', { fk: null, formulyNizej: [[2, 10, '=G2*I2'], [3, 10, '=G3*I3'], [4, 10, '=G4*I4']] }, { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, /K: więcej niż jedna formuła \(3\), kotwica: =G2\*I2/],
    ['(vi) same literały', { fk: null, fl: null }, { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, /K: brak formuły, kotwica: brak formuły; L: brak formuły/],
    ['(vii) kotwica zgodna, wartość #REF!', { ref: true }, { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, /K: wartość kotwicy to błąd \(#REF!\)/],
    ['(viii) kotwica zgodna i druga formuła niżej', { formulyNizej: [[4, 10, '=G4*I4']] }, { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, /K: więcej niż jedna formuła \(2\)/],
    ['(ix) kotwica w wierszu 3', { fk: null, formulyNizej: [[3, 10, FK]] }, { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, /K: kotwica w wierszu 3, a nie 1 albo 2/],
    ['(x) K zgodna, L nie', { fl: '=A2' }, { GSC_KL_ANCHOR_FORMULAS: WZORZEC }, /^K–L: zapis całej zakładki, bo L: kotwica różna od zatwierdzonego wzorca, kotwica: =A2$/],
    ['(xi) niepoprawny JSON właściwości', {}, { GSC_KL_ANCHOR_FORMULAS: '{K:' }, /K: brak zatwierdzonego wzorca/],
    ['(xi) JSON bez klucza L', {}, { GSC_KL_ANCHOR_FORMULAS: JSON.stringify({ K: FK }) }, /^K–L: zapis całej zakładki, bo L: brak zatwierdzonego wzorca/],
    ['(xi) JSON, który nie jest obiektem', {}, { GSC_KL_ANCHOR_FORMULAS: '"tekst"' }, /K: brak zatwierdzonego wzorca/]
  ];

  for (const [nazwa, uklad, props, ostrzezenie] of przypadki) {
    test('7b ' + nazwa, () => {
      const raw = zakladka(Object.assign({ dane: [stary, CEL, stary] }, uklad));
      if (uklad.ref) raw.rows[0][10] = '#REF!';
      const gas = projekt({ raw, properties: props });
      const formulyPrzed = formulyKL(gas);
      const wartosciPrzed = wartosciKL(gas);

      const out = plain(gas.importDzienny({ triggerUid: 't' }));

      assert.equal(rekord(gas).lastRun.ok, true, 'import się udał');
      const ops = zapisy(gas);
      assert.deepEqual(ops.filter(e => e[0] === 'clearContent').map(e => e.slice(2)), [[2, 1, 3, 10]], 'stara ścieżka: replaceRange_');
      assert.deepEqual(ops.filter(e => e[0] === 'deleteRows'), []);
      assert.deepEqual(ops.filter(dotykaKL), [], 'żadnego zapisu w K–L');
      assert.deepEqual(formulyKL(gas), formulyPrzed, 'formuły K–L bez zmian');
      assert.deepEqual(wartosciKL(gas), wartosciPrzed, 'wartości K–L bez zmian');
      const uwaga = out.warning.split(' | ').find(w => /^K–L/.test(w));
      assert.match(uwaga, ostrzezenie);
      assert.ok(gas.$console.some(([, t]) => t.startsWith('[import GSC] kotwice K–L (pełny tekst): ')), 'pełny tekst kotwic w logu');
    });
  }

  test('7b: ostrzeżenie obcina kotwicę do 200 znaków, log ma pełny tekst', () => {
    const dluga = '=ARRAYFORMULA(IF(A2:A="",,' + 'G2:G+'.repeat(60) + '0))';
    const gas = projekt({ raw: zakladka({ dane: [stary], fk: dluga }), properties: { GSC_KL_ANCHOR_FORMULAS: WZORZEC } });
    const out = plain(gas.importDzienny({ triggerUid: 't' }));
    assert.ok(out.warning.includes(dluga.slice(0, 200)));
    assert.ok(!out.warning.includes(dluga));
    assert.ok(gas.$console.some(([, t]) => t.includes(JSON.stringify(dluga))));
  });
});

describe('#209: czas etapów w logu wykonania', () => {
  const etapy = (gas, zrodlo) => gas.$console.map(([, t]) => t).filter(t => t.startsWith('[import ' + zrodlo + '] ') && !t.includes('kotwice'))
    .map(t => t.replace(/^\[import \w+\] /, '').replace(/ \(\d+[^)]*\)/g, '').replace(/: \d+ ms.*$/, ''));

  test('9: GSC, sukces — etapy w kolejności, każdy z czasem i czasem od startu', () => {
    const gas = projekt({ raw: { rows: [HEADER, [localDate(20), 'q', '/p', 'pol', 'MOBILE', 1, 1, 0.1, 1, '']] } });
    gas.importDzienny({ triggerUid: 't' });
    assert.deepEqual(etapy(gas, 'GSC'), ['zapytania API', 'rozpoznanie K–L', 'odczyt arkusza', 'czyszczenie', 'zapis całej zakładki', 'formaty', 'obsługa wyniku']);
    assert.ok(gas.$console.every(([, t]) => !t.startsWith('[import GSC] zapytania') || /: \d+ ms \(od startu \d+ ms\)$/.test(t)));
  });

  test('9: GSC, nowa ścieżka — etapy usunięcia i dopisania', () => {
    const gas = projekt({ raw: zakladka({ dane: [CEL] }), properties: { GSC_KL_ANCHOR_FORMULAS: WZORZEC } });
    gas.importDzienny({ triggerUid: 't' });
    assert.deepEqual(etapy(gas, 'GSC'), ['zapytania API', 'rozpoznanie K–L', 'odczyt kolumny A', 'usunięcie wierszy importowanych dni', 'dopisanie wierszy', 'formaty', 'obsługa wyniku']);
  });

  test('9: GSC, błąd w środku — logi do etapu, w którym padł', () => {
    const raw = { rows: [HEADER, [localDate(20), 'q', '/p', 'pol', 'MOBILE', 1, 1, 0.1, 1, '']], maxRows: 3 };
    const gas = projekt({ raw, fetch: gscApi(5) });
    assert.throws(() => gas.importDzienny({ triggerUid: 't' }), /exceed the 3 rows/);
    assert.deepEqual(etapy(gas, 'GSC'), ['zapytania API', 'rozpoznanie K–L', 'odczyt arkusza', 'czyszczenie']);
  });

  test('9: GA4 — etapy zapytań i zapisu każdej zakładki', () => {
    const row = (dims, metrics) => ({ dimensionValues: dims.map(v => ({ value: v })), metricValues: metrics.map(v => ({ value: v })) });
    const raport = () => ({ code: 200, json: { rows: [row(['20260903', '/o', 'Organic Search', 'google / organic', '(not set)', 'mobile'], ['1', '1', '1', '0', '0.1'])], rowCount: 1 } });
    const sheets = {};
    for (const name of ['GA4 RAW', 'GA4 KEY EVENTS', 'GA4 BUSINESS EVENTS', 'GA4 ADS RAW']) sheets[name] = [['header']];
    const gas = projekt({ sheets, fetch: fetchRouter([[':runReport', raport]]) });
    gas.importGA4Dzienny();
    const lista = etapy(gas, 'GA4');
    assert.deepEqual(lista.slice(0, 4), ['API: landing', 'API: key events', 'API: zdarzenia biznesowe', 'API: Google Ads']);
    for (const name of ['GA4 RAW', 'GA4 KEY EVENTS', 'GA4 BUSINESS EVENTS', 'GA4 ADS RAW']) {
      assert.deepEqual(lista.filter(t => t.startsWith(name + ':')), [name + ': odczyt', name + ': czyszczenie i zapis', name + ': formaty']);
    }
    assert.equal(lista[lista.length - 1], 'obsługa wyniku');
  });
});
