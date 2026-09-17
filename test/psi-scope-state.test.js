'use strict';

/**
 * #179: o tym, czy niepowodzenie PSI jest szumem, decyduje wynik CAŁEGO zakresu.
 *
 * Wcześniej rozstrzygał sam kod HTTP: `>= 500` znaczyło „przejściowy”, więc
 * `400 FAILED_DOCUMENT_REQUEST` — Lighthouse nie załadował strony — przerywał
 * cały przebieg, a seria błędów 5xx kończyła się **zielonym zadaniem bez śladu**.
 * Teraz zakres `(URL, strategia)` ma trzy stany: `OK` (3 z 3), `OSTRZEŻENIE`
 * (1–2 z 3) i `NIEUDANY` (0 z 3), a wynik przebiegu wynika z ich zestawu.
 *
 * Numeracja odpowiada macierzy z opisu #179.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const URLS = 'PERFORMANCE URLS';
const LAB = 'PAGESPEED LAB';
const FINDINGS = 'PAGESPEED FINDINGS';
const LOG = 'IMPORT LOG';
const URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const URL = 'https://www.example.pl/';
const KEY = { PAGESPEED_API_KEY: 'klucz-testowy', ALERT_EMAIL: 'alerty@example.pl' };

const TIMEOUT_400 = {
  code: 400,
  text: '{"error":{"code":400,"message":"Lighthouse returned error: FAILED_DOCUMENT_REQUEST. Lighthouse was unable to reliably load the page you requested. (Details: net::ERR_TIMED_OUT)"}}'
};
const LIGHTHOUSE_500 = { code: 500, text: '{"error":{"errors":[{"domain":"lighthouse"}]}}' };

const psiBody = (lcp = 2500) => JSON.stringify({
  lighthouseResult: {
    categories: { performance: { score: 0.9 } },
    audits: { 'largest-contentful-paint': { numericValue: lcp } }
  }
});
const OK_200 = () => ({ code: 200, text: psiBody() });

/** Odpowiedzi PSI po kolei; CrUX zawsze 404 („za mało danych” to nie awaria). */
function project({ psi, urls = [[URL, 'homepage', '']], properties = KEY, sheets = {} } = {}) {
  let call = 0;
  return loadProject({
    properties: properties,
    sheets: Object.assign({ [URLS]: [URLS_HEADER].concat(urls) }, sheets),
    fetch: url => {
      if (String(url).indexOf('pagespeedonline') < 0) return { code: 404, text: '{}' };
      return psi(++call, String(url));
    }
  });
}

const labRows = gas => (gas.$sheet(LAB) || []).slice(1).filter(r => String(r[1] || '') !== '');
const findingRows = gas => (gas.$sheet(FINDINGS) || []).slice(1).filter(r => String(r[1] || '') !== '');
const logRows = gas => (gas.$sheet(LOG) || []).slice(1).filter(r => String(r[1] || '') !== '');
const scopeOf = (out, strategy) => out.scopes.filter(s => s.strategy === strategy)[0];
const subjects = gas => gas.$mails.map(m => m.subject);

