'use strict';

/**
 * #124: pomiar wydajności z CrUX i PageSpeed Insights.
 *
 * Dwie rzeczy są tu najważniejsze i mają najwięcej testów: brak danych
 * terenowych nie może stać się zerem, bo zero znaczy wynik doskonały, oraz
 * pomiar laboratoryjny musi zapisywać każdą próbę osobno, bo Lighthouse jest
 * zmienny i pojedynczy wynik nie jest dowodem regresji.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const URLS = 'PERFORMANCE URLS';
const FIELD = 'CWV FIELD';
const LAB = 'PAGESPEED LAB';
const URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const FIELD_HEADER = ['Okres do', 'URL', 'Form factor', 'Metryka', 'p75', 'Stan', 'Źródło', 'Pobrano'];
const LAB_HEADER = ['Pomiar', 'URL', 'Strategia', 'Próba', 'Metryka', 'Wartość', 'Źródło', 'Pobrano'];

const URL = 'https://www.example.pl/';
const KEY = { PAGESPEED_API_KEY: 'klucz-testowy' };

const cruxRecord = (p75 = { largest_contentful_paint: 2100, interaction_to_next_paint: 180, cumulative_layout_shift: 0.05 }) => ({
  record: {
    collectionPeriod: { lastDate: { year: 2026, month: 9, day: 1 } },
    metrics: Object.keys(p75).reduce((acc, name) => {
      acc[name] = { percentiles: { p75: p75[name] } };
      return acc;
    }, {})
  }
});

const psiResponse = (lcp = 2500) => ({
  lighthouseResult: {
    categories: { performance: { score: 0.87 } },
    audits: {
      'largest-contentful-paint': { numericValue: lcp },
      'cumulative-layout-shift': { numericValue: 0.02 },
      'total-blocking-time': { numericValue: 120 },
      'first-contentful-paint': { numericValue: 900 },
      'speed-index': { numericValue: 1800 },
      'server-response-time': { numericValue: 210 },
      'total-byte-weight': { numericValue: 1500000 }
    }
  }
});

function project({ urls = [[URL, 'homepage', '']], properties = KEY, fetch } = {}) {
  return loadProject({
    properties: properties,
    sheets: { [URLS]: [URLS_HEADER, ...urls] },
    fetch: fetch || (() => ({ code: 200, text: '{}' }))
  });
}

describe('#124: konfiguracja', () => {
  test('brak klucza mówi, co utworzyć i że OAuth nie jest potrzebny', () => {
    assert.throws(
      () => project({ properties: {} }).performanceApiKey_(),
      /Brak Script Property: PAGESPEED_API_KEY.*OAuth nie jest potrzebny/s
    );
  });

  test('stan konfiguracji da się sprawdzić bez wyjątku', () => {
    assert.equal(project().isPerformanceConfigured_(), true);
    assert.equal(project({ properties: {} }).isPerformanceConfigured_(), false);
  });

  test('adresy pochodzą z arkusza, a wpisy bez protokołu są pomijane', () => {
    const gas = project({ urls: [[URL, 'homepage', ''], ['www.example.pl', 'bez protokołu', ''], ['', '', '']] });
    const urls = plain(gas.performanceUrls_());
    assert.deepEqual(urls, [{ url: URL, role: 'homepage' }]);
  });
});

describe('#124: dane terenowe z CrUX', () => {
  test('zapisuje p75 dla każdej metryki i obu form factorów', () => {
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(cruxRecord()) }) });
    const out = plain(gas.runCruxMeasurement_());
    assert.equal(out.rows, 6, 'trzy metryki razy dwa warianty urządzenia');
    const rows = gas.$sheet(FIELD).slice(1);
    const phone = rows.filter(r => r[2] === 'PHONE');
    assert.equal(phone.length, 3);
    assert.equal(phone[0][0], '2026-09-01', 'okres zbiorczy zapisany');
    assert.equal(phone[0][5], 'OK');
    assert.equal(phone[0][6], 'CRUX');
  });

  test('brak danych dla adresu to INSUFFICIENT_DATA, nigdy zero', () => {
    // 404 z CrUX znaczy „za mało ruchu”, a nie awarię. Zero znaczyłoby wynik
    // doskonały, czyli dokładnie odwrotność prawdy.
    const gas = project({ fetch: () => ({ code: 404, text: '{}' }) });
    const out = plain(gas.runCruxMeasurement_());
    assert.equal(out.missing, 2, 'oba warianty urządzenia bez danych');
    const rows = gas.$sheet(FIELD).slice(1);
    assert.equal(rows.length, 2);
    assert.equal(rows[0][4], '', 'pusta wartość, nie zero');
    assert.equal(rows[0][5], 'INSUFFICIENT_DATA');
  });

  test('#124: gdy adres nie ma danych, pytamy o całą domenę', () => {
    // Realny przypadek z produkcji: wszystkie pięć adresów wróciło bez danych,
    // bo pojedyncza podstrona rzadko ma dość ruchu, a cała domena zwykle ma.
    const gas = project({
      fetch: (url, params) => {
        const body = JSON.parse(params.payload);
        return body.origin
          ? { code: 200, text: JSON.stringify(cruxRecord()) }
          : { code: 404, text: '{}' };
      }
    });
    const out = plain(gas.runCruxMeasurement_());
    assert.equal(out.missing, 0, 'dane się znalazły');
    assert.equal(out.fromOrigin, 2, 'oba warianty urządzenia z poziomu domeny');
    assert.match(out.detail, /z danych całej domeny zamiast pojedynczej strony/);
  });

  test('#124: dane domeny są oznaczone innym źródłem, żeby nie udawały danych strony', () => {
    const gas = project({
      fetch: (url, params) => (JSON.parse(params.payload).origin
        ? { code: 200, text: JSON.stringify(cruxRecord()) }
        : { code: 404, text: '{}' })
    });
    gas.runCruxMeasurement_();
    const sources = [...new Set(gas.$sheet(FIELD).slice(1).map(r => r[6]))];
    assert.deepEqual(sources, ['CRUX (domena)'], 'liczba opisuje serwis, nie tę stronę');
  });

  test('#124: o domenę pytamy raz, a nie raz na adres', () => {
    const many = [1, 2, 3].map(n => ['https://www.example.pl/' + n + '/', 'landing', '']);
    const gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER].concat(many) },
      fetch: (url, params) => (JSON.parse(params.payload).origin
        ? { code: 200, text: JSON.stringify(cruxRecord()) }
        : { code: 404, text: '{}' })
    });
    gas.runCruxMeasurement_();
    const originCalls = gas.$fetchCalls.filter(c => JSON.parse(c.params.payload).origin);
    assert.equal(originCalls.length, 2, 'jedno zapytanie na form factor, nie na adres');
  });

  test('#124: brak danych także dla domeny nadal daje INSUFFICIENT_DATA', () => {
    const gas = project({ fetch: () => ({ code: 404, text: '{}' }) });
    const out = plain(gas.runCruxMeasurement_());
    assert.equal(out.missing, 2);
    assert.equal(out.fromOrigin, 0);
    assert.equal(gas.$sheet(FIELD)[1][5], 'INSUFFICIENT_DATA');
  });

  test('#124: domena jest wyliczana ze schematu i hosta, bez ścieżki', () => {
    const gas = project();
    assert.equal(gas.cruxOrigin_('https://www.example.pl/a/b/?x=1#y'), 'https://www.example.pl');
    assert.equal(gas.cruxOrigin_('http://example.pl'), 'http://example.pl');
    assert.equal(gas.cruxOrigin_('nonsens'), '');
  });

  test('brak pojedynczej metryki też jest oznaczony, a nie zerowany', () => {
    const partial = cruxRecord({ largest_contentful_paint: 2100 });
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(partial) }) });
    gas.runCruxMeasurement_();
    const rows = gas.$sheet(FIELD).slice(1).filter(r => r[2] === 'PHONE');
    const byMetric = {};
    rows.forEach(r => { byMetric[r[3]] = r; });
    assert.equal(byMetric.largest_contentful_paint[5], 'OK');
    assert.equal(byMetric.cumulative_layout_shift[5], 'INSUFFICIENT_DATA');
    assert.equal(byMetric.cumulative_layout_shift[4], '');
  });

  test('ponowny pomiar tego samego okresu nie dubluje wierszy', () => {
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(cruxRecord()) }) });
    gas.runCruxMeasurement_();
    gas.runCruxMeasurement_();
    assert.equal(gas.$sheet(FIELD).slice(1).length, 6, 'sześć wierszy, nie dwanaście');
  });

  test('historia wcześniejszych okresów zostaje', () => {
    const gas = project({
      fetch: () => ({ code: 200, text: JSON.stringify(cruxRecord()) })
    });
    gas.runCruxMeasurement_();
    const older = gas.$sheet(FIELD).slice(1).map(r => r.slice());
    older.forEach(r => { r[0] = '2026-08-01'; });
    // Symulujemy wcześniejszy okres obok bieżącego.
    gas.$sheet(FIELD).push.apply(gas.$sheet(FIELD), older);
    gas.runCruxMeasurement_();
    const periods = gas.$sheet(FIELD).slice(1).map(r => r[0]);
    assert.ok(periods.indexOf('2026-08-01') >= 0, 'starszy okres nie został skasowany');
  });

  test('odmowa i limit mają osobne komunikaty', () => {
    assert.throws(() => project({ fetch: () => ({ code: 403, text: '{}' }) }).runCruxMeasurement_(), /Włącz Chrome UX Report API/);
    assert.throws(() => project({ fetch: () => ({ code: 429, text: '{}' }) }).runCruxMeasurement_(), /limit zapytań \(429\)/);
  });

  test('#124: wynik ma ten sam kształt także wtedy, gdy nie było co mierzyć', () => {
    const empty = plain(project({ urls: [] }).runCruxMeasurement_());
    const measured = plain(project({ fetch: () => ({ code: 200, text: JSON.stringify(cruxRecord()) }) }).runCruxMeasurement_());
    assert.deepEqual(Object.keys(empty).sort(), Object.keys(measured).sort(), 'te same pola w obu przypadkach');
    assert.equal(empty.fromOrigin, 0);
  });

  test('brak adresów nie jest błędem', () => {
    const out = plain(project({ urls: [] }).runCruxMeasurement_());
    assert.equal(out.rows, 0);
    assert.match(out.detail, /brak adresów/);
  });
});

describe('#124: dane laboratoryjne z PSI', () => {
  test('zapisuje każdą próbę osobno dla obu strategii', () => {
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(psiResponse()) }) });
    const out = plain(gas.runPsiMeasurement_());
    const rows = gas.$sheet(LAB).slice(1);
    // Osiem metryk razy trzy próby razy dwie strategie.
    assert.equal(out.rows, 8 * 3 * 2);
    assert.deepEqual([...new Set(rows.map(r => r[3]))].sort(), [1, 2, 3], 'trzy numery prób');
    assert.deepEqual([...new Set(rows.map(r => r[2]))].sort(), ['desktop', 'mobile']);
    assert.equal(rows[0][6], 'PSI_LAB');
  });

  test('mediana jest liczona z prób, więc jeden odstający wynik nie decyduje', () => {
    const values = [2000, 9000, 2100];
    let call = 0;
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(psiResponse(values[call++ % 3])) }) });
    const out = plain(gas.runPsiMeasurement_());
    assert.equal(out.medians.LCP, 2100, 'mediana, nie średnia i nie ostatni wynik');
  });

  test('mediana z pustej listy jest pusta, a nie zerowa', () => {
    const gas = project();
    assert.equal(gas.medianOfValues_([]), '');
    assert.equal(gas.medianOfValues_([3, 1, 2]), 2);
    assert.equal(gas.medianOfValues_([4, 1, 2, 3]), 2.5);
  });

  test('#124: przebieg mieści się w budżecie czasu i wraca do reszty adresów później', () => {
    // Jedno wywołanie PSI trwa kilkanaście sekund, więc kilka adresów
    // przekroczyłoby limit czasu wykonania Apps Script. Zamiast paść w połowie,
    // przebieg mierzy tyle, ile zdąży, i zapamiętuje, gdzie skończył.
    const many = [1, 2, 3, 4].map(n => ['https://www.example.pl/' + n + '/', 'landing', '']);
    let elapsed = 0;
    const gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER].concat(many) },
      fetch: () => {
        elapsed += 30000;
        return { code: 200, text: JSON.stringify(psiResponse()) };
      }
    });
    // Zegar podmieniamy w kontekście VM, bo tam działa kod źródeł; podmiana
    // Date.now w realm testu nie miałaby na niego wpływu.
    const base = gas.$Date.now();
    gas.$Date.now = () => base + elapsed;

    const out = plain(gas.runPsiMeasurement_());
    assert.ok(out.measured < many.length, 'nie wszystkie adresy w jednym przebiegu');
    assert.ok(out.measured > 0, 'ale przynajmniej jeden zmierzony w całości');
    assert.equal(out.measured + out.skipped, many.length);
    assert.match(out.detail, /zostanie zmierzonych w kolejnym przebiegu/);
  });

  test('#124: kolejny przebieg zaczyna od adresu, na którym skończył poprzedni', () => {
    const many = [1, 2].map(n => ['https://www.example.pl/' + n + '/', 'landing', '']);
    const gas = loadProject({
      properties: Object.assign({}, KEY, { PAGESPEED_CURSOR: '1' }),
      sheets: { [URLS]: [URLS_HEADER].concat(many) },
      fetch: () => ({ code: 200, text: JSON.stringify(psiResponse()) })
    });
    gas.runPsiMeasurement_();
    assert.equal(gas.$sheet(LAB)[1][1], 'https://www.example.pl/2/', 'zaczyna od drugiego adresu');
  });

  test('#124: kursor jest zapisywany i zawija się na liście adresów', () => {
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(psiResponse()) }) });
    gas.runPsiMeasurement_();
    assert.equal(gas.$properties.PAGESPEED_CURSOR, '0', 'jeden adres: kursor wraca na początek');
    assert.equal(gas.psiStartIndex_(0), 0, 'pusta lista nie dzieli przez zero');
  });

  test('brakujący audyt jest pomijany, a nie zapisywany jako zero', () => {
    const thin = { lighthouseResult: { categories: {}, audits: { 'largest-contentful-paint': { numericValue: 2500 } } } };
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(thin) }) });
    gas.runPsiMeasurement_();
    const metrics = [...new Set(gas.$sheet(LAB).slice(1).map(r => r[4]))];
    assert.deepEqual(metrics, ['LCP'], 'tylko to, co API naprawdę zwróciło');
  });

  test('odmowa dostępu tłumaczy, które API włączyć', () => {
    assert.throws(() => project({ fetch: () => ({ code: 403, text: '{}' }) }).runPsiMeasurement_(), /PageSpeed Insights API/);
  });

  test('#124: błąd systemowy przerywa pomiar, bo kolejne próby dadzą to samo', () => {
    // Klucz i limit dotyczą wszystkich adresów, więc brnięcie dalej tylko
    // zużyłoby limit i zasypało raport tym samym błędem.
    assert.throws(
      () => project({ fetch: () => ({ code: 429, text: '{}' }) }).runPsiMeasurement_(),
      /Przekroczony limit zapytań \(429\).*zmniejsz liczbę adresów/s
    );
    assert.throws(
      () => project({ fetch: () => ({ code: 403, text: '{}' }) }).runPsiMeasurement_(),
      /PageSpeed Insights API/
    );
  });

  test('#124: awaria Lighthouse nie przerywa pomiaru i jest zgłoszona', () => {
    // Realny błąd z produkcji: Lighthouse zwraca 500 dla pojedynczego przebiegu.
    // To zdarza się losowo i nie może kasować wszystkiego, co już zmierzono.
    const lighthouse500 = { code: 500, text: '{"error":{"code":500,"message":"Lighthouse returned error: Something went wrong.","errors":[{"domain":"lighthouse","reason":"lighthouseError"}]}}' };
    let call = 0;
    const gas = project({
      fetch: () => {
        call++;
        return call === 2 ? lighthouse500 : { code: 200, text: JSON.stringify(psiResponse()) };
      }
    });
    const out = plain(gas.runPsiMeasurement_());
    assert.equal(out.failures.length, 1, 'jedna strategia z niepełnym kompletem prób');
    assert.match(out.failures[0], /\(mobile\): 2 z 3 prób/);
    assert.ok(out.rows > 0, 'udane próby są zapisane, a nie tracone');
    assert.match(out.detail, /nieudane próby:/);
  });

  test('#124: adres, którego Lighthouse w ogóle nie zmierzył, jest wypisany wprost', () => {
    const gas = project({ fetch: () => ({ code: 500, text: '{"error":{"errors":[{"domain":"lighthouse"}]}}' }) });
    const out = plain(gas.runPsiMeasurement_());
    assert.equal(out.rows, 0);
    assert.equal(out.failures.length, 2, 'obie strategie bez ani jednej udanej próby');
    assert.match(out.failures[0], /0 z 3 prób/);
  });

  test('pusta odpowiedź nie wywraca pomiaru', () => {
    const gas = project({ fetch: () => ({ code: 200, text: '' }) });
    const out = plain(gas.runPsiMeasurement_());
    assert.equal(out.rows, 0, 'brak audytów to brak wierszy, nie wyjątek');
  });

  test('zapytanie zawiera strategię, kategorię i klucz', () => {
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(psiResponse()) }) });
    gas.runPsiMeasurement_();
    const urls = gas.$fetchCalls.map(c => c.url);
    assert.ok(urls.some(u => u.indexOf('strategy=mobile') > 0));
    assert.ok(urls.some(u => u.indexOf('strategy=desktop') > 0));
    assert.ok(urls.every(u => u.indexOf('key=klucz-testowy') > 0));
  });
});

describe('#124: menu', () => {
  test('przygotowanie zakłada trzy arkusze i mówi, czego brakuje', () => {
    const gas = project({ properties: {}, urls: [] });
    assert.equal(gas.przygotujPomiarWydajnosci(), false);
    assert.deepEqual(gas.$sheet(FIELD)[0], FIELD_HEADER);
    assert.deepEqual(gas.$sheet(LAB)[0], LAB_HEADER);
    const text = gas.$alerts[0][0];
    assert.match(text, /brak Script Property PAGESPEED_API_KEY/);
    assert.match(text, /Chrome UX Report API/);
    assert.match(text, /nigdy nie uśredniane w jedną liczbę/);
  });

  test('pomiar z menu podsumowuje oba źródła osobno', () => {
    const gas = project({
      fetch: url => ({ code: 200, text: JSON.stringify(String(url).indexOf('chromeuxreport') > 0 ? cruxRecord() : psiResponse()) })
    });
    gas.zmierzWydajnosc();
    const text = gas.$alerts[0][0];
    assert.match(text, /Dane terenowe \(CrUX\): 6 pomiarów terenowych/);
    assert.match(text, /Dane laboratoryjne \(PSI\): 48 pomiarów dla 1 z 1 adresów/);
    assert.match(text, /Brak danych terenowych nie jest błędem strony/);
  });

  test('#124: okno tłumaczy nieudane przebiegi Lighthouse, gdy jakieś były', () => {
    let call = 0;
    const gas = project({
      fetch: url => {
        if (String(url).indexOf('chromeuxreport') > 0) return { code: 200, text: JSON.stringify(cruxRecord()) };
        call++;
        return call === 1
          ? { code: 500, text: '{"error":{"errors":[{"domain":"lighthouse"}]}}' }
          : { code: 200, text: JSON.stringify(psiResponse()) };
      }
    });
    gas.zmierzWydajnosc();
    const text = gas.$alerts[0][0];
    assert.match(text, /nieudane próby:/);
    assert.match(text, /zdarzają się losowo po stronie Google/);
  });

  test('pozycje są w menu SEO / GSC', () => {
    const gas = project();
    gas.onOpen();
    const seo = gas.$menus.find(m => m.title === 'SEO / GSC');
    assert.deepEqual(seo.items.map(i => i.fn).slice(-2), ['przygotujPomiarWydajnosci', 'zmierzWydajnosc']);
  });
});

/**
 * #151: zapis przyrostowy po każdym adresie i postęp kursora.
 *
 * Numeracja odpowiada macierzy z opisu #151. Sedno: przerwanie przebiegu ma
 * kosztować najwyżej jeden adres, a rotacja ma się posuwać niezależnie od tego,
 * czy przebieg dobiegł końca.
 */
