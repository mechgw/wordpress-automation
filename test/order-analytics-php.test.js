'use strict';

/**
 * #195: most zleceń WYKONANY w prawdziwym PHP, a nie tylko przeczytany jako tekst.
 *
 * Testy tekstowe w order-analytics.test.js pilnują, co jest w kodzie. Ten plik
 * sprawdza, co kod zwraca na danych zapisanych tak, jak zapisuje je Forminator
 * (atrapy: helpers/forminator-harness.php). 26.09 na produkcji oba błędy mostu
 * przeszły testy tekstowe, bo były błędnym założeniem o danych, a nie literówką:
 * data z pola do wyświetlania i wariant szukany po wartości opcji, choć pod kluczem
 * pola wyboru Forminator zapisuje etykietę.
 *
 * Wymaga `php` w PATH. W CI brak PHP to błąd, lokalnie pominięcie z komunikatem.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadProject } = require('./helpers/gas');

const HARNESS = path.join(__dirname, 'helpers', 'forminator-harness.php');
const HAS_PHP = spawnSync('php', ['-v']).status === 0;
if (!HAS_PHP && process.env.CI) throw new Error('Test mostu zleceń wymaga PHP w PATH, a w CI go nie ma.');
const SKIP = HAS_PHP ? false : 'brak PHP w PATH';

const PROPS = {
  WP_BASE_URL: 'https://www.example.pl',
  WP_USERNAME: 'bot',
  WP_APP_PASSWORD: 'pw',
  WP_REST_NAMESPACE: 'example',
  WP_ORDER_FORM_ID: '321',
  WP_ORDER_SERVICE_FIELDS: 'radio-11:miejska, radio-12:podmiejska, radio-13:krajowa, radio-14:kurier dedykowany',
  WP_ORDER_FROM_FIELD: 'address-7',
  WP_ORDER_TO_FIELD: 'address-8',
  WP_ORDER_SOURCE_FIELD: 'hidden-3'
};

const choice = (type, label, options) => ({
  type,
  field_label: label,
  options: options.map(([value, text], i) => ({ label: text, value, key: 'k' + i, error: '', default: '' }))
});

// Wartości opcji jak z kreatora: domyślne „one”/„two” obok wygenerowanych z etykiety
// (z półpauzą, dwukropkiem i nawiasem); etykiety z opisem po półpauzie.
const FIELDS = {
  'select-2': choice('select', 'Serwis', [['one', 'Miejski'], ['two', 'Krajowy']]),
  'radio-11': choice('radio', 'Serwis miejski:', [
    ['one', 'Ekonomiczna – do 6 godzin'], ['two', 'Standard – do 4 godzin'], ['Ekspres', 'Ekspres – do 2 godzin']
  ]),
  'radio-12': choice('radio', 'Serwis podmiejski:', [['two', 'Standard – do 6 godzin'], ['Ekspres', 'Ekspres – do 3 godzin']]),
  'radio-13': choice('radio', 'Serwis krajowy:', [
    ['two', 'Standard – następny dzień roboczy (8:00 – 17:00)'],
    ['Ekspres-10-–-do-godziny-10:00-(następnego-dnia)', 'Ekspres 10 – do godziny 10:00 (następnego dnia)']
  ]),
  'radio-14': choice('radio', 'Kurier dedykowany:', [['two', 'kurier dedykowany']]),
  'address-7': { type: 'address', field_label: 'Adres nadania' },
  'address-8': { type: 'address', field_label: 'Adres doręczenia' },
  'hidden-3': { type: 'hidden', field_label: 'landing_page' },
  'email-1': { type: 'email', field_label: 'E-mail' },
  'phone-1': { type: 'phone', field_label: 'Telefon' }
};

/**
 * Zgłoszenie zapisane jak w Forminatorze 1.57: `stored` to wartości pod kluczami pól
 * (dla pól wyboru — etykieta), `choices` to `_forminator_choice_values` (wysłane
 * wartości) albo null dla zgłoszeń sprzed tego zapisu.
 */
