'use strict';

/**
 * #189 etap 1: przebieg ubity twardym limitem Apps Script jest widoczny,
 * a licznik budżetu PSI jest szczelny.
 *
 * 19.09.2026 przebieg `pomiarWydajnosciCykliczny` został ubity po 360,7 s i nie
 * zostawił żadnego śladu: twardy limit pomija `catch` i `finally`, więc nie było
 * ani rekordu, ani wiersza w IMPORT LOG, ani maila. Widać go było tylko
 * w rejestrze wykonań Apps Script.
 *
 * Numeracja odpowiada macierzy etapu 1 z opisu #189.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./helpers/gas');

const LOG = 'IMPORT LOG';
const MIN = 60 * 1000;
const NOTA = /nie zakończył się kontrolowanie — możliwe przerwanie przez limit czasu wykonania Apps Script; zakres zapisanych danych jest niepewny/;

const projekt = (opcje = {}) => loadProject(Object.assign({ properties: { ALERT_EMAIL: 'alerty@example.pl' } }, opcje));
const znaczniki = gas => Object.keys(gas.$properties).filter(k => k.indexOf('RUNNING_') === 0).sort();
const znacznik = (job, runId, startedAt) => JSON.stringify({ job, runId, startedAt, trigger: true });
const minutTemu = (gas, minut) => new Date(gas.$Date.now() - minut * MIN).toISOString();
const logi = gas => (gas.$sheet(LOG) || []).slice(1).filter(r => String(r[1] || '') !== '');
const tematy = gas => gas.$mails.map(m => m.subject);
const rekord = (gas, prop) => JSON.parse(gas.$properties[prop]);
const udany = () => ({ rows: 1, detail: 'ok' });
/** Wiersze za porzucone wykonania — `BŁĄD` z treścią. Bieżący przebieg niesie tę treść w `UWAGA`, więc go pomijamy. */
const raportyPorzuconych = gas => logi(gas).filter(r => r[4] === 'BŁĄD' && NOTA.test(String(r[8])));

describe('#189: znacznik wykonania', () => {
  test('1: udany przebieg zakłada znacznik przed pracą i usuwa go po niej', () => {
    const gas = projekt();
    let wTrakcie = null;
    let wartosc = null;
    gas.recordJobRun_('PERFORMANCE', true, () => {
      wTrakcie = znaczniki(gas);
      wartosc = JSON.parse(gas.$properties[wTrakcie[0]]);
      return udany();
    });

    assert.equal(wTrakcie.length, 1, 'znacznik istnieje w trakcie pracy');
    assert.equal(wTrakcie[0], 'RUNNING_PERFORMANCE_' + wartosc.runId);
    assert.equal(wartosc.job, 'PERFORMANCE');
    assert.equal(wartosc.trigger, true);
    assert.ok(!Number.isNaN(Date.parse(wartosc.startedAt)), 'start w postaci ISO');
    assert.deepEqual(znaczniki(gas), [], 'po kontrolowanym zakończeniu znika');
  });

  test('2: nieudany przebieg też usuwa własny znacznik; rekord i IMPORT LOG jak dotąd', () => {
    const gas = projekt();
    assert.throws(() => gas.recordJobRun_('PERFORMANCE', true, () => { throw new Error('boom'); }), /boom/);

    assert.deepEqual(znaczniki(gas), []);
    assert.equal(rekord(gas, 'LAST_RUN_PERFORMANCE').lastRun.error, 'boom', 'bez dopisków, gdy nic nie porzucono');
    assert.deepEqual(logi(gas).map(r => r[4]), ['BŁĄD']);
  });

  test('5: znacznik młodszy niż 7 min może należeć do żyjącego wykonania — nie jest ruszany', () => {
    const gas = projekt();
    gas.$properties.RUNNING_PERFORMANCE_mlody = znacznik('PERFORMANCE', 'mlody', minutTemu(gas, 3));
    gas.recordJobRun_('PERFORMANCE', true, udany);

    assert.ok('RUNNING_PERFORMANCE_mlody' in gas.$properties, 'nietknięty');
    assert.equal(rekord(gas, 'LAST_RUN_PERFORMANCE').lastRun.warning, '');
    assert.deepEqual(tematy(gas), []);
    assert.deepEqual(gas.$lock, [], 'nie ma czego odzyskać — bez blokady, którą współdzielą wszystkie zadania');
  });
});

