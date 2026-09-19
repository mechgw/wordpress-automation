'use strict';

/**
 * #187: przejściowy błąd CrUX nie przerywa pomiaru, a awaria jednego źródła
 * nie zabiera danych drugiego.
 *
 * 17.09.2026 jeden `503 UNAVAILABLE` z CrUX zabił trzy przebiegi — razem z PSI,
 * który nie zdążył wysłać ani jednego żądania, bo CrUX idzie pierwszy. CrUX
 * i PSI to dwa osobne API Google, włączane osobno dla tego samego klucza, więc
 * nawet `403` z CrUX nic nie mówi o PSI.
 *
 * Numeracja odpowiada macierzy z opisu #187.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const URLS = 'PERFORMANCE URLS';
const FIELD = 'CWV FIELD';
const LAB = 'PAGESPEED LAB';
const LOG = 'IMPORT LOG';
const URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const FIELD_HEADER = ['Okres do', 'URL', 'Form factor', 'Metryka', 'p75', 'Stan', 'Źródło', 'Pobrano'];
const URL = 'https://www.example.pl/';
const KEY = { PAGESPEED_API_KEY: 'klucz-testowy', ALERT_EMAIL: 'alerty@example.pl' };
const COL = { url: 1, form: 2, metric: 3, p75: 4, state: 5, source: 6 };

const rekord = (lcp = 2100) => JSON.stringify({
  record: {
    collectionPeriod: { lastDate: { year: 2026, month: 9, day: 1 } },
    metrics: {
      largest_contentful_paint: { percentiles: { p75: lcp } },
      interaction_to_next_paint: { percentiles: { p75: 180 } },
      cumulative_layout_shift: { percentiles: { p75: 0.05 } }
    }
  }
});
const DANE = { code: 200, text: rekord() };
const BRAK = { code: 404, text: '{}' };
// Treść z produkcji, 17.09.2026.
const NIEDOSTEPNY = {
  code: 503,
  text: '{"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}'
};

const psiBody = () => JSON.stringify({
  lighthouseResult: {
    categories: { performance: { score: 0.9 } },
    audits: { 'largest-contentful-paint': { numericValue: 2500 } }
  }
});
const PSI_OK = () => ({ code: 200, text: psiBody() });
const PSI_TIMEOUT = () => ({
  code: 400,
  text: '{"error":{"code":400,"message":"Lighthouse returned error: FAILED_DOCUMENT_REQUEST. (Details: net::ERR_TIMED_OUT)"}}'
});

/**
 * `crux(body, n)` dostaje treść żądania (adres albo domena i form factor) i numer
 * żądania CrUX w przebiegu; `psi(n, url)` — numer żądania PSI i jego adres.
 */
function project({ crux, psi = PSI_OK, urls = [[URL, 'homepage', '']], sheets = {}, properties = KEY } = {}) {
  let cruxCall = 0;
  let psiCall = 0;
  return loadProject({
    properties: properties,
    sheets: Object.assign({ [URLS]: [URLS_HEADER].concat(urls) }, sheets),
    fetch: (url, params) => {
      if (String(url).indexOf('chromeuxreport') >= 0) return crux(JSON.parse(params.payload), ++cruxCall);
      if (String(url).indexOf('pagespeedonline') >= 0) return psi(++psiCall, String(url));
      return { code: 404, text: '{}' };
    }
  });
}

const polaCrux = gas => (gas.$sheet(FIELD) || []).slice(1).filter(r => String(r[COL.url] || '') !== '');
const proby = gas => (gas.$sheet(LAB) || []).slice(1).filter(r => String(r[1] || '') !== '');
const logi = gas => (gas.$sheet(LOG) || []).slice(1).filter(r => String(r[1] || '') !== '');
/** Treści żądań CrUX w kolejności — `{ url | origin, formFactor }`. */
const zadaniaCrux = gas => gas.$fetchCalls
  .filter(c => String(c.url).indexOf('chromeuxreport') >= 0)
  .map(c => JSON.parse(c.params.payload));
const ileZadan = (gas, cel, formFactor) => zadaniaCrux(gas)
  .filter(b => (b.url || b.origin) === cel && b.formFactor === formFactor).length;
const tematy = gas => gas.$mails.map(m => m.subject);
const rekordZadania = gas => JSON.parse(gas.$properties.LAST_RUN_PERFORMANCE);
const cyklicznie = gas => {
  try { gas.pomiarWydajnosciCykliczny(); return null; } catch (e) { return e; }
};
const trzyAdresy = [1, 2, 3].map(n => ['https://www.example.pl/' + n + '/', 'landing', '']);