function saved(id, stored, choices) {
  const meta = {
    'address-7': { id: 1, value: { street_address: 'Przykładowa 1', city: 'Katowice', zip: '40-001', country: 'Polska' } },
    'address-8': { id: 2, value: { street_address: 'Testowa 2', city: 'Zielona  Góra', zip: '65001' } },
    'hidden-3': { id: 3, value: 'https://www.example.pl/kurier-dedykowany/?utm_source=test#form' },
    'email-1': { id: 4, value: 'osoba@example.com' },
    'phone-1': { id: 5, value: '+48 600 000 000' }
  };
  Object.keys(stored).forEach(key => { meta[key] = { id: 10, value: stored[key] }; });
  if (choices) meta._forminator_choice_values = { id: 11, value: choices };
  return { entry_id: String(id), date_created_sql: '2026-05-16 01:58:12', time_created: 'maj 16, 2026 @ 1:58 AM', meta_data: meta };
}

function runBridge(fixture) {
  const code = loadProject({ properties: PROPS }).buildOrderAnalyticsBridgeCode_();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-bridge-'));
  try {
    const snippet = path.join(dir, 'snippet.php');
    const data = path.join(dir, 'fixture.json');
    fs.writeFileSync(snippet, '<?php\n' + code);
    fs.writeFileSync(data, JSON.stringify(Object.assign({ fields: FIELDS, entries: [] }, fixture)));
    const run = spawnSync('php', ['-d', 'display_errors=stderr', '-d', 'error_reporting=-1', HARNESS, data, snippet], { encoding: 'utf8' });
    // Ostrzeżenie PHP z kodu mostu (np. niezdefiniowany klucz) to błąd, nawet gdy wynik wygląda dobrze.
    assert.doesNotMatch(run.stderr, /snippet\.php|forminator-harness\.php/, run.stderr);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    return JSON.parse(run.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const entriesOf = fixture => runBridge(fixture).response.entries;
const variantOf = (stored, choices) => entriesOf({ entries: [saved(1, stored, choices)] })[0];

describe('#195: most PHP na danych w kształcie zapisu Forminatora', { skip: SKIP }, () => {
  test('wariant z wysłanej wartości, choć pod kluczem pola jest etykieta', () => {
    const e = variantOf({ 'radio-11': 'Ekonomiczna – do 6 godzin' }, { 'select-2': 'one', 'radio-11': 'one' });
    assert.deepEqual([e.service, e.service_option], ['miejska', 'Ekonomiczna']);
  });

  test('wysłana wartość rozstrzyga, gdy etykietę zmieniono po zgłoszeniu', () => {
    // Bez `_forminator_choice_values` etykieta „Tania” nie pasuje do żadnej obecnej opcji.
    const e = variantOf({ 'radio-11': 'Tania – do 8 godzin' }, { 'radio-11': 'one' });
    assert.equal(e.service_option, 'Ekonomiczna');
  });

  test('wysłana wartość nie jest czytana jak etykieta; rozstrzyga wtedy zapisana etykieta', () => {
    // Uwaga Codexa w #207: wartość opcji zmieniona po zgłoszeniu, a stara wartość
    // („Standard”) przypadkiem równa nazwie innego wariantu. Klient wybrał „Ekspres”.
    const e = variantOf({ 'radio-11': 'Ekspres – do 2 godzin' }, { 'radio-11': 'Standard' });
    assert.equal(e.service_option, 'Ekspres');
  });

  test('wartość wygenerowana z etykiety (półpauza, dwukropek, nawias) trafia w opcję', () => {
    const e = variantOf(
      { 'radio-13': 'Ekspres 10 – do godziny 10:00 (następnego dnia)' },
      { 'select-2': 'two', 'radio-13': 'Ekspres-10-–-do-godziny-10:00-(następnego-dnia)' }
    );
    assert.deepEqual([e.service, e.service_option], ['krajowa', 'Ekspres 10']);
  });

  test('zgłoszenie bez zapisu wysłanych wartości: wariant z etykiety', () => {
    const e = variantOf({ 'radio-12': 'Ekspres – do 3 godzin' }, null);
    assert.deepEqual([e.service, e.service_option], ['podmiejska', 'Ekspres']);
  });

  test('etykieta ze zmienionym opisem po półpauzie wciąż wskazuje wariant', () => {
    const e = variantOf({ 'radio-11': 'Standard – do 5 godzin' }, null);
    assert.equal(e.service_option, 'Standard');
  });

  test('starszy zapis z wartością pod kluczem pola', () => {
    const e = variantOf({ 'radio-11': 'two' }, null);
    assert.equal(e.service_option, 'Standard');
  });

  test('encje HTML i twarda spacja w zapisanej etykiecie', () => {
    const e = variantOf({ 'radio-11': 'Ekspres&nbsp;&#8211; do 2 godzin' }, null);
    assert.equal(e.service_option, 'Ekspres');
  });

  test('opcja bez półpauzy: cała etykieta jest wariantem', () => {
    const e = variantOf({ 'radio-14': 'kurier dedykowany' }, { 'radio-14': 'two' });
    assert.deepEqual([e.service, e.service_option], ['kurier dedykowany', 'kurier dedykowany']);
  });

  test('wartość spoza opcji daje grupę bez wariantu, a nie wolny tekst', () => {
    const e = variantOf({ 'radio-11': 'Darmowa dostawa – dziś' }, { 'radio-11': 'free' });
    assert.deepEqual([e.service, e.service_option], ['miejska', '']);
  });

  test('grupa z pierwszego wypełnionego pola usług, w kolejności z konfiguracji', () => {
    const e = variantOf({ 'radio-11': '', 'radio-13': 'Standard – następny dzień roboczy (8:00 – 17:00)' }, { 'radio-13': 'two' });
    assert.deepEqual([e.service, e.service_option], ['krajowa', 'Standard']);
  });

  test('bez pola usług: grupa i wariant puste', () => {
    const e = variantOf({}, { 'select-2': 'one' });
    assert.deepEqual([e.service, e.service_option], ['', '']);
  });

  test('pełny wpis: wyłącznie allowlista, dane zminimalizowane, data z surowego zapisu', () => {
    const out = runBridge({ entries: [saved(7, { 'radio-11': 'Standard – do 4 godzin' }, { 'radio-11': 'two' })] });
    assert.equal(out.route, 'example/v1/order-analytics');
    assert.deepEqual(out.response.entries, [{
      entry_id: 7,
      date: '2026-05-16',
      service: 'miejska',
      service_option: 'Standard',
      from_city: 'Katowice',
      from_region: '40',
      to_city: 'Zielona Góra',
      to_region: '65',
      source_page: '/kurier-dedykowany/'
    }]);
    assert.doesNotMatch(JSON.stringify(out), /Przykładowa|Testowa|osoba@|600 000|40-001/, 'bez ulicy, kontaktu i pełnego kodu');
  });

  test('tryb audytu zwraca samo mapowanie i nie czyta zgłoszeń', () => {
    const out = runBridge({ params: { mapping_only: '1' }, entries: [saved(7, { 'radio-11': 'two' }, null)] });
    assert.equal(out.reads, 0);
    assert.equal(out.response.entries, undefined);
    assert.deepEqual(out.response.mapping.map(m => m.field + ':' + m.group + ':' + m.type), [
      'radio-11:miejska:radio', 'radio-12:podmiejska:radio', 'radio-13:krajowa:radio', 'radio-14:kurier dedykowany:radio',
      'address-7::address', 'address-8::address', 'hidden-3::hidden'
    ]);
  });

  test('pole usług innego typu w formularzu to 409 bez odczytu zgłoszeń', () => {
    const fields = Object.assign({}, FIELDS, { 'radio-12': { type: 'text', field_label: 'Uwagi' } });
    const out = runBridge({ fields, entries: [saved(7, { 'radio-11': 'two' }, null)] });
    assert.deepEqual([out.error, out.status, out.reads], ['order_analytics_mapping', 409, 0]);
  });
});
