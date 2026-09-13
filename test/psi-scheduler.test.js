'use strict';

/**
 * #156: cykliczny pomiar PSI wyzwalaczem czasowym.
 *
 * Numeracja odpowiada macierzy z opisu #156. Trzy rzeczy mają tu najwięcej uwagi,
 * bo każda z nich psuje dane po cichu:
 *   1. handler wyzwalacza nie może dotykać UI — wykonanie z triggera nie ma interfejsu;
 *   2. `Pomiar` musi być unikalny na przebieg, inaczej przebieg ręczny i cykliczny
 *      z tej samej minuty trafiają w te same klucze upsertu;
 *   3. budżet wywołań jest NASZYM licznikiem, nie stanem limitu Google.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const URLS = 'PERFORMANCE URLS';
const LAB = 'PAGESPEED LAB';
const FINDINGS = 'PAGESPEED FINDINGS';
const URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const URL = 'https://www.example.pl/';
const KEY = { PAGESPEED_API_KEY: 'klucz-testowy' };
const HANDLER = 'pomiarWydajnosciCykliczny';

const psiBody = () => JSON.stringify({
  lighthouseResult: {
    lighthouseVersion: '13.4.1',
    categories: { performance: { score: 0.8 } },
    audits: { 'largest-contentful-paint': { numericValue: 2500 } }
  }
});

function project({ properties = KEY, fetch, lockHeld = false, urls = [[URL, 'homepage', '']] } = {}) {
  return loadProject({
    properties: properties,
    lockHeld: lockHeld,
    sheets: { [URLS]: [URLS_HEADER].concat(urls) },
    fetch: fetch || (url => (String(url).indexOf('pagespeedonline') >= 0
      ? { code: 200, text: psiBody() }
      : { code: 404, text: '{}' }))
  });
}

// Zakładka nie istnieje, gdy przebieg wywrócił się przed jej założeniem.
const labRows = gas => (gas.$sheet(LAB) || []).slice(1).filter(r => String(r[1] || '') !== '');
const findingRows = gas => (gas.$sheet(FINDINGS) || []).slice(1).filter(r => String(r[1] || '') !== '');
const triggersOf = gas => gas.$triggers.filter(t => t.getHandlerFunction() === HANDLER);

describe('#156: wyzwalacz czasowy', () => {
  test('1: założenie z menu daje jeden wyzwalacz; ponowne nie duplikuje', () => {
    const gas = project();
    gas.ustawCyklicznyPomiarWydajnosci();
    assert.equal(triggersOf(gas).length, 1);
    assert.equal(triggersOf(gas)[0].$spec.everyHours, 6, 'domyślny interwał');

    gas.ustawCyklicznyPomiarWydajnosci();
    assert.equal(triggersOf(gas).length, 1, 'stary skasowany przed założeniem nowego');
  });

  test('2: usunięcie z menu zdejmuje wyzwalacz; brak wyzwalacza nie jest błędem', () => {
    const gas = project();
    gas.ustawCyklicznyPomiarWydajnosci();
    assert.equal(plain(gas.usunCyklicznyPomiarWydajnosci()), 1);
    assert.equal(triggersOf(gas).length, 0);

    assert.doesNotThrow(() => gas.usunCyklicznyPomiarWydajnosci());
    assert.match(gas.$alerts[gas.$alerts.length - 1][0], /nie był włączony/);
  });

  test('12 i 13: interwał spoza dozwolonego zbioru jest odrzucany, wyzwalacz nietknięty', () => {
    const gas = project({ properties: Object.assign({}, KEY, { PAGESPEED_INTERVAL_HOURS: '12' }) });
    gas.ustawCyklicznyPomiarWydajnosci();
    assert.equal(triggersOf(gas)[0].$spec.everyHours, 12, 'wartość ze zbioru przyjęta');

    // 5 godzin nie jest wartością, którą przyjmuje everyHours() w Apps Script.
    assert.throws(() => gas.validatePsiInterval_(5), /Niedozwolony interwał: 5/);
    assert.equal(triggersOf(gas).length, 1, 'odrzucenie nie kasuje istniejącego wyzwalacza');

    // Wartość spoza zbioru w konfiguracji schodzi do domyślnej, zamiast wywracać menu.
    const zly = project({ properties: Object.assign({}, KEY, { PAGESPEED_INTERVAL_HOURS: '5' }) });
    zly.ustawCyklicznyPomiarWydajnosci();
    assert.equal(triggersOf(zly)[0].$spec.everyHours, 6);
  });
});

describe('#156: rdzeń bez UI i źródło wyzwolenia', () => {
  test('3: przebieg cykliczny nie woła getUi()', () => {
    const gas = project();
    gas.pomiarWydajnosciCykliczny();
    assert.deepEqual(gas.$alerts, [], 'żadnego okna — trigger nie ma interfejsu');
  });

  test('4: przebieg cykliczny oznacza wiersze w LAB i FINDINGS', () => {
    const gas = project();
    gas.pomiarWydajnosciCykliczny();
    const lab = labRows(gas);
    const findings = findingRows(gas);
    assert.ok(lab.length > 0 && findings.length > 0);
    assert.deepEqual([...new Set(lab.map(r => r[8]))], ['cykliczny'], 'ostatnia kolumna PAGESPEED LAB');
    assert.deepEqual([...new Set(findings.map(r => r[13]))], ['cykliczny'], 'ostatnia kolumna PAGESPEED FINDINGS');
  });

  test('5: przebieg ręczny oznacza się inaczej i pokazuje podsumowanie', () => {
    const gas = project();
    gas.zmierzWydajnosc();
    assert.deepEqual([...new Set(labRows(gas).map(r => r[8]))], ['ręczny']);
    assert.ok(gas.$alerts.length > 0, 'ręczny nadal pokazuje okno');
  });

  test('7: drugie uruchomienie w trakcie pierwszego nie wchodzi równolegle', () => {
    const gas = project({ lockHeld: true });
    assert.throws(() => gas.pomiarWydajnosciCykliczny(), /Inne uruchomienie jeszcze trwa/);
    assert.deepEqual(labRows(gas), [], 'dane nienaruszone');
  });
});

describe('#156: unikalność przebiegu', () => {
  test('6 i 8: znacznik ma sekundy, a wiersz z rozdzielczością minutową przetrwa', () => {
    const stary = ['2026-09-13 10:00', URL, 'mobile', 1, 'LCP', 1111, 'PSI_LAB', '2026-09-13', 'ręczny'];
    const gas = loadProject({
      properties: KEY,
      sheets: {
        [URLS]: [URLS_HEADER, [URL, 'homepage', '']],
        [LAB]: [
          ['Pomiar', 'URL', 'Strategia', 'Próba', 'Metryka', 'Wartość', 'Źródło', 'Pobrano', 'Wyzwolenie'],
          stary
        ]
      },
      fetch: url => (String(url).indexOf('pagespeedonline') >= 0
        ? { code: 200, text: psiBody() }
        : { code: 404, text: '{}' })
    });
    gas.pomiarWydajnosciCykliczny();

    const rows = labRows(gas);
    const znaczniki = [...new Set(rows.map(r => String(r[0])))];
    assert.ok(znaczniki.indexOf('2026-09-13 10:00') >= 0, 'wiersz historyczny nietknięty');
    const nowe = znaczniki.filter(z => z !== '2026-09-13 10:00');
    assert.equal(nowe.length, 1);
    assert.match(nowe[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'nowy znacznik ma sekundy');
  });
});

describe('#156: lokalny budżet wywołań', () => {
  test('10: wyczerpany budżet wstrzymuje przebieg i mówi to wprost', () => {
    const gas = project({ properties: Object.assign({}, KEY, { PAGESPEED_DAILY_BUDGET: '2' }) });
    const out = plain(gas.runPsiMeasurement_('cykliczny'));
    assert.equal(out.budgetStopped, true);
    assert.equal(out.budgetUsed, 2);
    assert.equal(out.budgetLimit, 2);
    assert.match(out.detail, /wyczerpany nasz dzienny budżet/);
    assert.doesNotMatch(out.detail, /limit Google/, 'nie udajemy, że znamy limit dostawcy');
  });

  test('11: nieudane żądanie też konsumuje budżet', () => {
    const gas = project({
      properties: Object.assign({}, KEY, { PAGESPEED_DAILY_BUDGET: '3' }),
      // 5xx to awaria pojedynczej próby Lighthouse, ale żądanie zostało wykonane
      // i po stronie dostawcy się liczy.
      fetch: url => (String(url).indexOf('pagespeedonline') >= 0
        ? { code: 500, text: 'lighthouseError' }
        : { code: 404, text: '{}' })
    });
    const out = plain(gas.runPsiMeasurement_('cykliczny'));
    assert.equal(out.budgetUsed, 3, 'trzy nieudane żądania zjadły cały budżet');
    assert.equal(out.budgetStopped, true);
  });

  test('licznik zeruje się przy zmianie doby, a stan przetrwa między przebiegami', () => {
    const gas = project({ properties: Object.assign({}, KEY, { PAGESPEED_DAILY_BUDGET: '100' }) });
    gas.runPsiMeasurement_('cykliczny');
    const poPierwszym = Number(String(gas.$properties.PAGESPEED_BUDGET_STATE).split(' ')[1]);
    assert.ok(poPierwszym > 0, 'stan zapisany');

    gas.runPsiMeasurement_('cykliczny');
    const poDrugim = Number(String(gas.$properties.PAGESPEED_BUDGET_STATE).split(' ')[1]);
    assert.ok(poDrugim > poPierwszym, 'licznik narasta w obrębie doby');

    // Wpis z innego dnia jest ignorowany, nie doliczany.
    assert.deepEqual(plain(gas.psiBudgetState_('2000-01-01')), { day: '2000-01-01', used: 0 });
  });

  test('budżet spoza zakresu schodzi do wartości domyślnej', () => {
    const gas = project({ properties: Object.assign({}, KEY, { PAGESPEED_DAILY_BUDGET: 'nie-liczba' }) });
    assert.equal(gas.psiDailyBudget_(), 500);
    const zero = project({ properties: Object.assign({}, KEY, { PAGESPEED_DAILY_BUDGET: '0' }) });
    assert.equal(zero.psiDailyBudget_(), 500, 'zero wyłączyłoby pomiar po cichu');
  });
});
