'use strict';

/**
 * #195: zlecenia z formularza do analityki. Most PHP jest testowany na tekście
 * wygenerowanego kodu (wzorem forminator-history), a import — na atrapie REST.
 * Numer formularza i klucze pól są syntetyczne; prawdziwe żyją w Script Properties.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain, freezeClock } = require('./helpers/gas');

const FORM_ID = 321;
const SHEET = 'ZLECENIA ANALITYKA';
const HEADER = ['Nr', 'Data', 'Usługa', 'Wariant usługi', 'Skąd', 'Skąd (region)', 'Dokąd', 'Dokąd (region)', 'Strona wysłania', 'Pobrano'];
const KEYS = ['entry_id', 'date', 'service', 'service_option', 'from_city', 'from_region', 'to_city', 'to_region', 'source_page'];
const RESULTS_HEADER = ['result_id', 'command_id', 'wp_id', 'slug', 'status', 'link', 'title', 'modified', 'content', 'at', 'rm_title', 'rm_desc', 'kind'];
const SNAPSHOTS_HEADER = [
  'snapshot_id', 'command_id', 'wp_id', 'slug', 'title_before', 'excerpt_before', 'content_before', 'status_before',
  'modified_before', 'created_at', 'rank_math_title_before', 'rank_math_description_before', 'rank_math_captured',
  'snapshot_kind', 'media_before_json', 'code_snippet_before_json', 'code_snippet_code_chunk'
];
const BASE_PROPS = {
  WP_BASE_URL: 'https://www.example.pl',
  WP_USERNAME: 'bot',
  WP_APP_PASSWORD: 'pw',
  WP_ALLOW_WRITES: 'TRUE',
  WP_REST_NAMESPACE: 'example',
  WP_ORDER_FORM_ID: String(FORM_ID),
  WP_ORDER_SERVICE_FIELDS: 'radio-11:miejska, radio-12:podmiejska, radio-13:krajowa, radio-14:kurier dedykowany',
  WP_ORDER_FROM_FIELD: 'address-7',
  WP_ORDER_TO_FIELD: 'address-8',
  WP_ORDER_SOURCE_FIELD: 'hidden-3'
};
const MAPPING = [
  { field: 'radio-11', group: 'miejska', type: 'radio', label: 'Serwis miejski' },
  { field: 'radio-12', group: 'podmiejska', type: 'radio', label: 'Serwis podmiejski' },
  { field: 'radio-13', group: 'krajowa', type: 'radio', label: 'Serwis krajowy' },
  { field: 'radio-14', group: 'kurier dedykowany', type: 'radio', label: 'Kurier dedykowany' },
  { field: 'address-7', group: '', type: 'address', label: 'Adres nadania' },
  { field: 'address-8', group: '', type: 'address', label: 'Adres doręczenia' },
  { field: 'hidden-3', group: '', type: 'hidden', label: 'landing_page' }
];

const entry = (id, overrides = {}) => Object.assign({
  entry_id: id,
  date: '2026-09-20',
  service: 'krajowa',
  service_option: 'Ekspres 12',
  from_city: 'Katowice',
  from_region: '40',
  to_city: 'Zielona Góra',
  to_region: '65',
  source_page: '/kurier-dedykowany/'
}, overrides);

function makeRouter(options = {}) {
  const state = { snippet: options.snippet || null, pages: options.pages || {}, calls: [] };
  const fetch = (url, params = {}) => {
    state.calls.push({ url, params });
    const parsed = new URL(url);
    const method = String(params.method || 'get').toLowerCase();
    if (parsed.pathname === '/wp-json/code-snippets/v1/snippets' && method === 'get') {
      return { code: 200, json: state.snippet ? [state.snippet] : [], headers: { 'X-WP-TotalPages': '1' } };
    }
    if (parsed.pathname === '/wp-json/code-snippets/v1/snippets' && method === 'post') {
      state.snippet = Object.assign({ id: 401, modified: '2026-09-26T12:00:00+00:00', code_error: null }, JSON.parse(params.payload));
      return { code: 201, json: state.snippet, headers: {} };
    }
    const item = /^\/wp-json\/code-snippets\/v1\/snippets\/(\d+)$/.exec(parsed.pathname);
    if (item && method === 'post') {
      if (options.failUpdate) return { code: 500, text: 'update failed', headers: {} };
      Object.assign(state.snippet, JSON.parse(params.payload));
      state.updates = (state.updates || 0) + 1;
      return { code: 200, json: state.snippet, headers: {} };
    }
    if (item && method === 'get') {
      return state.snippet && Number(item[1]) === Number(state.snippet.id)
        ? { code: 200, json: state.snippet, headers: {} }
        : { code: 404, text: 'missing', headers: {} };
    }
    const toggle = /^\/wp-json\/code-snippets\/v1\/snippets\/(\d+)\/(activate|deactivate)$/.exec(parsed.pathname);
    if (toggle && method === 'post') {
      state.snippet.active = toggle[2] === 'activate';
      return { code: 200, json: state.snippet, headers: {} };
    }
    if (parsed.pathname === '/wp-json/example/v1/order-analytics' && method === 'get') {
      if (options.httpCode) return { code: options.httpCode, text: '{"code":"order_analytics_mapping"}', headers: {} };
      if (parsed.searchParams.get('mapping_only')) {
        return { code: 200, json: options.mappingPayload || { form_id: FORM_ID, mapping: MAPPING }, headers: {} };
      }
      const page = Number(parsed.searchParams.get('page') || 1);
      const payload = Object.prototype.hasOwnProperty.call(state.pages, page)
        ? state.pages[page]
        : { form_id: FORM_ID, count: 0, page: page, per_page: 100, mapping: MAPPING, entries: [] };
      return { code: 200, json: payload, headers: {} };
    }
    throw new Error('No route for ' + method + ' ' + url);
  };
  return { state, fetch };
}

const page = (entries, count) => ({ form_id: FORM_ID, count: count === undefined ? entries.length : count, page: 1, per_page: 100, mapping: MAPPING, entries });

function project({ router, properties = {}, uiAnswer = 'YES', sheet } = {}) {
  const sheets = { 'WP RESULTS': [RESULTS_HEADER], 'WP SNAPSHOTS': [SNAPSHOTS_HEADER] };
  if (sheet) sheets[SHEET] = sheet;
  const gas = loadProject({
    properties: Object.assign({}, BASE_PROPS, properties),
    sheets: sheets,
    fetch: router ? router.fetch : (() => ({ code: 200, json: [], headers: {} }))
  });
  gas.$ui.$answer = uiAnswer;
  return gas;
}

const wpWrites = router => router.state.calls.filter(c => String(c.params.method || 'get').toLowerCase() !== 'get');
const dataRows = gas => (gas.$sheet(SHEET) || []).slice(1).filter(r => r.some(v => v !== '' && v !== null && v !== undefined));

describe('#195: kod mostu (test 8)', () => {
  const code = () => project().buildOrderAnalyticsBridgeCode_();

  test('GET, tylko administrator, a typ pól sprawdzany przed odczytem zgłoszeń', () => {
    const php = code();
    assert.match(php, /'methods' => 'GET'/);
    assert.match(php, /current_user_can\( 'manage_options' \)/);
    assert.ok(php.indexOf('order_analytics_mapping') > 0);
    assert.ok(php.indexOf('order_analytics_mapping') < php.indexOf('get_entries'), 'kontrola typów przed pobraniem zgłoszeń');
    assert.ok(php.indexOf("get_param( 'mapping_only' )") > php.indexOf('order_analytics_mapping'), 'tryb audytu po kontroli typów');
    assert.ok(php.indexOf("get_param( 'mapping_only' )") < php.indexOf('count_entries'), 'tryb audytu przed jakimkolwiek odczytem zgłoszeń');
    assert.ok(php.includes("return rest_ensure_response( array( 'form_id' => $form_id, 'mapping' => $mapping ) );"), 'w trybie audytu bez zgłoszeń');
    assert.ok(php.includes("$mapping[] = array( 'field' => $key, 'group' => isset( $groups[ $key ] ) ? $groups[ $key ] : '', 'type' => $type,"), 'mapowanie niesie grupę pola usług');
    assert.match(php, /'radio-11' => array\( 'radio', 'select' \),/);
    assert.match(php, /'address-7' => array\( 'address' \),/);
    assert.match(php, /'hidden-3' => array\( 'hidden' \),/);
    assert.match(php, /array\( 'radio-14', 'kurier dedykowany' \),/);
  });

  test('w items[] wyłącznie klucze z allowlisty', () => {
    const php = code();
    const block = php.slice(php.indexOf('$items[] = array('), php.indexOf(');', php.indexOf('$items[] = array(')));
    const keys = [...block.matchAll(/'([a-z_]+)' =>/g)].map(m => m[1]);
    assert.deepEqual(keys, KEYS);
  });

  test('minimalizacja dzieje się w PHP: dwie cyfry kodu, miejscowość, data, sama ścieżka', () => {
    const php = code();
    assert.ok(php.includes("preg_match( '/^(\\d{2})-?\\d{3}$/', $zip, $zip_match ) ? $zip_match[1] : ''"), 'region = dwie pierwsze cyfry');
    assert.ok(php.includes("mb_strlen( $city ) > 40 || ! preg_match( '/^\\p{L}+(?:[ -]\\p{L}+)*$/u', $city )"), 'normalizacja miejscowości');
    assert.ok(php.includes("preg_match( '/^(\\d{4}-\\d{2}-\\d{2})/', $created, $date_match )"), 'sama data');
    assert.ok(php.includes('wp_parse_url( $src, PHP_URL_PATH )'), 'sama ścieżka adresu');
    assert.ok(php.includes("$source_page = preg_match( '#^/[A-Za-z0-9/._~%-]{0,199}$#', $path ) ? $path : '';"));
  });

  test('kod nie sięga po pola bezpośrednio identyfikujące', () => {
    const php = code();
    assert.doesNotMatch(php, /street|e-?mail|phone|textarea|first[-_]name|last[-_]name|company/i);
    const addressReads = [...php.matchAll(/\$address\['([a-z_]+)'\]/g)].map(m => m[1]);
    assert.deepEqual([...new Set(addressReads)].sort(), ['city', 'zip'], 'z adresu tylko miasto i kod');
  });

  test('bez pola strony wysłania kod nie ma pola ukrytego', () => {
    const php = project({ properties: { WP_ORDER_SOURCE_FIELD: '' } }).buildOrderAnalyticsBridgeCode_();
    assert.match(php, /\$source_field = '';/);
    assert.doesNotMatch(php, /'hidden-\d+' =>/);
  });
});

describe('#195: konfiguracja fail-closed (test 5)', () => {
  const config = properties => project({ properties }).getOrderAnalyticsConfig_();

  for (const bad of ['email-1', 'text-2', 'textarea-1', 'name-1', 'phone-1', 'address-1', 'hidden-2']) {
    test('pole ' + bad + ' jako usługa jest odrzucane', () => {
      assert.throws(() => config({ WP_ORDER_SERVICE_FIELDS: bad + ':miejska' }), /musi wskazywać pole typu radio albo select/);
    });
  }

  test('adres i strona wysłania też wymagają dozwolonego typu', () => {
    assert.throws(() => config({ WP_ORDER_FROM_FIELD: 'text-1' }), /WP_ORDER_FROM_FIELD musi wskazywać pole typu address/);
    assert.throws(() => config({ WP_ORDER_TO_FIELD: 'name-1' }), /WP_ORDER_TO_FIELD musi wskazywać pole typu address/);
    assert.throws(() => config({ WP_ORDER_SOURCE_FIELD: 'text-3' }), /WP_ORDER_SOURCE_FIELD musi wskazywać pole typu hidden/);
  });

  test('grupa spoza słownika, duplikat i te same adresy są odrzucane', () => {
    assert.throws(() => config({ WP_ORDER_SERVICE_FIELDS: 'radio-1:ekspresowa' }), /grupa „ekspresowa” pola radio-1 jest spoza słownika/);
    assert.throws(() => config({ WP_ORDER_SERVICE_FIELDS: 'radio-1' }), /grupa „” pola radio-1 jest spoza słownika/);
    assert.throws(() => config({ WP_ORDER_SERVICE_FIELDS: 'radio-1:miejska, radio-1:krajowa' }), /występuje dwa razy/);
    assert.throws(() => config({ WP_ORDER_TO_FIELD: 'address-7' }), /wskazują to samo pole/);
  });

  test('brak formularza, usług albo namespace to odmowa', () => {
    assert.throws(() => config({ WP_ORDER_FORM_ID: '' }), /brak prawidłowej Script Property WP_ORDER_FORM_ID/);
    assert.throws(() => config({ WP_ORDER_SERVICE_FIELDS: '' }), /brak Script Property WP_ORDER_SERVICE_FIELDS/);
    assert.throws(() => config({ WP_REST_NAMESPACE: '' }), /nieprawidłowa Script Property WP_REST_NAMESPACE/);
  });

  test('poprawna konfiguracja zachowuje kolejność pól usług', () => {
    const cfg = plain(config({}));
    assert.deepEqual(cfg.services.map(s => s.group), ['miejska', 'podmiejska', 'krajowa', 'kurier dedykowany']);
    assert.deepEqual([cfg.formId, cfg.from, cfg.to, cfg.source], [FORM_ID, 'address-7', 'address-8', 'hidden-3']);
  });

  test('prepare odmawia przy niedozwolonym typie, zanim zapyta o zgodę i ruszy WordPress', () => {
    const router = makeRouter();
    const gas = project({ router, properties: { WP_ORDER_SERVICE_FIELDS: 'email-1:miejska' } });
    assert.throws(() => gas.prepareOrderAnalyticsBridge(), /musi wskazywać pole typu radio albo select/);
    assert.equal(router.state.calls.length, 0);
    assert.equal(gas.$alerts.length, 0, 'bez pytania o zgodę');
  });
});

describe('#195: instalacja snippetu (test 6)', () => {
  test('bez zgody prepare niczego nie zapisuje', () => {
    const router = makeRouter();
    const gas = project({ router, uiAnswer: 'NO' });
    assert.deepEqual(plain(gas.prepareOrderAnalyticsBridge()), { cancelled: true });
    assert.equal(wpWrites(router).length, 0);
  });

  test('bez WP_ALLOW_WRITES prepare odmawia', () => {
    const router = makeRouter();
    const gas = project({ router, properties: { WP_ALLOW_WRITES: 'FALSE' } });
    assert.throws(() => gas.prepareOrderAnalyticsBridge(), /WP_ALLOW_WRITES/);
    assert.equal(wpWrites(router).length, 0);
  });

  test('prepare tworzy wyłącznie nieaktywny snippet z oczekiwanym kodem i zapisuje ID', () => {
    const router = makeRouter();
    const gas = project({ router });
    const out = plain(gas.prepareOrderAnalyticsBridge());
    assert.deepEqual([out.snippetId, out.created, out.active], [401, true, false]);
    assert.equal(router.state.snippet.active, false);
    assert.equal(router.state.snippet.code, gas.buildOrderAnalyticsBridgeCode_());
    assert.deepEqual(router.state.snippet.tags, ['forminator-order-analytics-bridge']);
    assert.equal(gas.$properties.WP_ORDER_ANALYTICS_SNIPPET_ID, '401');
  });

  test('prepare przejmuje istniejący zgodny snippet i odmawia, gdy jest już aktywny', () => {
    const router = makeRouter();
    const gas = project({ router });
    gas.prepareOrderAnalyticsBridge();
    assert.equal(plain(gas.prepareOrderAnalyticsBridge()).created, false);
    router.state.snippet.active = true;
    assert.throws(() => gas.prepareOrderAnalyticsBridge(), /już aktywny/);
    router.state.snippet.code = 'inny kod';
    assert.throws(() => gas.prepareOrderAnalyticsBridge(), /aktywny snippet ma inny kod.*rollbackOrderAnalyticsBridge/);
    assert.equal(router.state.updates || 0, 0, 'aktywnego snippetu nie aktualizujemy');
  });

  test('prepare aktualizuje kod nieaktywnego snippetu po zmianie mapowania, z migawką poprzedniego', () => {
    const router = makeRouter();
    const gas = project({ router });
    gas.prepareOrderAnalyticsBridge();
    gas.$properties.WP_ORDER_SOURCE_FIELD = '';
    const out = plain(gas.prepareOrderAnalyticsBridge());
    assert.deepEqual([out.created, out.replaced, out.active, router.state.updates], [false, true, false, 1]);
    assert.equal(router.state.snippet.code, gas.buildOrderAnalyticsBridgeCode_());
    assert.equal(router.state.snippet.active, false, 'po aktualizacji nadal nieaktywny');
    const snapshots = gas.$sheet('WP SNAPSHOTS').slice(1);
    assert.ok(snapshots.some(r => r[1] === 'ORDER-ANALYTICS-UPDATE'), 'migawka przed zmianą kodu');
    const prompt = gas.$alerts.map(a => String(a[1] || '')).find(t => /zostanie zastąpiony/.test(t));
    assert.match(prompt, /Kod NIEAKTYWNEGO snippetu #401 zostanie zastąpiony/, 'zgoda mówi wprost o zastąpieniu kodu');
  });

  test('obcy snippet o tej nazwie nie jest nadpisywany, a o zgodę nikt nie pyta', () => {
    // Uwaga Codexa w #205: kandydat rozpoznany po samej nazwie nie jest nasz.
    const router = makeRouter({
      snippet: { id: 401, name: 'Order Analytics Bridge', code: 'cudzy kod', scope: 'global', active: false, tags: [], code_error: null }
    });
    const gas = project({ router });
    assert.throws(() => gas.prepareOrderAnalyticsBridge(), /nie jest ostatnią wersją przygotowaną przez skrypt/);
    assert.equal(router.state.updates || 0, 0);
    assert.equal(gas.$alerts.length, 0);
    assert.equal(router.state.snippet.code, 'cudzy kod');
  });

  test('kod zmieniony ręcznie w WordPressie nie jest nadpisywany', () => {
    const router = makeRouter();
    const gas = project({ router });
    gas.prepareOrderAnalyticsBridge();
    router.state.snippet.code = 'ręczna poprawka administratora';
    gas.$properties.WP_ORDER_SOURCE_FIELD = '';
    assert.throws(() => gas.prepareOrderAnalyticsBridge(), /kod zmieniony poza skryptem/);
    assert.equal(router.state.updates || 0, 0);
    assert.equal(router.state.snippet.code, 'ręczna poprawka administratora');
  });

  test('nieudany zapis nowego kodu kończy prepare błędem i nie zmienia zapisanego skrótu', () => {
    const router = makeRouter({ failUpdate: true });
    const gas = project({ router });
    gas.prepareOrderAnalyticsBridge();
    const oldCode = router.state.snippet.code;
    const oldDigest = gas.$properties.WP_ORDER_ANALYTICS_CODE_DIGEST;
    gas.$properties.WP_ORDER_SOURCE_FIELD = '';
    assert.throws(() => gas.prepareOrderAnalyticsBridge());
    assert.equal(router.state.snippet.code, oldCode);
    assert.equal(gas.$properties.WP_ORDER_ANALYTICS_CODE_DIGEST, oldDigest);
  });

  test('po zmianie mapowania działa opisana ścieżka naprawy: rollback, prepare, activate', () => {
    // Uwaga Codexa w #205: import każe przygotować snippet ponownie, więc ta
    // ścieżka musi naprawdę istnieć, bez ręcznej edycji w WordPressie.
    const router = makeRouter({ pages: { 1: page([entry(7)]) } });
    const gas = project({ router });
    gas.prepareOrderAnalyticsBridge();
    gas.activateOrderAnalyticsBridge();
    gas.$properties.WP_ORDER_SOURCE_FIELD = '';
    assert.throws(() => gas.importujZleceniaAnalityka(), /rollbackOrderAnalyticsBridge\(\), prepareOrderAnalyticsBridge\(\)/);
    gas.rollbackOrderAnalyticsBridge();
    gas.prepareOrderAnalyticsBridge();
    assert.equal(plain(gas.activateOrderAnalyticsBridge()).active, true);
    assert.equal(router.state.snippet.code, gas.buildOrderAnalyticsBridgeCode_(), 'aktywny snippet z nowym mapowaniem');
    assert.doesNotMatch(router.state.snippet.code, /hidden-3/);
  });

  test('zgoda uzbrojona w edytorze jest zużywana przez jedną operację', () => {
    const router = makeRouter();
    const gas = project({ router, uiAnswer: 'NO' });
    gas.armOrderAnalyticsWrite();
    assert.equal(plain(gas.prepareOrderAnalyticsBridge()).active, false, 'zgoda z arm, bez pytania UI');
    assert.equal(gas.$properties.WP_ORDER_ANALYTICS_WRITE_APPROVAL, undefined, 'zgoda zużyta');
    assert.deepEqual(plain(gas.activateOrderAnalyticsBridge()), { cancelled: true }, 'następna operacja znowu pyta');
  });

  test('bez UI i bez uzbrojenia: czytelny błąd zamiast cichej zgody', () => {
    const router = makeRouter();
    const gas = project({ router });
    gas.SpreadsheetApp.getUi = () => { throw new Error('no ui'); };
    assert.throws(() => gas.prepareOrderAnalyticsBridge(), /brak kontekstu UI.*armOrderAnalyticsWrite/);
    assert.equal(wpWrites(router).length, 0);
  });

  test('z edytora: uzbrojona zgoda przechodzi, a komunikat trafia do logu', () => {
    const router = makeRouter();
    const gas = project({ router });
    gas.SpreadsheetApp.getUi = () => { throw new Error('no ui'); };
    gas.armOrderAnalyticsWrite();
    assert.equal(plain(gas.prepareOrderAnalyticsBridge()).snippetId, 401, 'bez wyjątku mimo braku UI');
  });

  test('aktywacja bez przygotowania i anulowane wycofanie nie ruszają WordPressa', () => {
    const router = makeRouter();
    const gas = project({ router });
    assert.throws(() => gas.activateOrderAnalyticsBridge(), /brak zapisanego ID snippetu/);
    gas.$ui.$answer = 'NO';
    assert.deepEqual(plain(gas.rollbackOrderAnalyticsBridge()), { cancelled: true });
    assert.equal(wpWrites(router).length, 0);
  });

  test('aktywacja i wycofanie działają po zapisanym ID', () => {
    const router = makeRouter();
    const gas = project({ router });
    gas.prepareOrderAnalyticsBridge();
    assert.equal(plain(gas.activateOrderAnalyticsBridge()).active, true);
    assert.equal(router.state.snippet.active, true);
    assert.equal(plain(gas.activateOrderAnalyticsBridge()).alreadyActive, true);
    assert.equal(plain(gas.rollbackOrderAnalyticsBridge()).active, false);
    assert.equal(router.state.snippet.active, false);
  });

  test('audyt aktywnego mostu pokazuje mapowanie pól bez wartości zgłoszeń', () => {
    const router = makeRouter({ pages: { 1: page([entry(7)]) } });
    const gas = project({ router });
    gas.prepareOrderAnalyticsBridge();
    gas.activateOrderAnalyticsBridge();
    const state = plain(gas.auditOrderAnalyticsBridge());
    assert.deepEqual(state.mapping, MAPPING);
    const text = gas.$alerts[gas.$alerts.length - 1][0];
    assert.match(text, /- radio-11 → miejska \(radio\): Serwis miejski/);
    assert.match(text, /- address-7 \(address\): Adres nadania/);
    assert.doesNotMatch(text, /Katowice|Zielona Góra/, 'bez wartości zgłoszeń');
    // Uwaga Codexa w #205: audyt nie może pobierać zgłoszeń, nawet jednego.
    const calls = router.state.calls.filter(c => c.url.includes('/order-analytics'));
    assert.deepEqual(calls.map(c => new URL(c.url).search), ['?mapping_only=1']);
  });

  test('odpowiedź trybu mapowania ze zgłoszeniami albo z błędem HTTP jest odrzucana', () => {
    const leaky = makeRouter({ mappingPayload: { form_id: FORM_ID, mapping: MAPPING, entries: [entry(7)] } });
    const gas = project({ router: leaky });
    gas.prepareOrderAnalyticsBridge();
    gas.activateOrderAnalyticsBridge();
    assert.throws(() => gas.auditOrderAnalyticsBridge(), /nieprawidłowa odpowiedź endpointu w trybie mapowania/);
    assert.throws(() => project({ router: makeRouter({ httpCode: 409 }) }).fetchOrderAnalyticsMapping_(), /HTTP 409/);
  });

  test('audyt nieaktywnego mostu nie woła endpointu', () => {
    const router = makeRouter();
    const gas = project({ router });
    gas.prepareOrderAnalyticsBridge();
    assert.deepEqual(plain(gas.auditOrderAnalyticsBridge()).mapping, []);
    assert.equal(router.state.calls.filter(c => c.url.includes('/order-analytics')).length, 0);
  });
});

describe('#195: import do zakładki', () => {
  test('zapisuje wyłącznie kolumny kontraktu, a regiony jako tekst (test 1)', () => {
    const router = makeRouter({ pages: { 1: page([entry(7)]) } });
    const gas = project({ router });
    const out = plain(gas.importujZleceniaAnalityka());
    assert.deepEqual([out.fetched, out.written, out.expired], [1, 1, 0]);
    assert.deepEqual(gas.$sheet(SHEET)[0], HEADER);
    const row = dataRows(gas)[0];
    assert.deepEqual(row.slice(0, 9), [7, '2026-09-20', 'krajowa', 'Ekspres 12', 'Katowice', '40', 'Zielona Góra', '65', '/kurier-dedykowany/']);
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName(SHEET);
    assert.deepEqual([sheet.getRange(2, 6).getNumberFormat(), sheet.getRange(2, 8).getNumberFormat()], ['@', '@'], 'zero wiodące regionu przetrwa');
    assert.match(gas.$alerts[0][0], /Bez danych kontaktowych/);
  });

  test('pole spoza allowlisty w odpowiedzi przerywa import i nie rusza zakładki', () => {
    const before = [HEADER, [5, '2026-09-01', 'miejska', 'Standard', 'Łódź', '90', 'Łódź', '91', '/', 'x']];
    const router = makeRouter({ pages: { 1: page([Object.assign(entry(7), { email: 'x@example.com' })]) } });
    const gas = project({ router, sheet: before.map(r => r.slice()) });
    assert.throws(() => gas.importujZleceniaAnalityka(), /pola spoza allowlisty \(email\)/);
    assert.deepEqual(gas.$sheet(SHEET), before);
  });

  test('błąd mapowania w WordPressie (409) kończy import błędem bez zmiany zakładki (test 5)', () => {
    const before = [HEADER, [5, '2026-09-01', 'miejska', 'Standard', 'Łódź', '90', 'Łódź', '91', '/', 'x']];
    const gas = project({ router: makeRouter({ httpCode: 409 }), sheet: before.map(r => r.slice()) });
    assert.throws(() => gas.importujZleceniaAnalityka(), /HTTP 409/);
    assert.deepEqual(gas.$sheet(SHEET), before);
  });

  test('snippet z nieaktualnym mapowaniem przerywa import i nie rusza zakładki', () => {
    // Uwaga Codexa w #205: Script Properties zmienione, snippet w WordPressie nie.
    const before = [HEADER, [5, '2026-09-01', 'miejska', 'Standard', 'Łódź', '90', 'Łódź', '91', '/', 'x']];
    const router = makeRouter({ pages: { 1: page([entry(7)]) } });
    for (const properties of [
      { WP_ORDER_SERVICE_FIELDS: 'radio-11:krajowa, radio-12:podmiejska, radio-13:miejska, radio-14:kurier dedykowany' },
      { WP_ORDER_FROM_FIELD: 'address-9' },
      { WP_ORDER_SOURCE_FIELD: '' }
    ]) {
      const gas = project({ router, properties, sheet: before.map(r => r.slice()) });
      assert.throws(() => gas.importujZleceniaAnalityka(), /most w WordPressie czyta inne pola .* niż wskazują Script Properties/);
      assert.deepEqual(gas.$sheet(SHEET), before);
    }
  });

  test('etykieta opcji zaczynająca się od znaku formuły staje się pustą komórką', () => {
    const router = makeRouter({
      pages: { 1: page(['=IMPORTXML("x")', '+1', '-2', '@x', 'Ekspres'].map((o, i) => entry(i + 1, { service_option: o }))) }
    });
    const gas = project({ router });
    gas.importujZleceniaAnalityka();
    assert.deepEqual(dataRows(gas).map(r => r[3]), ['', '', '', '', 'Ekspres']);
  });

  test('ponowny import: ta sama liczba wierszy, wartości zaktualizowane (test 4)', () => {
    const router = makeRouter({ pages: { 1: page([entry(7), entry(8)]) } });
    const gas = project({ router });
    gas.importujZleceniaAnalityka();
    router.state.pages[1] = page([entry(7, { service_option: 'Standard' }), entry(8)]);
    gas.importujZleceniaAnalityka();
    const rows = dataRows(gas);
    assert.equal(rows.length, 2);
    assert.equal(rows.find(r => r[0] === 7)[3], 'Standard');
  });

  test('zgłoszenie usunięte w WordPressie znika z zakładki przy następnym imporcie', () => {
    const router = makeRouter({ pages: { 1: page([entry(7), entry(8)]) } });
    const gas = project({ router });
    gas.importujZleceniaAnalityka();
    router.state.pages[1] = page([entry(8)]);
    gas.importujZleceniaAnalityka();
    assert.deepEqual(dataRows(gas).map(r => r[0]), [8]);
  });

  test('zgłoszenia starsze niż 24 miesiące nie trafiają do zakładki (test 7)', () => {
    const router = makeRouter({ pages: { 1: page([entry(1, { date: '2024-09-25' }), entry(2, { date: '2024-09-26' }), entry(3)]) } });
    const gas = freezeClock(project({ router }), 2026, 8, 26);
    const out = plain(gas.importujZleceniaAnalityka());
    assert.deepEqual(dataRows(gas).map(r => r[0]), [2, 3], 'granica: dokładnie 24 miesiące wstecz zostaje');
    assert.equal(out.expired, 1);
    assert.match(gas.$alerts[0][0], /Pominięte jako starsze niż 24 miesiące: 1/);
  });

  test('wartości o złym kształcie stają się pustą komórką (testy 3, 9, 11)', () => {
    const router = makeRouter({
      pages: {
        1: page([entry(7, {
          from_city: 'Przykładowa 12', from_region: '123', to_city: 'Kraków, ul. Długa',
          source_page: 'javascript:alert(1)', service: 'ekspres'
        }), { entry_id: 8, date: '2026-09-21' }])
      }
    });
    const gas = project({ router });
    gas.importujZleceniaAnalityka();
    const rows = dataRows(gas);
    assert.deepEqual(rows[0].slice(0, 9), [7, '2026-09-20', '', 'Ekspres 12', '', '', '', '65', '']);
    assert.deepEqual(rows[1].slice(0, 9), [8, '2026-09-21', '', '', '', '', '', '', ''], 'brak pól to puste komórki, nie wyjątek');
  });

  test('zgłoszenie bez daty albo z uszkodzoną datą nie trafia do zakładki', () => {
    // Uwaga Codexa w #205: bez daty retencja nie ustali wieku, więc wiersz
    // wracałby przy każdej synchronizacji i omijał 24 miesiące.
    const router = makeRouter({ pages: { 1: page([entry(7, { date: '20.09.2026' }), { entry_id: 8 }, entry(9)]) } });
    const gas = project({ router });
    const out = plain(gas.importujZleceniaAnalityka());
    assert.deepEqual(dataRows(gas).map(r => r[0]), [9]);
    assert.deepEqual([out.undated, out.expired, out.written], [2, 0, 1]);
    assert.match(gas.$alerts[0][0], /Pominięte bez prawidłowej daty .*: 2/);
  });

  test('data niemożliwa albo z przyszłości nie trafia do zakładki; jutro jest dopuszczone', () => {
    // Uwaga Codexa w #205: `9999-12-31` ominęłoby retencję na zawsze.
    const router = makeRouter({
      pages: {
        1: page([
          entry(1, { date: '2026-02-31' }), entry(2, { date: '9999-12-31' }), entry(3, { date: '2026-09-28' }),
          entry(4, { date: '2026-09-27' }), entry(5, { date: '2026-09-26' })
        ])
      }
    });
    const gas = freezeClock(project({ router }), 2026, 8, 26);
    const out = plain(gas.importujZleceniaAnalityka());
    assert.deepEqual(dataRows(gas).map(r => r[0]), [4, 5], 'jutro zostaje: zapas na różnicę stref WordPressa i arkusza');
    assert.equal(out.undated, 3);
  });

  test('granica retencji: miesiące liczone na dacie, z przycięciem do końca miesiąca', () => {
    const gas = project();
    assert.equal(gas.orderShiftMonths_('2028-02-29', -24), '2026-02-28');
    assert.equal(gas.orderShiftMonths_('2026-03-31', -1), '2026-02-28');
    assert.equal(gas.orderShiftMonths_('2026-01-31', -2), '2025-11-30');
    assert.equal(gas.orderShiftMonths_('2026-09-26', -24), '2024-09-26');
    assert.equal(gas.orderShiftDays_('2026-12-31', 1), '2027-01-01');
    assert.equal(gas.orderCalendarDate_('2024-02-29'), '2024-02-29');
    assert.equal(gas.orderCalendarDate_('2026-02-29'), '');
  });

  test('retencja liczona od 29 lutego zostawia 28 lutego sprzed dwóch lat', () => {
    const router = makeRouter({ pages: { 1: page([entry(1, { date: '2026-02-27' }), entry(2, { date: '2026-02-28' }), entry(3, { date: '2028-02-29' })]) } });
    const gas = freezeClock(project({ router }), 2028, 1, 29);
    const out = plain(gas.importujZleceniaAnalityka());
    assert.deepEqual(dataRows(gas).map(r => r[0]), [2, 3]);
    assert.equal(out.expired, 1);
  });

  test('za długa miejscowość i wariant są przycinane albo odrzucane', () => {
    const router = makeRouter({ pages: { 1: page([entry(7, { to_city: 'A'.repeat(41), service_option: 'W'.repeat(60) })]) } });
    const gas = project({ router });
    gas.importujZleceniaAnalityka();
    const row = dataRows(gas)[0];
    assert.equal(row[6], '');
    assert.equal(row[3].length, 40);
  });

  test('wiele stron i spójność liczby zgłoszeń', () => {
    const first = Array.from({ length: 100 }, (_, i) => entry(i + 1));
    const router = makeRouter({ pages: { 1: page(first, 101), 2: page([entry(101)], 101) } });
    const gas = project({ router });
    assert.equal(plain(gas.importujZleceniaAnalityka()).written, 101);

    const broken = makeRouter({ pages: { 1: page([entry(1), entry(2)], 3) } });
    assert.throws(() => project({ router: broken }).importujZleceniaAnalityka(), /oczekiwano 3 unikalnych zgłoszeń, pobrano 2/);

    const moving = makeRouter({ pages: { 1: page(first, 101), 2: page([entry(101)], 102) } });
    assert.throws(() => project({ router: moving }).importujZleceniaAnalityka(), /zmieniła się w trakcie importu/);
  });

  test('odpowiedź innego formularza albo bez listy wpisów jest odrzucana', () => {
    const other = makeRouter({ pages: { 1: Object.assign(page([entry(1)]), { form_id: 999 }) } });
    assert.throws(() => project({ router: other }).importujZleceniaAnalityka(), /nieprawidłowa odpowiedź endpointu/);
    const noId = makeRouter({ pages: { 1: page([entry('x')]) } });
    assert.throws(() => project({ router: noId }).importujZleceniaAnalityka(), /bez prawidłowego entry_id/);
    const notObject = makeRouter({ pages: { 1: page([null]) } });
    assert.throws(() => project({ router: notObject }).importujZleceniaAnalityka(), /nie jest obiektem/);
    const huge = makeRouter({ pages: { 1: page([], 50001) } });
    assert.throws(() => project({ router: huge }).importujZleceniaAnalityka(), /limit bezpieczeństwa/);
  });
});

describe('#195: katalog i menu', () => {
  test('zakładka w katalogu: dane, właściciel skrypt', () => {
    const e = plain(project().sheetCatalog_()).find(x => x.name === SHEET);
    assert.deepEqual([e.category, e.owner], ['dane', 'skrypt']);
  });

  test('import jest w menu WordPress', () => {
    const gas = project();
    gas.onOpen();
    const wp = gas.$menus.find(m => m.title === 'WordPress');
    assert.ok(wp.items.some(i => i.fn === 'importujZleceniaAnalityka'));
  });
});