describe('#179: stan zakresu (URL × strategia)', () => {
  test('1: trzy udane próby → OK, mediana z trzech', () => {
    const gas = project({ psi: OK_200 });
    const out = plain(gas.runPsiMeasurement_());

    assert.deepEqual(out.scopeCounts, { ok: 2, warning: 0, failed: 0 });
    assert.equal(scopeOf(out, 'mobile').state, 'OK');
    assert.equal(out.warning, '', 'komplet prób nie jest ostrzeżeniem');
    assert.equal(labRows(gas).filter(r => r[2] === 'mobile').length, 6, 'trzy próby × dwie metryki');
  });

  test('2: dwie udane i jeden timeout → OSTRZEŻENIE, wynik zachowany', () => {
    const gas = project({ psi: call => (call === 2 ? TIMEOUT_400 : OK_200()) });
    const out = plain(gas.runPsiMeasurement_());

    const scope = scopeOf(out, 'mobile');
    assert.equal(scope.state, 'OSTRZEŻENIE');
    assert.equal(scope.ok, 2);
    assert.deepEqual(scope.kinds, ['HTTP 400 FAILED_DOCUMENT_REQUEST (net::ERR_TIMED_OUT)']);
    assert.equal(out.scopeCounts.failed, 0);
    assert.equal(out.warning, '', 'degradacja nie otwiera incydentu');
    assert.ok(labRows(gas).length > 0, 'udane próby zapisane');
  });

  test('3: jedna udana z trzech → nadal OSTRZEŻENIE, nie NIEUDANY', () => {
    const gas = project({ psi: call => (call === 1 ? OK_200() : LIGHTHOUSE_500) });
    const out = plain(gas.runPsiMeasurement_());

    const scope = scopeOf(out, 'mobile');
    assert.equal(scope.state, 'OSTRZEŻENIE');
    assert.equal(scope.ok, 1);
  });

  test('4: zero udanych w jednej strategii → NIEUDANY; druga strategia zapisana, diagnoza nietknięta', () => {
    const stara = [
      '2026-09-01 10:00', URL, 'mobile', 1, 'ELEMENT LCP', 'x', 'section.stary',
      '', '', '', '', 'PSI_LAB', '2026-09-01', 'ręczny'
    ];
    const gas = project({
      psi: (call, url) => (url.indexOf('strategy=mobile') > 0 ? TIMEOUT_400 : OK_200()),
      sheets: { [FINDINGS]: [[
        'Pomiar', 'URL', 'Strategia', 'Próba', 'Rodzaj', 'Nazwa', 'Szczegół', 'Czas (ms)', 'Transfer (KiB)',
        'Potencjalna oszczędność (ms)', 'Potencjalna oszczędność (KiB)', 'Źródło', 'Pobrano', 'Wyzwolenie'
      ], stara] }
    });
    const out = plain(gas.runPsiMeasurement_());

    assert.equal(scopeOf(out, 'mobile').state, 'NIEUDANY');
    assert.equal(scopeOf(out, 'desktop').state, 'OK');
    assert.deepEqual(out.scopeCounts, { ok: 1, warning: 0, failed: 1 });
    assert.match(out.warning, /PSI nie zdołał zmierzyć adresu w żadnej z 3 prób/);
    assert.deepEqual([...new Set(labRows(gas).map(r => r[2]))], ['desktop'], 'dane drugiej strategii zapisane');
    assert.ok(findingRows(gas).some(r => r[6] === 'section.stary'), 'diagnoza zakresu NIEUDANY nietknięta');
  });

  test('11: odpowiedź 2xx bez metryk jest nieudaną próbą', () => {
    const gas = project({
      psi: (call, url) => (url.indexOf('strategy=mobile') > 0 ? { code: 200, text: '{}' } : OK_200())
    });
    const out = plain(gas.runPsiMeasurement_());

    assert.equal(scopeOf(out, 'mobile').state, 'NIEUDANY');
    assert.deepEqual(scopeOf(out, 'mobile').kinds, ['brak metryk', 'brak metryk', 'brak metryk']);
  });

  test('11b: odpowiedź 2xx, której nie da się sparsować, też jest nieudaną próbą', () => {
    // Pośrednik potrafi oddać HTTP 200 ze stroną błędu w HTML-u. Wyjątek składni
    // z `JSON.parse` wywracałby cały przebieg — razem z zakresami zmierzonymi
    // wcześniej — choć jest dokładnie tym samym, co każda inna nieudana próba.
    const gas = project({
      psi: (call, url) => (url.indexOf('strategy=mobile') > 0
        ? { code: 200, text: '<html>Service Unavailable</html>' }
        : OK_200())
    });
    const out = plain(gas.runPsiMeasurement_());

    assert.equal(scopeOf(out, 'mobile').state, 'NIEUDANY');
    assert.deepEqual(scopeOf(out, 'mobile').kinds,
      ['nieczytelna odpowiedź', 'nieczytelna odpowiedź', 'nieczytelna odpowiedź']);
    assert.equal(scopeOf(out, 'desktop').state, 'OK', 'śmieci w jednym zakresie nie psują drugiego');
  });

  test('10: wyjątek z żądania jest nieudaną próbą, nie awarią przebiegu', () => {
    const gas = project({
      psi: (call, url) => {
        if (url.indexOf('strategy=mobile') > 0) throw new Error('Address unavailable: dns');
        return OK_200();
      }
    });
    const out = plain(gas.runPsiMeasurement_());

    assert.equal(scopeOf(out, 'mobile').state, 'NIEUDANY');
    assert.match(scopeOf(out, 'mobile').kinds[0], /^wyjątek: Address unavailable/);
    assert.equal(scopeOf(out, 'desktop').state, 'OK', 'druga strategia mierzona normalnie');
  });
});