describe('#187: nieudane żądanie CrUX jest wynikiem pary, nie końcem pomiaru', () => {
  test('1: 503, a po ponowieniu 200 → para zmierzona, bez ostrzeżenia', () => {
    const gas = project({ crux: (body, n) => (n === 1 ? NIEDOSTEPNY : DANE) });
    const out = plain(gas.runCruxMeasurement_());

    assert.equal(out.pairsOk, 2);
    assert.equal(out.failed, 0);
    assert.equal(ileZadan(gas, URL, 'PHONE'), 2, 'próba i jedno ponowienie');
    assert.equal(polaCrux(gas).length, 6, 'komplet: trzy metryki razy dwa form factory');
  });

  test('2: 503 dwa razy pod rząd → para nieudana, druga zapisana, bez markera', () => {
    const gas = project({ crux: body => (body.formFactor === 'PHONE' ? NIEDOSTEPNY : DANE) });
    const out = plain(gas.runCruxMeasurement_());

    assert.equal(ileZadan(gas, URL, 'PHONE'), 2, 'dokładnie jedno ponowienie, nie więcej');
    assert.deepEqual(out.failures, [URL + ' (PHONE): HTTP 503 ×2']);
    assert.equal(out.missing, 0, 'nieudane żądanie to nie „za mało danych”');
    assert.deepEqual([...new Set(polaCrux(gas).map(r => r[COL.form]))], ['DESKTOP'], 'druga para zapisana');
    assert.ok(!polaCrux(gas).some(r => r[COL.state] === 'INSUFFICIENT_DATA'),
      'marker jest twierdzeniem o ruchu, a nieudane żądanie do niego nie uprawnia');
    assert.equal(ileZadan(gas, 'https://www.example.pl', 'PHONE'), 0,
      'nieudane żądanie o adres nie uprawnia do sięgania po dane domeny');
  });

  test('3: 503 na OSTATNIEJ parze → wcześniejsze pary zapisane (dziś przepadały)', () => {
    const gas = project({
      urls: trzyAdresy,
      crux: body => (body.url === trzyAdresy[2][0] && body.formFactor === 'DESKTOP' ? NIEDOSTEPNY : DANE)
    });
    const out = plain(gas.runCruxMeasurement_());

    assert.equal(out.pairsOk, 5);
    assert.equal(out.failed, 1);
    assert.equal(polaCrux(gas).length, 15, 'pięć par razy trzy metryki');
  });

  test('4: wyjątek transportowy, po ponowieniu sukces → para zmierzona', () => {
    let pierwszy = true;
    const gas = project({
      crux: () => {
        if (pierwszy) { pierwszy = false; throw new Error('Address unavailable: dns'); }
        return DANE;
      }
    });
    const out = plain(gas.runCruxMeasurement_());

    assert.equal(out.pairsOk, 2);
    assert.equal(out.failed, 0);
  });

  test('5: 400 → para nieudana bez ponowienia, dokładnie jedno żądanie', () => {
    const gas = project({ crux: body => (body.formFactor === 'PHONE' ? { code: 400, text: '{}' } : DANE) });
    const out = plain(gas.runCruxMeasurement_());

    assert.equal(ileZadan(gas, URL, 'PHONE'), 1, 'identyczne ponowienie błędu żądania niczego nie zmieni');
    assert.deepEqual(out.failures, [URL + ' (PHONE): HTTP 400 ×1']);
  });

  test('5b: 200 z nieczytelną treścią → para nieudana bez ponowienia, a nie wyjątek składni', () => {
    // Pośrednik potrafi oddać 200 ze stroną błędu w HTML-u. Wyjątek z `JSON.parse`
    // wywracałby cały pomiar; to ta sama nieudana para co każda inna.
    const gas = project({ crux: body => (body.formFactor === 'PHONE' ? { code: 200, text: '<html>błąd</html>' } : DANE) });
    const out = plain(gas.runCruxMeasurement_());

    assert.deepEqual(out.failures, [URL + ' (PHONE): nieczytelna odpowiedź ×1']);
    assert.equal(ileZadan(gas, URL, 'PHONE'), 1, 'ponowienie tej samej treści niczego nie zmieni');
    assert.equal(out.pairsOk, 1);
  });

  test('11: 404 (za mało danych) — regresja: marker jak dotąd, bez ponowienia', () => {
    const gas = project({ crux: () => BRAK });
    const out = plain(gas.runCruxMeasurement_());

    assert.equal(out.missing, 2);
    assert.equal(out.failed, 0);
    assert.equal(ileZadan(gas, URL, 'PHONE'), 1, '404 to odpowiedź, nie awaria — bez ponowienia');
    assert.equal(polaCrux(gas).filter(r => r[COL.state] === 'INSUFFICIENT_DATA').length, 2);
  });

  test('12: 503 przy zapytaniu o domenę po 404 dla adresu → para nieudana, bez markera', () => {
    const gas = project({ crux: body => (body.origin ? NIEDOSTEPNY : BRAK) });
    const out = plain(gas.runCruxMeasurement_());

    assert.equal(out.failed, 2);
    assert.equal(out.missing, 0);
    assert.deepEqual(out.failures, [
      URL + ' (PHONE, dane domeny): HTTP 503 ×2',
      URL + ' (DESKTOP, dane domeny): HTTP 503 ×2'
    ]);
    assert.deepEqual(polaCrux(gas), [], 'ani wiersza, ani markera');
  });

  test('12b: nieudana domena nie jest odpytywana drugi raz dla kolejnego adresu', () => {
    const gas = project({
      urls: [[URL + 'a/', 'landing', ''], [URL + 'b/', 'landing', '']],
      crux: body => (body.origin ? NIEDOSTEPNY : BRAK)
    });
    const out = plain(gas.runCruxMeasurement_());

    assert.equal(ileZadan(gas, 'https://www.example.pl', 'PHONE'), 2, 'próba i ponowienie — raz na przebieg');
    assert.equal(out.failed, 4, 'każdy adres zależny od domeny jest nieudaną parą');
  });

  test('13: nieudana para nie kasuje poprzedniego wiersza ani markera (#155)', () => {
    const stare = [
      ['2026-08-01', URL, 'PHONE', 'largest_contentful_paint', 1900, 'OK', 'CRUX', '2026-08-02'],
      ['', URL, 'DESKTOP', 'wszystkie', '', 'INSUFFICIENT_DATA', 'CRUX', '2026-08-02']
    ];
    const gas = project({ crux: () => NIEDOSTEPNY, sheets: { [FIELD]: [FIELD_HEADER].concat(stare) } });
    const przed = gas.$sheet(FIELD).map(r => r.slice());

    plain(gas.runCruxMeasurement_());

    assert.deepEqual(gas.$sheet(FIELD), przed, 'zakładka bez zmian');
  });

  test('licznik par: OK + bez danych + nieudane + nieodpytane = wszystkie pary', () => {
    const gas = project({
      urls: trzyAdresy,
      crux: (body, n) => {
        if (n === 1) return DANE;
        if (n === 2) return BRAK;          // adres bez danych…
        if (n === 3) return BRAK;          // …i domena bez danych → marker
        if (n === 4) return { code: 400, text: '{}' };
        return { code: 403, text: '{}' }; // twardy: reszta nieodpytana
      }
    });
    const out = plain(gas.runCruxMeasurement_());

    assert.equal(out.pairsOk + out.missing + out.failed + out.notQueried, trzyAdresy.length * 2);
    assert.deepEqual([out.pairsOk, out.missing, out.failed, out.notQueried], [1, 1, 2, 2]);
    assert.match(out.detail, /pary: OK 1 \| bez danych 1 \| nieudane 2 \| nieodpytane 2/);
    assert.ok(out.detail.indexOf('bez wystarczających danych') < 0,
      'licznik zastępuje dawne zdanie — ta sama liczba dwa razy to szum');
  });
});