describe('#189: odzysk porzuconego wykonania', () => {
  test('3: porzucony znacznik + udany przebieg → wiersz BŁĄD z pustym czasem, ostrzeżenie i mail UWAGA', () => {
    const gas = projekt();
    const start = minutTemu(gas, 8);
    gas.$properties.RUNNING_PERFORMANCE_stary = znacznik('PERFORMANCE', 'stary', start);
    gas.recordJobRun_('PERFORMANCE', true, udany);

    const [porzucony, biezacy] = logi(gas);
    assert.equal(porzucony[0].getTime(), Date.parse(start), 'czas wiersza = start porzuconego');
    assert.equal(porzucony[4], 'BŁĄD');
    assert.equal(porzucony[6], '', 'czas trwania nieznany: pusta komórka, nie zero');
    assert.match(String(porzucony[8]), NOTA);
    assert.ok(String(porzucony[8]).indexOf('nie zostały zapisane') < 0, 'treść nie przesądza losu danych');
    assert.equal(biezacy[4], 'UWAGA', 'bieżący przebieg udany z ostrzeżeniem');

    const r = rekord(gas, 'LAST_RUN_PERFORMANCE');
    assert.equal(r.lastRun.ok, true);
    assert.match(r.lastRun.warning, NOTA);
    assert.deepEqual(tematy(gas), ['[wordpress-automation] UWAGA: pomiar wydajności']);
    assert.deepEqual(znaczniki(gas), [], 'porzucony odebrany, własny usunięty');
  });

  test('4: porzucony znacznik + nieudany przebieg → dwa wiersze BŁĄD, treść dołączona do błędu', () => {
    const gas = projekt();
    gas.$properties.RUNNING_PERFORMANCE_stary = znacznik('PERFORMANCE', 'stary', minutTemu(gas, 8));
    assert.throws(() => gas.recordJobRun_('PERFORMANCE', true, () => { throw new Error('bieżący padł'); }), /bieżący padł/);

    assert.deepEqual(logi(gas).map(r => r[4]), ['BŁĄD', 'BŁĄD']);
    const blad = rekord(gas, 'LAST_RUN_PERFORMANCE').lastRun.error;
    assert.match(blad, /^bieżący padł \| poprzedni przebieg \(start /, 'najpierw własny błąd, potem porzucony');
    assert.match(blad, NOTA);
    assert.deepEqual(tematy(gas), ['[wordpress-automation] BŁĄD importu: pomiar wydajności']);
  });

  test('9a: porzucony znacznik raportowany raz — kolejny przebieg go nie powtarza', () => {
    const gas = projekt();
    gas.$properties.RUNNING_PERFORMANCE_stary = znacznik('PERFORMANCE', 'stary', minutTemu(gas, 8));
    gas.recordJobRun_('PERFORMANCE', true, udany);
    gas.recordJobRun_('PERFORMANCE', true, udany);

    assert.equal(raportyPorzuconych(gas).length, 1);
    assert.equal(rekord(gas, 'LAST_RUN_PERFORMANCE').lastRun.warning, '', 'drugi przebieg bez ostrzeżenia');
  });

  test('9: dwa starty w tej samej chwili — odzysk pod blokadą raportuje dokładnie raz', () => {
    const gas = projekt();
    gas.$properties.RUNNING_PERFORMANCE_stary = znacznik('PERFORMANCE', 'stary', minutTemu(gas, 8));
    // Drugie wykonanie startuje, zanim pierwsze skończyło pracę.
    gas.recordJobRun_('PERFORMANCE', true, () => {
      gas.recordJobRun_('PERFORMANCE', true, udany);
      return udany();
    });

    assert.equal(raportyPorzuconych(gas).length, 1, 'jeden wiersz za porzucony');
    assert.deepEqual(gas.$lock.slice(0, 2), [['tryLock', 3000], ['releaseLock']], 'odbiór pod krótką blokadą');
  });

  test('9b: odbiór usuwa znacznik przed zwolnieniem blokady — drugi odczyt niczego nie znajduje', () => {
    const gas = projekt();
    gas.$properties.RUNNING_PERFORMANCE_stary = znacznik('PERFORMANCE', 'stary', minutTemu(gas, 8));
    const teraz = gas.$Date.now();

    assert.equal(gas.reclaimAbandonedRuns_('PERFORMANCE', teraz).length, 1);
    assert.equal(gas.reclaimAbandonedRuns_('PERFORMANCE', teraz).length, 0);
  });

  test('10: blokada zajęta → odzysk pominięty bez błędu, porzucony czeka na kolejny przebieg', () => {
    const gas = projekt({ lockHeld: true });
    gas.$properties.RUNNING_PERFORMANCE_stary = znacznik('PERFORMANCE', 'stary', minutTemu(gas, 8));
    gas.recordJobRun_('PERFORMANCE', true, udany);

    assert.deepEqual(znaczniki(gas), ['RUNNING_PERFORMANCE_stary'], 'porzucony został, własny usunięty');
    assert.equal(rekord(gas, 'LAST_RUN_PERFORMANCE').lastRun.ok, true, 'diagnostyka nie blokuje zadania');
    assert.equal(rekord(gas, 'LAST_RUN_PERFORMANCE').lastRun.warning, '');
  });

  test('11: znacznik innego zadania o wspólnym prefiksie klucza i nieczytelna wartość — nietknięte', () => {
    const gas = projekt();
    gas.$properties.RUNNING_SEO_LIVE_X_obcy = znacznik('SEO_LIVE_X', 'obcy', minutTemu(gas, 8));
    gas.$properties.RUNNING_SEO_LIVE_zepsuty = 'to nie jest JSON';
    gas.recordJobRun_('SEO_LIVE', true, udany);

    assert.deepEqual(znaczniki(gas), ['RUNNING_SEO_LIVE_X_obcy', 'RUNNING_SEO_LIVE_zepsuty']);
    assert.equal(rekord(gas, 'LAST_RUN_SEO_LIVE').lastRun.warning, '');
  });

  test('12: zadanie bez log:true — bez wiersza w IMPORT LOG, ale z ostrzeżeniem i mailem', () => {
    const gas = projekt();
    gas.$properties.RUNNING_SEO_LIVE_stary = znacznik('SEO_LIVE', 'stary', minutTemu(gas, 8));
    gas.recordJobRun_('SEO_LIVE', true, udany);

    assert.deepEqual(logi(gas), []);
    assert.match(rekord(gas, 'LAST_RUN_SEO_LIVE').lastRun.warning, NOTA);
    assert.deepEqual(tematy(gas), ['[wordpress-automation] UWAGA: live check SEO']);
  });
});

describe('#189: wyścig nakładających się wykonań', () => {
  test('6: B biegnie w trakcie A i zapisuje rekord oraz incydent ze swojej kopii — znacznik A przetrwa', () => {
    const gas = projekt();
    let znacznikA = null;
    let gdyBKonczy = null;
    gas.recordJobRun_('PERFORMANCE', true, () => {
      znacznikA = znaczniki(gas);
      // B kończy się ostrzeżeniem, więc zapisuje rekord i otwiera incydent.
      gas.recordJobRun_('PERFORMANCE', true, () => ({ rows: 1, detail: 'B', warning: 'B ostrzega' }));
      gdyBKonczy = znaczniki(gas);
      return udany();
    });

    assert.equal(znacznikA.length, 1);
    assert.deepEqual(gdyBKonczy, znacznikA, 'B usunęło tylko swój znacznik; znacznik A istnieje');
    assert.deepEqual(znaczniki(gas), [], 'po końcu A nie ma żadnego');
    assert.ok(!logi(gas).some(r => NOTA.test(String(r[8]))), 'żadne nie uznało drugiego za porzucone');
  });

  test('7: A kończy się w trakcie B, a B pada — B nie odtwarza znacznika A', () => {
    const gas = projekt();
    const runIdA = gas.startRunMarker_('PERFORMANCE', true, gas.$Date.now());
    const kluczA = 'RUNNING_PERFORMANCE_' + runIdA;

    assert.throws(() => gas.recordJobRun_('PERFORMANCE', true, () => {
      gas.clearRunMarker_('PERFORMANCE', runIdA);
      throw new Error('B padło');
    }), /B padło/);

    assert.ok(!(kluczA in gas.$properties), 'znacznik A nie wrócił');
    assert.deepEqual(znaczniki(gas), [], 'B usunęło własny');
  });

  test('8: zapis rekordu przez obsługę incydentu ze starej kopii nie dotyka znaczników', () => {
    const gas = projekt();
    const staraKopia = gas.readJobRecord_('PERFORMANCE');
    let przed = null;
    let po = null;
    gas.recordJobRun_('PERFORMANCE', true, () => {
      przed = znaczniki(gas);
      staraKopia.lastRun = { finishedAt: new gas.$Date().toISOString(), ok: false, trigger: true, error: 'x' };
      gas.updateImportIncident_('PERFORMANCE', staraKopia);
      po = znaczniki(gas);
      return udany();
    });

    assert.equal(przed.length, 1);
    assert.deepEqual(po, przed, 'incydent zapisany, znacznik nietknięty');
  });
});

describe('#189: licznik budżetu PSI i czas żądań', () => {
  const URL = 'https://www.example.pl/';
  const KLUCZ = 'AIzaTAJNY-klucz-testowy';
  const psiBody = JSON.stringify({
    lighthouseResult: {
      categories: { performance: { score: 0.9 } },
      audits: { 'largest-contentful-paint': { numericValue: 2500 } }
    }
  });

  function pomiar(psi) {
    const stany = [];
    let n = 0;
    const gas = loadProject({
      properties: { PAGESPEED_API_KEY: KLUCZ },
      sheets: { 'PERFORMANCE URLS': [['URL', 'Rola', 'Uwagi'], [URL, 'homepage', '']] },
      fetch: url => {
        if (String(url).indexOf('pagespeedonline') < 0) return { code: 404, text: '{}' };
        n++;
        // Stan licznika w chwili, gdy żądanie jest w toku — przed jego końcem i przed `finally`.
        stany.push(gas.$properties.PAGESPEED_BUDGET_STATE);
        return psi(n);
      }
    });
    return { gas, stany };
  }

  test('13: wyjątek wewnątrz UrlFetchApp.fetch przy 4. żądaniu — licznik 4 zapisany przed tym żądaniem', () => {
    const { gas, stany } = pomiar(n => {
      if (n === 4) throw new Error('Przekroczono maksymalny czas wykonywania');
      return { code: 200, text: psiBody };
    });
    gas.runPsiMeasurement_();

    assert.match(String(stany[3]), / 4$/, 'ubicie w trakcie żądania nie gubi tej próby z licznika');
  });

  test('14: zapis licznika poprzedza każde żądanie PSI', () => {
    const { gas, stany } = pomiar(() => ({ code: 200, text: psiBody }));
    gas.runPsiMeasurement_();

    assert.equal(stany.length, 6);
    stany.forEach((stan, i) => assert.match(String(stan), new RegExp(' ' + (i + 1) + '$'), 'żądanie ' + (i + 1)));
  });

  test('15: każde żądanie CrUX i PSI zostawia linię z czasem, źródłem, zakresem, próbą i wynikiem', () => {
    const { gas } = pomiar(n => (n === 2 ? { code: 500, text: '{}' } : { code: 200, text: psiBody }));
    gas.runPerformanceMeasurement_('ręczny');

    const linie = gas.$console.filter(([, text]) => text.indexOf('[czas żądania]') === 0).map(([, text]) => text);
    const psi = linie.filter(l => l.indexOf('] PSI |') > 0);
    const crux = linie.filter(l => l.indexOf('] CrUX |') > 0);
    assert.equal(psi.length, 6, 'sześć żądań PSI');
    assert.equal(crux.length, 4, 'adres i domena dla dwóch form factorów');
    assert.match(psi[0], /^\[czas żądania\] PSI \| https:\/\/www\.example\.pl\/ \(mobile\) \| próba 1 \| \d+ ms \| OK$/);
    assert.match(psi[1], /\| próba 2 \| \d+ ms \| HTTP 500$/, 'nieudana próba z rodzajem błędu');
    assert.match(crux[1], /^\[czas żądania\] CrUX \| https:\/\/www\.example\.pl \(PHONE, dane domeny\) \| próba 1 \| \d+ ms \| brak danych$/);
  });

  test('15b: błąd przerywający PSI też zostawia linię z rodzajem', () => {
    const { gas } = pomiar(() => ({ code: 403, text: '{}' }));
    assert.throws(() => gas.runPsiMeasurement_(), /Odmowa dostępu \(403\)/);

    const psi = gas.$console.map(([, text]) => text).filter(l => l.indexOf('[czas żądania] PSI') === 0);
    assert.deepEqual(psi.map(l => l.split(' | ').pop()), ['HTTP 403']);
  });

  test('16: log czasu nie zawiera endpointu ani klucza', () => {
    const { gas } = pomiar(() => ({ code: 200, text: psiBody }));
    gas.runPerformanceMeasurement_('ręczny');

    const wszystko = gas.$console.map(([, text]) => text).join('\n');
    assert.ok(wszystko.length > 0);
    assert.ok(wszystko.indexOf(KLUCZ) < 0, 'bez klucza');
    assert.ok(wszystko.indexOf('key=') < 0, 'bez parametru klucza');
    assert.ok(wszystko.indexOf('googleapis.com') < 0, 'bez adresu endpointu');
  });
});