describe('#179: wynik przebiegu', () => {
  const cyklicznie = gas => {
    try { gas.pomiarWydajnosciCykliczny(); return null; } catch (e) { return e; }
  };

  test('4: częściowa awaria → zadanie OK z ostrzeżeniem i mailem UWAGA', () => {
    const gas = project({ psi: (call, url) => (url.indexOf('strategy=mobile') > 0 ? TIMEOUT_400 : OK_200()) });
    assert.equal(cyklicznie(gas), null, 'przebieg z danymi nie jest awarią zadania');

    const record = JSON.parse(gas.$properties.LAST_RUN_PERFORMANCE);
    assert.equal(record.lastRun.ok, true);
    assert.match(record.lastRun.warning, /PSI nie zdołał zmierzyć adresu/);
    assert.match(record.lastRun.detail, /zakresy: OK 1 \| z ostrzeżeniem 0 \| nieudane 1/);
    assert.deepEqual(subjects(gas), ['[wordpress-automation] UWAGA: pomiar wydajności']);
    assert.match(gas.$mails[0].body, /net::ERR_TIMED_OUT/);
  });

  test('5 i 7: wszystkie zmierzone zakresy NIEUDANE → zadanie ok:false i mail BŁĄD', () => {
    for (const odpowiedz of [TIMEOUT_400, LIGHTHOUSE_500]) {
      const gas = project({ psi: () => odpowiedz });
      const error = cyklicznie(gas);

      assert.ok(error, 'przebieg bez ani jednego pomiaru jest awarią: ' + odpowiedz.code);
      const record = JSON.parse(gas.$properties.LAST_RUN_PERFORMANCE);
      assert.equal(record.lastRun.ok, false);
      assert.deepEqual(subjects(gas), ['[wordpress-automation] BŁĄD importu: pomiar wydajności']);
      assert.equal(gas.$properties.PAGESPEED_CURSOR, '0', 'kursor przesunięty mimo awarii');
      assert.match(String(gas.$properties.PAGESPEED_BUDGET_STATE), / 6$/, 'budżet zapisany');
    }
  });

  test('6: jeden adres martwy, drugi zmierzony → ostrzeżenie, dane drugiego zapisane', () => {
    const martwy = 'https://www.example.pl/martwy/';
    const gas = project({
      urls: [[martwy, 'landing', ''], [URL, 'homepage', '']],
      psi: (call, url) => (url.indexOf(encodeURIComponent(martwy)) > 0 ? TIMEOUT_400 : OK_200())
    });
    assert.equal(cyklicznie(gas), null);

    const record = JSON.parse(gas.$properties.LAST_RUN_PERFORMANCE);
    assert.match(record.lastRun.detail, /zakresy: OK 2 \| z ostrzeżeniem 0 \| nieudane 2/);
    assert.deepEqual([...new Set(labRows(gas).map(r => r[1]))], [URL], 'zapisany adres, który się zmierzył');
    assert.equal(gas.$properties.PAGESPEED_CURSOR, '0', 'rotacja przeszła przez oba adresy');
  });

  test('8 i 9: 403 i 429 przerywają przebieg natychmiast, bez przesuwania kursora', () => {
    for (const code of [403, 429]) {
      const gas = project({ psi: () => ({ code: code, text: '{}' }) });
      assert.ok(cyklicznie(gas), 'błąd konfiguracji/limitu jest awarią: ' + code);

      assert.equal(gas.$properties.PAGESPEED_CURSOR, undefined, 'adres nie został ukończony');
      assert.match(String(gas.$properties.PAGESPEED_BUDGET_STATE), / 1$/, 'jedno wykonane żądanie policzone');
    }
  });

  test('12: brak rozpoczętych adresów (budżet) nie jest awarią', () => {
    const gas = project({
      psi: OK_200,
      properties: Object.assign({}, KEY, { PAGESPEED_DAILY_BUDGET: '1' })
    });
    assert.equal(cyklicznie(gas), null);

    const record = JSON.parse(gas.$properties.LAST_RUN_PERFORMANCE);
    assert.equal(record.lastRun.ok, true);
    assert.equal(record.lastRun.warning, '', 'wyczerpany budżet to nie ostrzeżenie o pomiarze');
    assert.deepEqual(subjects(gas), []);
  });
});