describe('#187: twardy błąd kończy tylko część CrUX', () => {
  test('8: 403 na trzeciej parze z sześciu → 2 pary zapisane, PSI wykonany, zadanie ok:false', () => {
    const gas = project({ urls: trzyAdresy, crux: (body, n) => (n === 3 ? { code: 403, text: '{"error":"API disabled"}' } : DANE) });
    const error = cyklicznie(gas);

    assert.ok(error, '403 nie minie samo — zadanie kończy się błędem');
    assert.match(error.message, /^CrUX przerwany; PSI wykonany mimo to/);
    assert.match(error.message, /Włącz Chrome UX Report API/);
    assert.match(error.message, /CrUX: pary: OK 2 \| bez danych 0 \| nieudane 1 \| nieodpytane 3/);
    assert.equal(zadaniaCrux(gas).length, 3, 'po twardym błędzie ani jednego żądania CrUX więcej');
    assert.equal(polaCrux(gas).length, 6, 'dwie pary sprzed przerwania zapisane');
    assert.ok(proby(gas).length > 0, 'PSI uruchomiony i zapisany mimo 403 z CrUX');

    const record = rekordZadania(gas);
    assert.equal(record.lastRun.ok, false);
    assert.deepEqual(tematy(gas), ['[wordpress-automation] BŁĄD importu: pomiar wydajności']);
    assert.match(gas.$mails[0].body, /CrUX przerwany; PSI wykonany mimo to/, 'mail mówi, co mimo to zapisano');
  });

  test('9: 429 → to samo, a dla pary z 429 dokładnie jedno żądanie', () => {
    const gas = project({ urls: trzyAdresy, crux: (body, n) => (n === 3 ? { code: 429, text: '{}' } : DANE) });
    const error = cyklicznie(gas);

    assert.match(error.message, /przekroczony limit zapytań \(429\)/);
    assert.equal(ileZadan(gas, trzyAdresy[1][0], 'PHONE'), 1, 'limit nie jest ponawiany');
    assert.ok(proby(gas).length > 0, 'PSI wykonany');
  });

  test('14: 403 przy PSI, CrUX sprawny — regresja #179: przerwanie natychmiast, pary CrUX zapisane', () => {
    const gas = project({ crux: () => DANE, psi: () => ({ code: 403, text: '{}' }) });
    const error = cyklicznie(gas);

    assert.match(error.message, /^Odmowa dostępu \(403\)/);
    assert.doesNotMatch(error.message, /PSI i CrUX zawiodły/, 'CrUX był w porządku — błąd PSI mówi wszystko');
    assert.equal(polaCrux(gas).length, 6, 'CrUX zapisany przed PSI');
    assert.equal(gas.$fetchCalls.filter(c => String(c.url).indexOf('pagespeedonline') >= 0).length, 1,
      'PSI przerwany na pierwszym żądaniu, jak w #179');
  });
});