describe('#151: zapis przyrostowy i postęp kursora', () => {
  const two = [1, 2].map(n => ['https://www.example.pl/' + n + '/', 'landing', '']);
  const ok200 = () => ({ code: 200, text: JSON.stringify(psiResponse()) });
  const SECOND = 'example.pl%2F2%2F';
  const FINDINGS = 'PAGESPEED FINDINGS';
  const FINDINGS_HEADER = [
    'Pomiar', 'URL', 'Strategia', 'Próba', 'Rodzaj', 'Nazwa', 'Szczegół',
    'Czas (ms)', 'Transfer (KiB)', 'Potencjalna oszczędność (ms)',
    'Potencjalna oszczędność (KiB)', 'Źródło', 'Pobrano'
  ];

  test('1: wiersze adresu są w arkuszu, zanim ruszy następny adres', () => {
    let gas = null;
    let rowsWhenSecondStarted = null;
    gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER].concat(two) },
      fetch: url => {
        if (url.includes(SECOND) && rowsWhenSecondStarted === null) {
          const lab = gas.$sheet(LAB);
          rowsWhenSecondStarted = lab ? lab.length : 0;
        }
        return ok200();
      }
    });
    gas.runPsiMeasurement_();
    assert.ok(rowsWhenSecondStarted > 1, 'pierwszy adres był zapisany, zanim zaczął się drugi');
  });

  test('2 i 3: przerwanie na drugim adresie zostawia dane pierwszego, a kursor wskazuje drugi', () => {
    const gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER].concat(two) },
      fetch: url => (url.includes(SECOND) ? { code: 429, text: '{}' } : ok200())
    });
    assert.throws(() => gas.runPsiMeasurement_(), /limit zapytań/);

    const lab = gas.$sheet(LAB).slice(1).filter(row => String(row[1] || '') !== '');
    assert.ok(lab.length > 0, 'dorobek pierwszego adresu przetrwał przerwanie');
    assert.deepEqual([...new Set(lab.map(row => row[1]))], ['https://www.example.pl/1/']);
    assert.equal(gas.$properties.PAGESPEED_CURSOR, '1', 'kolejny przebieg ruszy od drugiego adresu');
  });

  test('4: adres bez ani jednej udanej próby nie zatrzymuje rotacji i nie kasuje diagnozy', () => {
    const stara = ['2026-01-01 10:00', two[0][0], 'mobile', 1, 'SZANSA', 'stara-diagnoza', '', '', '', 400, 90, 'PSI_LAB', '2026-01-01'];
    const gas = loadProject({
      properties: KEY,
      sheets: {
        [URLS]: [URLS_HEADER].concat(two),
        [FINDINGS]: [FINDINGS_HEADER, stara]
      },
      // 5xx jest awarią pojedynczej próby Lighthouse, nie konfiguracji.
      fetch: () => ({ code: 500, text: 'lighthouse' })
    });
    const out = plain(gas.runPsiMeasurement_());

    assert.equal(out.measured, two.length, 'rotacja przeszła przez oba adresy');
    assert.equal(gas.$sheet(LAB).slice(1).filter(row => String(row[1] || '') !== '').length, 0);
    const findings = gas.$sheet(FINDINGS).slice(1).filter(row => String(row[1] || '') !== '');
    assert.deepEqual(findings.map(row => row[5]), ['stara-diagnoza'], 'poprzednia diagnoza nietknięta');
  });

  test('6: kompletny przebieg mówi „kompletny” i nie wspomina o kolejnym', () => {
    const gas = project({ fetch: ok200 });
    const out = plain(gas.runPsiMeasurement_());
    assert.match(out.detail, /przebieg kompletny/);
    assert.doesNotMatch(out.detail, /kolejnym przebiegu/);
    assert.equal(out.resumeAt, '', 'nie ma czego wznawiać');
    assert.deepEqual(out.complete, [URL], 'komplet prób wymieniony wprost');
  });

  test('7: wyczerpany budżet wymienia pozostałe adresy i punkt wznowienia', () => {
    const many = [1, 2, 3, 4].map(n => ['https://www.example.pl/' + n + '/', 'landing', '']);
    let elapsed = 0;
    const gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER].concat(many) },
      fetch: () => {
        elapsed += 30000;
        return ok200();
      }
    });
    const base = gas.$Date.now();
    gas.$Date.now = () => base + elapsed;

    const out = plain(gas.runPsiMeasurement_());
    assert.match(out.detail, /budżet wyczerpany/);
    assert.ok(out.skipped > 0);
    assert.ok(out.resumeAt, 'punkt wznowienia podany wprost');
    assert.ok(out.detail.includes(out.resumeAt), 'i widoczny w podsumowaniu dla operatora');
  });

  test('8: adres z dwiema udanymi próbami z trzech jest wymieniony jako niekompletny', () => {
    let calls = 0;
    const gas = project({ fetch: () => (++calls === 1 ? { code: 500, text: 'lighthouse' } : ok200()) });
    const out = plain(gas.runPsiMeasurement_());
    assert.match(out.detail, /nieudane próby:.*2 z 3/);
    assert.deepEqual(out.complete, [], 'adres bez kompletu nie trafia na listę kompletnych');
  });

  test('9: zapis przyrostowy pozostaje idempotentny przy powtórzeniu adresu', () => {
    const gas = project({ fetch: ok200 });
    gas.runPsiMeasurement_();
    gas.runPsiMeasurement_();
    const lab = gas.$sheet(LAB).slice(1).filter(row => String(row[1] || '') !== '');
    const keys = new Set(lab.map(row => [row[0], row[1], row[2], row[3], row[4]].join('|')));
    assert.equal(lab.length, keys.size, 'żaden klucz nie został zdublowany');
  });
});