describe('#179: incydent, ślad i komunikaty', () => {
  test('13: ostrzeżenie milknie przy otwartym incydencie i zamyka się własnym mailem', () => {
    let tryb = 'awaria';
    const gas = project({
      psi: (call, url) => {
        if (tryb === 'ok') return OK_200();
        return url.indexOf('strategy=mobile') > 0 ? TIMEOUT_400 : OK_200();
      }
    });

    gas.pomiarWydajnosciCykliczny();
    assert.deepEqual(subjects(gas), ['[wordpress-automation] UWAGA: pomiar wydajności']);

    gas.pomiarWydajnosciCykliczny();
    assert.equal(gas.$mails.length, 1, 'przy otwartym incydencie kolejne ostrzeżenie milczy');

    tryb = 'ok';
    gas.pomiarWydajnosciCykliczny();
    assert.deepEqual(subjects(gas)[1], '[wordpress-automation] Zadanie wróciło do normy: pomiar wydajności');
    assert.match(gas.$mails[1].body, /\(warning\)/, 'mail mówi, jaki incydent się zamknął');
  });

  test('14: każdy przebieg cykliczny zostawia wiersz w IMPORT LOG', () => {
    const wynik = { OK: OK_200, UWAGA: (call, url) => (url.indexOf('strategy=mobile') > 0 ? TIMEOUT_400 : OK_200()), 'BŁĄD': () => TIMEOUT_400 };
    Object.keys(wynik).forEach(oczekiwany => {
      const gas = project({ psi: wynik[oczekiwany] });
      try { gas.pomiarWydajnosciCykliczny(); } catch { /* awaria też ma zostawić ślad */ }

      const rows = logRows(gas);
      assert.equal(rows.length, 1, oczekiwany + ': jeden wiersz na przebieg');
      assert.equal(rows[0][1], 'PERFORMANCE');
      assert.equal(rows[0][4], oczekiwany, 'wynik przebiegu w kolumnie „Wynik”');
      assert.equal(rows[0][2], 'trigger');
    });
  });

  test('15: wiersze PERFORMANCE nie wchodzą do bazy anomalii importów', () => {
    // Siedem udanych importów GA4 po 30 wierszy — pełne okno profilu.
    const LOG_HEADER = ['Czas', 'Źródło', 'Typ', 'Dni', 'Wynik', 'Wiersze', 'Czas [s]', 'Szczegóły', 'Błąd / uwaga'];
    const historia = [LOG_HEADER];
    for (let i = 1; i <= 7; i++) {
      historia.push(['2026-09-0' + i + ' 06:23:00', 'GA4', 'trigger', 1, 'OK', 30, 5, '', '']);
    }
    const gas = project({ psi: OK_200, sheets: { [LOG]: historia } });

    // `now` podane wprost: bez niego detektor liczy okno retencji od `run.finishedAt`,
    // którego ten sztuczny przebieg nie ma, i historia wypada poza oknem.
    const teraz = new gas.$Date(2026, 8, 17);
    const przed = gas.importAnomaly_('GA4', { rows: 14, trigger: true, days: 1 }, gas.importLogHistory_(), teraz);
    assert.match(String(przed), /mediana 30/, 'warunek wstępny: profil GA4 ma pełne okno z medianą 30');

    gas.pomiarWydajnosciCykliczny();

    assert.ok(logRows(gas).some(r => r[1] === 'PERFORMANCE'), 'ślad pomiaru dopisany');
    assert.equal(
      gas.importAnomaly_('GA4', { rows: 14, trigger: true, days: 1 }, gas.importLogHistory_(), teraz),
      przed,
      'mediana profilu GA4 bez zmian mimo wierszy PERFORMANCE w logu'
    );
  });

  test('16: alert i okno menu nie zgadują przyczyny', () => {
    const gas = project({ psi: (call, url) => (url.indexOf('strategy=mobile') > 0 ? TIMEOUT_400 : OK_200()) });
    gas.pomiarWydajnosciCykliczny();
    const mail = gas.$mails[0].body;

    assert.ok(mail.indexOf('niedostępn') < 0, 'alert nie twierdzi, że strona była niedostępna');
    assert.ok(mail.indexOf('losowo') < 0, 'ani że błąd jest losowy po stronie Google');

    const menu = project({ psi: (call, url) => (url.indexOf('strategy=mobile') > 0 ? TIMEOUT_400 : OK_200()) });
    menu.zmierzWydajnosc();
    const okno = menu.$alerts[menu.$alerts.length - 1][0];
    assert.match(okno, /zakresy: OK 1 \| z ostrzeżeniem 0 \| nieudane 1/);
    assert.ok(okno.indexOf('losowo po stronie Google') < 0);
  });

  test('17: licznik budżetu rośnie przed każdym żądaniem, także nieudanym', () => {
    const gas = project({ psi: call => (call % 2 === 0 ? TIMEOUT_400 : OK_200()) });
    const out = plain(gas.runPsiMeasurement_());

    assert.equal(out.budgetUsed, 6, 'sześć żądań: trzy próby × dwie strategie');
    assert.equal(out.budgetUsed, gas.$fetchCalls.filter(c => c.url.indexOf('pagespeedonline') > 0).length);
  });
});