describe('#187: wynik przebiegu z dwóch źródeł', () => {
  test('2 (zadanie): część par nieudana, PSI zmierzył → ok z ostrzeżeniem i mailem UWAGA', () => {
    const gas = project({ crux: body => (body.formFactor === 'PHONE' ? NIEDOSTEPNY : DANE) });
    assert.equal(cyklicznie(gas), null);

    const record = rekordZadania(gas);
    assert.equal(record.lastRun.ok, true);
    assert.match(record.lastRun.warning, /^CrUX: nieudane pary: https:\/\/www\.example\.pl\/ \(PHONE\): HTTP 503 ×2/);
    assert.match(record.lastRun.detail, /CrUX: .*pary: OK 1 \| bez danych 0 \| nieudane 1/);
    assert.deepEqual(tematy(gas), ['[wordpress-automation] UWAGA: pomiar wydajności']);
    assert.match(gas.$mails[0].body, /CrUX: nieudane pary/, 'treść nazywa CrUX');
    assert.equal(logi(gas)[0][4], 'UWAGA', 'IMPORT LOG: wynik UWAGA');
  });

  test('6: 503 na wszystkich parach, PSI mierzy → ok z ostrzeżeniem, PSI zapisany', () => {
    const gas = project({ crux: () => NIEDOSTEPNY });
    assert.equal(cyklicznie(gas), null, 'awaria CrUX nie zabiera PSI');

    assert.deepEqual(polaCrux(gas), []);
    assert.ok(proby(gas).length > 0, 'PSI zapisany');
    assert.equal(rekordZadania(gas).lastRun.ok, true);
    assert.deepEqual(tematy(gas), ['[wordpress-automation] UWAGA: pomiar wydajności']);
  });

  test('7: 503 na wszystkich parach I wszystkie zakresy PSI nieudane → jeden błąd o obu źródłach', () => {
    const gas = project({ crux: () => NIEDOSTEPNY, psi: PSI_TIMEOUT });
    const error = cyklicznie(gas);

    assert.match(error.message, /^PSI i CrUX zawiodły w tym samym przebiegu — CrUX: pary: OK 0 \| bez danych 0 \| nieudane 2/);
    assert.match(error.message, /PSI nie zmierzył żadnego z rozpoczętych zakresów/);
    assert.match(error.message, /CrUX: nieudane pary: .*HTTP 503 ×2/);
    const record = rekordZadania(gas);
    assert.equal(record.lastRun.ok, false);
    assert.match(record.lastRun.error, /^PSI i CrUX zawiodły/, 'nagłówek z oboma źródłami mieści się w 300 znakach rekordu');
    assert.deepEqual(tematy(gas), ['[wordpress-automation] BŁĄD importu: pomiar wydajności']);
  });

  test('10: 403 na CrUX I wszystkie zakresy PSI nieudane → jeden błąd wymieniający oba źródła', () => {
    const gas = project({ crux: () => ({ code: 403, text: '{}' }), psi: PSI_TIMEOUT });
    const error = cyklicznie(gas);

    assert.match(error.message, /^PSI i CrUX zawiodły/);
    assert.match(error.message, /Przerwany: CrUX odmówił dostępu \(403\)/);
    assert.match(error.message, /PSI nie zmierzył żadnego/);
  });

  test('wszystko sprawne → wynik jak przed #187, bez ostrzeżenia', () => {
    const gas = project({ crux: () => DANE });
    assert.equal(cyklicznie(gas), null);

    const record = rekordZadania(gas);
    assert.equal(record.lastRun.warning, '');
    assert.deepEqual(tematy(gas), []);
    assert.equal(logi(gas)[0][4], 'OK');
  });
});

describe('#187: granice klasyfikacji', () => {
  test('wyjątek spoza żądania nie udaje nieudanej pary', () => {
    // Samotny surogat nie da się zakodować w adresie: `encodeURIComponent` rzuca
    // jeszcze przed żądaniem. To nie awaria usługi — nie wolno jej ponawiać ani
    // liczyć jako nieudanej pary, bo zniknęłaby w statystyce.
    const gas = project({ crux: () => DANE, properties: { PAGESPEED_API_KEY: 'klucz-\uD800' } });

    assert.throws(() => gas.runCruxMeasurement_(), /URI/);
    assert.equal(zadaniaCrux(gas).length, 0, 'żadnego żądania, żadnego ponowienia');
  });

  test('klucz API z komunikatu wyjątku nie trafia do rodzaju błędu, logu ani maila', () => {
    // Komunikat wyjątku `UrlFetchApp` potrafi zacytować adres żądania, a w adresie
    // CrUX jest klucz. Krótki adres mieści się w 120 znakach rodzaju błędu.
    const tajny = 'AIzaTAJNYKLUCZ-nie-do-logu';
    const gas = project({
      properties: { PAGESPEED_API_KEY: tajny, ALERT_EMAIL: 'alerty@example.pl' },
      crux: () => {
        throw new Error('Address unavailable: https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=' + tajny);
      }
    });
    assert.equal(cyklicznie(gas), null);

    const record = rekordZadania(gas);
    assert.match(record.lastRun.warning, /wyjątek: Address unavailable: .*\?key=…/, 'rodzaj błędu zachowany, klucz zamaskowany');
    const wszystko = JSON.stringify([gas.$properties.LAST_RUN_PERFORMANCE, gas.$sheet(LOG), gas.$mails]);
    assert.ok(wszystko.indexOf(tajny) < 0, 'klucz nie wychodzi poza Script Properties');
  });

  test('klucz w treści odpowiedzi 403 też jest maskowany — w CrUX i w PSI', () => {
    // Oba komunikaty 403 wklejają do treści błędu 400 znaków odpowiedzi Google.
    // Nie zakładamy, że Google nigdy nie cytuje w niej adresu z kluczem.
    const tajny = 'AIzaKLUCZ-z-odpowiedzi';
    const tresc = { code: 403, text: '{"error":{"message":"Blocked: https://example.googleapis.com/v1/x?key=' + tajny + '"}}' };

    const crux = plain(project({ crux: () => tresc }).runCruxMeasurement_());
    assert.match(crux.hardError, /\?key=…/);
    assert.ok(crux.hardError.indexOf(tajny) < 0, 'CrUX: klucz zamaskowany');

    const psi = project({ crux: () => DANE, psi: () => tresc });
    const error = cyklicznie(psi);
    assert.match(error.message, /^Odmowa dostępu \(403\)/);
    assert.ok(error.message.indexOf(tajny) < 0, 'PSI: klucz zamaskowany');
    assert.ok(psi.$properties.LAST_RUN_PERFORMANCE.indexOf(tajny) < 0, 'ani w rekordzie zadania');
  });

  test('ten sam kształt wyniku bez adresów i z adresami — regresja #124', () => {
    const pusty = plain(project({ crux: () => DANE, urls: [] }).runCruxMeasurement_());
    const pelny = plain(project({ crux: () => DANE }).runCruxMeasurement_());
    assert.deepEqual(Object.keys(pusty).sort(), Object.keys(pelny).sort());
  });
});
