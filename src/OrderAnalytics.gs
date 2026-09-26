/**
 * Zlecenia z formularza do analityki popytu (#195).
 *
 * Most w WordPressie (snippet Code Snippets) wydaje dla każdego zgłoszenia
 * formularza zleceń WYŁĄCZNIE pola z allowlisty, zminimalizowane po stronie PHP:
 * datę, grupę i wariant usługi, miejscowości po normalizacji, regiony z dwóch
 * pierwszych cyfr kodu i ścieżkę strony wysłania. Import zapisuje je do zakładki
 * „ZLECENIA ANALITYKA”.
 *
 * Czego tu świadomie NIE ma: imienia i nazwiska, telefonu, e-maila, firmy, ulicy,
 * pełnego kodu pocztowego ani uwag. Żaden klucz wyjściowy nie dopuszcza ich typu
 * pola ani podpola. Zakładka to mimo to dane osobowe pseudonimizowane: `entry_id`
 * łączy wiersz ze zgłoszeniem, a miejscowość jest wolnym tekstem — stąd retencja
 * 24 miesiące w kodzie.
 *
 * Mapowanie działa fail-closed. Przedrostek klucza pola (`<typ>-<numer>`) jest
 * sprawdzany już przy przygotowaniu snippetu, a typ w schemacie formularza — w PHP
 * przy każdym wywołaniu. Pole innego typu albo nieobecne w formularzu daje błąd
 * bez wierszy, a zakładka zostaje bez zmian.
 */

const ORDER_ANALYTICS_TAG = 'forminator-order-analytics-bridge';
const ORDER_ANALYTICS_NAME = 'Order Analytics Bridge';
const ORDER_ANALYTICS_ENDPOINT = 'order-analytics';
const ORDER_ANALYTICS_SNIPPET_ID_PROP = 'WP_ORDER_ANALYTICS_SNIPPET_ID';
const ORDER_ANALYTICS_WRITE_APPROVAL_PROP = 'WP_ORDER_ANALYTICS_WRITE_APPROVAL';
const ORDER_ANALYTICS_CODE_DIGEST_PROP = 'WP_ORDER_ANALYTICS_CODE_DIGEST';
const ORDER_FORM_ID_PROP = 'WP_ORDER_FORM_ID';
const ORDER_SERVICE_FIELDS_PROP = 'WP_ORDER_SERVICE_FIELDS';
const ORDER_FROM_FIELD_PROP = 'WP_ORDER_FROM_FIELD';
const ORDER_TO_FIELD_PROP = 'WP_ORDER_TO_FIELD';
const ORDER_SOURCE_FIELD_PROP = 'WP_ORDER_SOURCE_FIELD';

const ORDER_ANALYTICS_SHEET = 'ZLECENIA ANALITYKA';
const ORDER_ANALYTICS_HEADER = ['Nr', 'Data', 'Usługa', 'Wariant usługi', 'Skąd', 'Skąd (region)', 'Dokąd', 'Dokąd (region)', 'Strona wysłania', 'Pobrano'];
const ORDER_ANALYTICS_RETENTION_MONTHS = 24;
const ORDER_ANALYTICS_MAX_ENTRIES = 50000;

/** Grupy usług: ten sam słownik co lista `Usługa` rejestru zapytań telefonicznych (#196). */
const ORDER_SERVICE_GROUPS = ['miejska', 'podmiejska', 'krajowa', 'kurier dedykowany'];

/** Allowlista kluczy odpowiedzi mostu. Każdy inny klucz przerywa import. */
const ORDER_ANALYTICS_KEYS = ['entry_id', 'date', 'service', 'service_option', 'from_city', 'from_region', 'to_city', 'to_region', 'source_page'];

/** Dozwolone typy pól źródłowych per rola; te same sprawdza PHP przy każdym wywołaniu. */
const ORDER_FIELD_TYPES = { service: ['radio', 'select'], address: ['address'], source: ['hidden'] };

/** Miejscowość: litery, spacje i łącznik, najwyżej 40 znaków — ta sama reguła co w PHP. */
const ORDER_CITY_PATTERN = /^\p{L}+(?:[ -]\p{L}+)*$/u;
const ORDER_PATH_PATTERN = /^\/[A-Za-z0-9/._~%-]{0,199}$/;

// --- Konfiguracja -----------------------------------------------------------

/** Klucz pola Forminatora w postaci `<typ>-<numer>`; typ spoza listy to odmowa. */
function orderFieldKey_(value, types, prop) {
  const text = String(value || '').trim();
  const match = /^([a-z]+)-(\d+)$/.exec(text);
  if (!match || types.indexOf(match[1]) < 0) {
    throw new Error(
      'Zlecenia: Script Property ' + prop + ' musi wskazywać pole typu ' + types.join(' albo ') +
      ' (klucz ' + types[0] + '-<numer>), jest „' + text + '”.'
    );
  }
  return text;
}

/** „radio-1:miejska, radio-5:podmiejska” → [{ field, group }] w kolejności wpisu. */
function parseOrderServiceFields_(value) {
  const parts = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) {
    throw new Error('Zlecenia: brak Script Property ' + ORDER_SERVICE_FIELDS_PROP + ' (np. radio-1:miejska, radio-5:podmiejska).');
  }
  const seen = {};
  return parts.map(part => {
    const at = part.indexOf(':');
    const field = orderFieldKey_(at < 0 ? part : part.slice(0, at), ORDER_FIELD_TYPES.service, ORDER_SERVICE_FIELDS_PROP);
    const group = at < 0 ? '' : part.slice(at + 1).trim();
    if (ORDER_SERVICE_GROUPS.indexOf(group) < 0) {
      throw new Error('Zlecenia: grupa „' + group + '” pola ' + field + ' jest spoza słownika: ' + ORDER_SERVICE_GROUPS.join(', ') + '.');
    }
    if (seen[field]) throw new Error('Zlecenia: pole ' + field + ' występuje dwa razy w ' + ORDER_SERVICE_FIELDS_PROP + '.');
    seen[field] = true;
    return { field: field, group: group };
  });
}

function getOrderAnalyticsConfig_() {
  const props = PropertiesService.getScriptProperties();
  const formText = String(props.getProperty(ORDER_FORM_ID_PROP) || '').trim();
  if (!/^\d+$/.test(formText) || Number(formText) < 1) {
    throw new Error('Zlecenia: brak prawidłowej Script Property ' + ORDER_FORM_ID_PROP + '.');
  }
  const namespace = String(getWpConfig_().restNamespace || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(namespace)) {
    throw new Error('Zlecenia: brak albo nieprawidłowa Script Property WP_REST_NAMESPACE.');
  }
  const from = orderFieldKey_(props.getProperty(ORDER_FROM_FIELD_PROP), ORDER_FIELD_TYPES.address, ORDER_FROM_FIELD_PROP);
  const to = orderFieldKey_(props.getProperty(ORDER_TO_FIELD_PROP), ORDER_FIELD_TYPES.address, ORDER_TO_FIELD_PROP);
  if (from === to) throw new Error('Zlecenia: ' + ORDER_FROM_FIELD_PROP + ' i ' + ORDER_TO_FIELD_PROP + ' wskazują to samo pole.');
  const source = String(props.getProperty(ORDER_SOURCE_FIELD_PROP) || '').trim();
  return {
    formId: Number(formText),
    namespace: namespace,
    services: parseOrderServiceFields_(props.getProperty(ORDER_SERVICE_FIELDS_PROP)),
    from: from,
    to: to,
    source: source ? orderFieldKey_(source, ORDER_FIELD_TYPES.source, ORDER_SOURCE_FIELD_PROP) : ''
  };
}

// --- Most w WordPressie -----------------------------------------------------

function orderPhpList_(values) {
  return 'array( ' + values.map(v => "'" + v + "'").join(', ') + ' )';
}

/**
 * Kod snippetu. Wszystkie wartości wstawiane do PHP przeszły walidację wyrażeniami
 * regularnymi (`orderFieldKey_`, słownik grup, liczba, namespace), więc nie
 * wymagają dodatkowego escapowania.
 */
function buildOrderAnalyticsBridgeCode_(config) {
  const cfg = config || getOrderAnalyticsConfig_();
  const allowed = [];
  cfg.services.forEach(s => allowed.push([s.field, ORDER_FIELD_TYPES.service]));
  allowed.push([cfg.from, ORDER_FIELD_TYPES.address]);
  allowed.push([cfg.to, ORDER_FIELD_TYPES.address]);
  if (cfg.source) allowed.push([cfg.source, ORDER_FIELD_TYPES.source]);

  return [
    "add_action( 'rest_api_init', function () {",
    "\tregister_rest_route( '" + cfg.namespace + "/v1', '/" + ORDER_ANALYTICS_ENDPOINT + "', array(",
    "\t\t'methods' => 'GET',",
    "\t\t'permission_callback' => function () { return current_user_can( 'manage_options' ); },",
    "\t\t'callback' => function ( WP_REST_Request $request ) {",
    "\t\t\tif ( ! class_exists( 'Forminator_API' ) ) {",
    "\t\t\t\treturn new WP_Error( 'forminator_unavailable', 'Forminator API is unavailable.', array( 'status' => 503 ) );",
    "\t\t\t}",
    "\t\t\t$form_id = " + cfg.formId + ";",
    "\t\t\t// Mapping fixed at prepare time. Every field type is checked on every call (fail-closed).",
    "\t\t\t$services = array(",
    cfg.services.map(s => "\t\t\t\tarray( '" + s.field + "', '" + s.group + "' ),").join('\n'),
    "\t\t\t);",
    "\t\t\t$addresses = array( 'from' => '" + cfg.from + "', 'to' => '" + cfg.to + "' );",
    "\t\t\t$source_field = '" + cfg.source + "';",
    "\t\t\t$allowed = array(",
    allowed.map(a => "\t\t\t\t'" + a[0] + "' => " + orderPhpList_(a[1]) + ',').join('\n'),
    "\t\t\t);",
    "",
    "\t\t\t$schema = Forminator_API::get_form_fields( $form_id );",
    "\t\t\tif ( is_wp_error( $schema ) ) { return $schema; }",
    "\t\t\t// Choices are compared after the normalization Forminator applies to them (entities, tags, whitespace).",
    "\t\t\t$normalize = function ( $text ) {",
    "\t\t\t\t$text = wp_strip_all_tags( html_entity_decode( (string) $text, ENT_QUOTES | ENT_HTML5, 'UTF-8' ) );",
    "\t\t\t\treturn trim( (string) preg_replace( '/[\\s\\x{00A0}]+/u', ' ', $text ) );",
    "\t\t\t};",
    "\t\t\t// Variant = option label up to the first dash: 'Ekspres – do 90 min' -> 'Ekspres'.",
    "\t\t\t$variant_of = function ( $label ) use ( $normalize ) {",
    "\t\t\t\t$parts = preg_split( '/\\s+[–-]\\s+/u', $normalize( $label ), 2 );",
    "\t\t\t\treturn is_array( $parts ) ? mb_substr( trim( $parts[0] ), 0, 40 ) : '';",
    "\t\t\t};",
    "\t\t\t$types = array();",
    "\t\t\t$labels = array();",
    "\t\t\t$by_value = array();",
    "\t\t\t$variants = array();",
    "\t\t\tforeach ( (array) $schema as $field ) {",
    "\t\t\t\t$data = array();",
    "\t\t\t\tif ( is_object( $field ) && method_exists( $field, 'to_array' ) ) {",
    "\t\t\t\t\t$data = (array) $field->to_array();",
    "\t\t\t\t} elseif ( is_object( $field ) ) {",
    "\t\t\t\t\t$vars = get_object_vars( $field );",
    "\t\t\t\t\t$data = isset( $vars['raw'] ) && is_array( $vars['raw'] ) ? $vars['raw'] : $vars;",
    "\t\t\t\t\tif ( isset( $vars['slug'] ) && ! isset( $data['element_id'] ) ) { $data['element_id'] = $vars['slug']; }",
    "\t\t\t\t} elseif ( is_array( $field ) ) {",
    "\t\t\t\t\t$data = $field;",
    "\t\t\t\t}",
    "\t\t\t\t$key = isset( $data['element_id'] ) ? (string) $data['element_id'] : '';",
    "\t\t\t\tif ( '' === $key ) { continue; }",
    "\t\t\t\t$types[ $key ] = isset( $data['type'] ) ? (string) $data['type'] : '';",
    "\t\t\t\t$labels[ $key ] = isset( $data['field_label'] ) ? sanitize_text_field( (string) $data['field_label'] ) : '';",
    "\t\t\t\t$by_value[ $key ] = array();",
    "\t\t\t\t$variants[ $key ] = array();",
    "\t\t\t\tif ( isset( $data['options'] ) && is_array( $data['options'] ) ) {",
    "\t\t\t\t\tforeach ( $data['options'] as $option ) {",
    "\t\t\t\t\t\tif ( ! is_array( $option ) ) { continue; }",
    "\t\t\t\t\t\t$variant = $variant_of( isset( $option['label'] ) ? $option['label'] : '' );",
    "\t\t\t\t\t\tif ( '' === $variant ) { continue; }",
    "\t\t\t\t\t\t$variants[ $key ][ $variant ] = $variant;",
    "\t\t\t\t\t\t$option_value = isset( $option['value'] ) && is_scalar( $option['value'] ) ? $normalize( $option['value'] ) : '';",
    "\t\t\t\t\t\tif ( '' !== $option_value ) { $by_value[ $key ][ $option_value ] = $variant; }",
    "\t\t\t\t\t}",
    "\t\t\t\t}",
    "\t\t\t}",
    "\t\t\t$groups = array();",
    "\t\t\tforeach ( $services as $pair ) { $groups[ $pair[0] ] = $pair[1]; }",
    "\t\t\t$mapping = array();",
    "\t\t\tforeach ( $allowed as $key => $accepted ) {",
    "\t\t\t\t$type = isset( $types[ $key ] ) ? $types[ $key ] : '';",
    "\t\t\t\tif ( ! in_array( $type, $accepted, true ) ) {",
    "\t\t\t\t\treturn new WP_Error( 'order_analytics_mapping', 'Mapped field ' . $key . ' has type \"' . $type . '\"; allowed: ' . implode( ', ', $accepted ) . '.', array( 'status' => 409 ) );",
    "\t\t\t\t}",
    "\t\t\t\t$mapping[] = array( 'field' => $key, 'group' => isset( $groups[ $key ] ) ? $groups[ $key ] : '', 'type' => $type, 'label' => $labels[ $key ] );",
    "\t\t\t}",
    "",
    "\t\t\t// Audit mode: the mapping only, returned before any submission is read.",
    "\t\t\tif ( $request->get_param( 'mapping_only' ) ) {",
    "\t\t\t\treturn rest_ensure_response( array( 'form_id' => $form_id, 'mapping' => $mapping ) );",
    "\t\t\t}",
    "",
    "\t\t\t$per_page = absint( $request->get_param( 'per_page' ) );",
    "\t\t\tif ( $per_page < 1 ) { $per_page = 100; }",
    "\t\t\t$per_page = min( 100, $per_page );",
    "\t\t\t$page = max( 1, absint( $request->get_param( 'page' ) ) );",
    "",
    "\t\t\t$count = Forminator_API::count_entries( $form_id );",
    "\t\t\tif ( is_wp_error( $count ) ) { return $count; }",
    "\t\t\t$entries = Forminator_API::get_entries( $form_id, $per_page, $page );",
    "\t\t\tif ( is_wp_error( $entries ) ) { return $entries; }",
    "\t\t\tif ( ! is_array( $entries ) ) { $entries = $entries ? array( $entries ) : array(); }",
    "",
    "\t\t\t$items = array();",
    "\t\t\tforeach ( $entries as $entry ) {",
    "\t\t\t\tif ( ! is_object( $entry ) || empty( $entry->entry_id ) ) { continue; }",
    "\t\t\t\t$meta = isset( $entry->meta_data ) && is_array( $entry->meta_data ) ? $entry->meta_data : array();",
    "\t\t\t\t// Forminator saves the option LABEL under the field key and the submitted value in _forminator_choice_values.",
    "\t\t\t\t$choices = isset( $meta['_forminator_choice_values']['value'] ) && is_array( $meta['_forminator_choice_values']['value'] ) ? $meta['_forminator_choice_values']['value'] : array();",
    "",
    "\t\t\t\t$service = '';",
    "\t\t\t\t$service_option = '';",
    "\t\t\t\tforeach ( $services as $pair ) {",
    "\t\t\t\t\t$raw = isset( $meta[ $pair[0] ]['value'] ) ? $meta[ $pair[0] ]['value'] : '';",
    "\t\t\t\t\tif ( is_array( $raw ) ) { $raw = reset( $raw ); }",
    "\t\t\t\t\t$raw = is_scalar( $raw ) ? trim( (string) $raw ) : '';",
    "\t\t\t\t\tif ( '' === $raw ) { continue; }",
    "\t\t\t\t\t$service = $pair[1];",
    "\t\t\t\t\t// The variant is always one of the current options: by submitted value, then by label (older entries, renamed option details).",
    "\t\t\t\t\t$candidates = array( $raw );",
    "\t\t\t\t\tif ( isset( $choices[ $pair[0] ] ) && is_scalar( $choices[ $pair[0] ] ) ) { array_unshift( $candidates, (string) $choices[ $pair[0] ] ); }",
    "\t\t\t\t\tforeach ( $candidates as $candidate ) {",
    "\t\t\t\t\t\t$candidate = $normalize( $candidate );",
    "\t\t\t\t\t\tif ( isset( $by_value[ $pair[0] ][ $candidate ] ) ) { $service_option = $by_value[ $pair[0] ][ $candidate ]; break; }",
    "\t\t\t\t\t\t$variant = $variant_of( $candidate );",
    "\t\t\t\t\t\tif ( isset( $variants[ $pair[0] ][ $variant ] ) ) { $service_option = $variant; break; }",
    "\t\t\t\t\t}",
    "\t\t\t\t\tbreak;",
    "\t\t\t\t}",
    "",
    "\t\t\t\t$place = array();",
    "\t\t\t\tforeach ( $addresses as $side => $key ) {",
    "\t\t\t\t\t$address = isset( $meta[ $key ]['value'] ) && is_array( $meta[ $key ]['value'] ) ? $meta[ $key ]['value'] : array();",
    "\t\t\t\t\t$city = isset( $address['city'] ) && is_scalar( $address['city'] ) ? trim( preg_replace( '/\\s+/u', ' ', (string) $address['city'] ) ) : '';",
    "\t\t\t\t\tif ( mb_strlen( $city ) > 40 || ! preg_match( '/^\\p{L}+(?:[ -]\\p{L}+)*$/u', $city ) ) { $city = ''; }",
    "\t\t\t\t\t$zip = isset( $address['zip'] ) && is_scalar( $address['zip'] ) ? trim( (string) $address['zip'] ) : '';",
    "\t\t\t\t\t$place[ $side . '_city' ] = $city;",
    "\t\t\t\t\t$place[ $side . '_region' ] = preg_match( '/^(\\d{2})-?\\d{3}$/', $zip, $zip_match ) ? $zip_match[1] : '';",
    "\t\t\t\t}",
    "",
    "\t\t\t\t$source_page = '';",
    "\t\t\t\tif ( '' !== $source_field ) {",
    "\t\t\t\t\t$src = isset( $meta[ $source_field ]['value'] ) && is_scalar( $meta[ $source_field ]['value'] ) ? trim( (string) $meta[ $source_field ]['value'] ) : '';",
    "\t\t\t\t\t$path = '';",
    "\t\t\t\t\tif ( preg_match( '#^https?://#i', $src ) ) {",
    "\t\t\t\t\t\t$path = (string) wp_parse_url( $src, PHP_URL_PATH );",
    "\t\t\t\t\t} elseif ( 0 === strpos( $src, '/' ) ) {",
    "\t\t\t\t\t\t$path = (string) strtok( $src, '?#' );",
    "\t\t\t\t\t}",
    "\t\t\t\t\t$source_page = preg_match( '#^/[A-Za-z0-9/._~%-]{0,199}$#', $path ) ? $path : '';",
    "\t\t\t\t}",
    "",
    "\t\t\t\t// time_created is a display string ('M j, Y @ g:i A', localized); the raw DB value is date_created_sql.",
    "\t\t\t\t$created = isset( $entry->date_created_sql ) ? (string) $entry->date_created_sql : '';",
    "\t\t\t\t$items[] = array(",
    "\t\t\t\t\t'entry_id' => absint( $entry->entry_id ),",
    "\t\t\t\t\t'date' => preg_match( '/^(\\d{4}-\\d{2}-\\d{2})/', $created, $date_match ) ? $date_match[1] : '',",
    "\t\t\t\t\t'service' => $service,",
    "\t\t\t\t\t'service_option' => $service_option,",
    "\t\t\t\t\t'from_city' => $place['from_city'],",
    "\t\t\t\t\t'from_region' => $place['from_region'],",
    "\t\t\t\t\t'to_city' => $place['to_city'],",
    "\t\t\t\t\t'to_region' => $place['to_region'],",
    "\t\t\t\t\t'source_page' => $source_page,",
    "\t\t\t\t);",
    "\t\t\t}",
    "",
    "\t\t\treturn rest_ensure_response( array(",
    "\t\t\t\t'form_id' => $form_id,",
    "\t\t\t\t'count' => absint( $count ),",
    "\t\t\t\t'page' => $page,",
    "\t\t\t\t'per_page' => $per_page,",
    "\t\t\t\t'mapping' => $mapping,",
    "\t\t\t\t'entries' => $items,",
    "\t\t\t) );",
    "\t\t},",
    "\t) );",
    "} );"
  ].join('\n');
}

// --- Zapis snippetu: ta sama ścieżka zatwierdzania co most historii B2B -----

/** Jednorazowa zgoda na zapis z edytora; zużywa ją następna operacja zapisu. */
function armOrderAnalyticsWrite() {
  requireWpWrite_({ confirm: 'YES' });
  PropertiesService.getScriptProperties().setProperty(ORDER_ANALYTICS_WRITE_APPROVAL_PROP, 'YES');
  return { armed: true };
}

function requireOrderAnalyticsWriteApproval_(title, message) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(ORDER_ANALYTICS_WRITE_APPROVAL_PROP) === 'YES') {
    props.deleteProperty(ORDER_ANALYTICS_WRITE_APPROVAL_PROP);
    requireWpWrite_({ confirm: 'YES' });
    return true;
  }
  let ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch {
    throw new Error('Zlecenia: brak kontekstu UI. Najpierw uruchom armOrderAnalyticsWrite(), a potem ponów operację.');
  }
  const answer = ui.alert(title, message, ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return false;
  requireWpWrite_({ confirm: 'YES' });
  return true;
}

function showOrderAnalyticsMessage_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch {
    Logger.log(message);
  }
}

function getOrderAnalyticsCandidates_(snippets) {
  return snippets.filter(snippet => {
    const tags = Array.isArray(snippet.tags) ? snippet.tags : [];
    return tags.includes(ORDER_ANALYTICS_TAG) || String(snippet.name || '') === ORDER_ANALYTICS_NAME;
  });
}

function validateOrderAnalyticsSnippet_(snippet, expectedCode) {
  if (!snippet || !/^\d+$/.test(String(snippet.id || ''))) throw new Error('Zlecenia: snippet nie ma prawidłowego ID.');
  if (String(snippet.code || '') !== expectedCode) throw new Error('Zlecenia: kod snippetu różni się od oczekiwanego.');
  if (String(snippet.scope || '') !== 'global') throw new Error('Zlecenia: snippet ma nieprawidłowy scope.');
  if (snippet.code_error) throw new Error('Zlecenia: Code Snippets zgłasza błąd kodu.');
  return snippet;
}

/**
 * Nowy kod dla NIEAKTYWNEGO zarządzanego snippetu: migawka poprzedniego stanu,
 * jedno żądanie zapisu, świeży odczyt. Snippet zostaje nieaktywny.
 */
function updateInactiveOrderSnippetCode_(snippet, code) {
  saveCodeSnippetSnapshot_(snippet, 'ORDER-ANALYTICS-UPDATE');
  const response = wpFetch_(
    CODE_SNIPPETS_REST_BASE + '/' + encodeURIComponent(snippet.id),
    { method: 'post', payload: { code: code, active: false } }
  );
  if (response.code < 200 || response.code >= 300) throw wpError_(response.code, response.text);
  return getCodeSnippetRaw_(snippet.id);
}

function getOrderAnalyticsSnippetId_() {
  const id = PropertiesService.getScriptProperties().getProperty(ORDER_ANALYTICS_SNIPPET_ID_PROP);
  if (!/^\d+$/.test(String(id || ''))) {
    throw new Error('Zlecenia: brak zapisanego ID snippetu. Najpierw uruchom prepareOrderAnalyticsBridge().');
  }
  return Number(id);
}

/**
 * Tworzy NIEAKTYWNY snippet albo aktualizuje kod nieaktywnego, który skrypt sam
 * przygotował. Konfiguracja spoza allowlisty typów, obcy snippet o tej nazwie,
 * kod zmieniony poza skryptem i aktywny snippet z innym kodem to odmowa — zanim
 * ktokolwiek zostanie poproszony o zgodę i zanim cokolwiek trafi do WordPressa.
 */
function prepareOrderAnalyticsBridge() {
  return withScriptLock_('przygotowanie mostu zleceń', () => {
    const expectedCode = buildOrderAnalyticsBridgeCode_();
    const candidates = getOrderAnalyticsCandidates_(getCodeSnippetsList_());
    if (candidates.length > 1) throw new Error('Zlecenia: znaleziono więcej niż jeden zarządzany snippet.');
    const existing = candidates.length === 1 ? getCodeSnippetRaw_(candidates[0].id) : null;
    const replace = Boolean(existing) && String(existing.code || '') !== expectedCode;
    // Najpierw własność: rada „rollback, potem prepare” ma sens tylko dla naszego
    // kodu. Przy kodzie zmienionym ręcznie rollback wyłączyłby endpoint, a prepare
    // i tak odmówiłby nadpisania — bez drogi naprawy (uwaga Codexa w #205).
    if (replace) requireOwnOrderSnippet_(existing);
    if (existing && existing.active) {
      throw new Error(replace
        ? 'Zlecenia: aktywny snippet ma inny kod niż wynika z Script Properties. ' +
          'Najpierw rollbackOrderAnalyticsBridge(), potem prepareOrderAnalyticsBridge().'
        : 'Zlecenia: snippet jest już aktywny. Użyj audytu.');
    }

    if (!requireOrderAnalyticsWriteApproval_(
      'Przygotować most zleceń do analityki?',
      (replace
        ? 'Kod NIEAKTYWNEGO snippetu #' + existing.id + ' zostanie zastąpiony kodem z bieżącego mapowania ' +
          '(migawka poprzedniego trafi do WP SNAPSHOTS). '
        : 'Zostanie utworzony wyłącznie NIEAKTYWNY, uwierzytelniony endpoint tylko do odczytu. ') +
      'Endpoint wydaje datę, usługę, miejscowości, regiony z dwóch cyfr kodu i ścieżkę strony wysłania. Bez danych kontaktowych.'
    )) {
      return { cancelled: true };
    }

    let snippet;
    let created = false;
    if (existing) {
      snippet = replace ? updateInactiveOrderSnippetCode_(existing, expectedCode) : existing;
    } else {
      snippet = createInactiveCodeSnippet_({
        name: ORDER_ANALYTICS_NAME,
        desc: 'Authenticated read-only order analytics endpoint: allowlisted, minimized fields only.',
        code: expectedCode,
        scope: 'global',
        priority: 10,
        tags: [ORDER_ANALYTICS_TAG]
      });
      created = true;
      if (!/^\d+$/.test(String(snippet.id || ''))) throw new Error('Zlecenia: Code Snippets nie zwrócił ID nowego snippetu.');
      snippet = getCodeSnippetRaw_(snippet.id);
    }
    snippet = validateOrderAnalyticsSnippet_(snippet, expectedCode);
    if (snippet.active) throw new Error('Zlecenia: snippet jest już aktywny. Użyj audytu.');

    const props = PropertiesService.getScriptProperties();
    props.setProperty(ORDER_ANALYTICS_SNIPPET_ID_PROP, String(snippet.id));
    // Skrót wdrożonego kodu: tylko snippet z dokładnie tym kodem wolno później nadpisać.
    props.setProperty(ORDER_ANALYTICS_CODE_DIGEST_PROP, contentDigest_(expectedCode));
    const saved = saveCodeSnippetResult_(snippet, 'ORDER-ANALYTICS-PREPARE');
    showOrderAnalyticsMessage_(
      'Most zleceń przygotowany' + (replace ? ' (kod zaktualizowany)' : '') + '.\n\nSnippet ID: ' + snippet.id +
      '\nStan: NIEAKTYWNY\n\nNastępny krok: activateOrderAnalyticsBridge(), potem auditOrderAnalyticsBridge().'
    );
    return { snippetId: Number(snippet.id), created: created, replaced: replace, active: false, resultRef: saved.resultRef };
  });
}

/**
 * Nadpisać wolno wyłącznie snippet przygotowany przez skrypt: o zapisanym ID
 * i z kodem dokładnie takim, jaki skrypt ostatnio wdrożył (skrót). Snippet o tej
 * samej nazwie albo kod poprawiony ręcznie w WordPressie zostają nietknięte.
 */
function requireOwnOrderSnippet_(snippet) {
  const props = PropertiesService.getScriptProperties();
  const recordedId = String(props.getProperty(ORDER_ANALYTICS_SNIPPET_ID_PROP) || '');
  const recordedDigest = String(props.getProperty(ORDER_ANALYTICS_CODE_DIGEST_PROP) || '');
  if (recordedId !== String(snippet.id) || !recordedDigest || recordedDigest !== contentDigest_(String(snippet.code || ''))) {
    throw new Error(
      'Zlecenia: snippet #' + snippet.id + ' ma inny kod i nie jest ostatnią wersją przygotowaną przez skrypt ' +
      '(inne ID albo kod zmieniony poza skryptem). Nie nadpisuję go; sprawdź go w WordPressie.'
    );
  }
}

/**
 * Audyt: zgodność kodu, a przy aktywnym moście także mapowanie pól (klucz, typ,
 * etykieta) odczytane ze schematu formularza — bez żadnych wartości zgłoszeń.
 */
function auditOrderAnalyticsBridge() {
  return withScriptLock_('audyt mostu zleceń', () => {
    const snippet = validateOrderAnalyticsSnippet_(getCodeSnippetRaw_(getOrderAnalyticsSnippetId_()), buildOrderAnalyticsBridgeCode_());
    const state = { snippetId: Number(snippet.id), active: Boolean(snippet.active), codeMatches: true, mapping: [] };
    if (state.active) state.mapping = fetchOrderAnalyticsMapping_();
    showOrderAnalyticsMessage_(
      'Audyt mostu zleceń\n\nSnippet ID: ' + state.snippetId + '\nStan: ' + (state.active ? 'AKTYWNY' : 'nieaktywny') +
      '\nKod zgodny: TAK' +
      (state.active ? '\n\nMapowanie pól (klucz, typ, etykieta):\n' + orderMappingText_(state.mapping) : '')
    );
    return state;
  });
}

function activateOrderAnalyticsBridge() {
  return withScriptLock_('aktywacja mostu zleceń', () => {
    const expectedCode = buildOrderAnalyticsBridgeCode_();
    if (!requireOrderAnalyticsWriteApproval_(
      'Aktywować most zleceń do analityki?',
      'Endpoint będzie dostępny wyłącznie dla uwierzytelnionego administratora i zwróci tylko pola z allowlisty.'
    )) {
      return { cancelled: true };
    }
    let snippet = validateOrderAnalyticsSnippet_(getCodeSnippetRaw_(getOrderAnalyticsSnippetId_()), expectedCode);
    if (snippet.active) return { snippetId: Number(snippet.id), active: true, alreadyActive: true };

    saveCodeSnippetSnapshot_(snippet, 'ORDER-ANALYTICS-ACTIVATE');
    setCodeSnippetActive_(snippet.id, true);
    snippet = validateOrderAnalyticsSnippet_(getCodeSnippetRaw_(snippet.id), expectedCode);
    if (!snippet.active) throw new Error('Zlecenia: snippet pozostał nieaktywny po aktywacji.');
    showOrderAnalyticsMessage_('Most zleceń aktywny.\n\nSnippet ID: ' + snippet.id + '\nNastępny krok: auditOrderAnalyticsBridge().');
    return { snippetId: Number(snippet.id), active: true };
  });
}

function rollbackOrderAnalyticsBridge() {
  return withScriptLock_('rollback mostu zleceń', () => {
    if (!requireOrderAnalyticsWriteApproval_(
      'Wyłączyć most zleceń do analityki?',
      'Zapisany snippet zostanie zdezaktywowany po ID. Dane już zapisane w arkuszu pozostaną bez zmian.'
    )) {
      return { cancelled: true };
    }
    const id = getOrderAnalyticsSnippetId_();
    let snippet = getCodeSnippetRaw_(id);
    saveCodeSnippetSnapshot_(snippet, 'ORDER-ANALYTICS-ROLLBACK');
    if (snippet.active) setCodeSnippetActive_(id, false);
    snippet = getCodeSnippetRaw_(id);
    if (snippet.active) throw new Error('Zlecenia: rollback nie wyłączył snippetu.');
    return { snippetId: id, active: false };
  });
}

// --- Odczyt i import ----------------------------------------------------------

function orderMappingText_(mapping) {
  return mapping.map(m => '- ' + m.field + (m.group ? ' → ' + m.group : '') + ' (' + m.type + ')' + (m.label ? ': ' + m.label : '')).join('\n') || '- brak';
}

/** Data `RRRR-MM-DD`, która istnieje w kalendarzu; inaczej pusty tekst. */
function orderCalendarDate_(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return '';
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const real = day.getUTCFullYear() === Number(m[1]) && day.getUTCMonth() === Number(m[2]) - 1 && day.getUTCDate() === Number(m[3]);
  return real ? text : '';
}

/** `RRRR-MM-DD` przesunięte o `months` miesięcy, z przycięciem dnia do długości miesiąca. */
function orderShiftMonths_(day, months) {
  const parts = day.split('-').map(Number);
  const index = parts[0] * 12 + (parts[1] - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = n => (n < 10 ? '0' : '') + n;
  return year + '-' + pad(month) + '-' + pad(Math.min(parts[2], last));
}

/** `RRRR-MM-DD` przesunięte o `days` dni. */
function orderShiftDays_(day, days) {
  const parts = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
  return shifted.toISOString().slice(0, 10);
}

function orderCity_(value) {
  const city = String(value === null || value === undefined ? '' : value).trim().replace(/\s+/g, ' ');
  return city.length <= 40 && ORDER_CITY_PATTERN.test(city) ? city : '';
}

/**
 * Wpis z odpowiedzi po kontroli allowlisty. Klucz spoza niej przerywa import:
 * znaczyłby, że snippet w WordPressie wydaje coś, czego kontrakt nie przewiduje.
 * Wartość o złym kształcie staje się pustą komórką — to druga, niezależna warstwa
 * tej samej minimalizacji, którą robi PHP.
 */
function orderAnalyticsEntry_(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('Zlecenia: wpis odpowiedzi nie jest obiektem.');
  const extra = Object.keys(entry).filter(k => ORDER_ANALYTICS_KEYS.indexOf(k) < 0);
  if (extra.length) {
    throw new Error('Zlecenia: endpoint zwrócił pola spoza allowlisty (' + extra.join(', ') + '). Import przerwany, zakładka bez zmian.');
  }
  if (!/^\d+$/.test(String(entry.entry_id || ''))) throw new Error('Zlecenia: wpis bez prawidłowego entry_id.');
  const text = v => String(v === null || v === undefined ? '' : v).trim();
  const shaped = (v, re) => (re.test(text(v)) ? text(v) : '');
  return {
    entryId: Number(entry.entry_id),
    date: orderCalendarDate_(entry.date),
    service: ORDER_SERVICE_GROUPS.indexOf(text(entry.service)) >= 0 ? text(entry.service) : '',
    // Etykieta opcji to jedyny wolny tekst spoza słownika i spoza wzorca: początek
    // `=`, `+`, `-` albo `@` Arkusze wzięłyby za formułę (uwaga Codexa w #205).
    serviceOption: /^[=+\-@]/.test(text(entry.service_option)) ? '' : text(entry.service_option).slice(0, 40),
    fromCity: orderCity_(entry.from_city),
    fromRegion: shaped(entry.from_region, /^\d{2}$/),
    toCity: orderCity_(entry.to_city),
    toRegion: shaped(entry.to_region, /^\d{2}$/),
    sourcePage: shaped(entry.source_page, ORDER_PATH_PATTERN)
  };
}

/** Pola w kolejności, w jakiej wydaje je most: usługi (z grupą), adres nadania, adres doręczenia, strona. */
function orderExpectedMapping_(config) {
  return config.services.map(s => s.field + ':' + s.group)
    .concat([config.from, config.to])
    .concat(config.source ? [config.source] : []);
}

function orderMappingFrom_(payload) {
  return (Array.isArray(payload.mapping) ? payload.mapping : []).map(m => ({
    field: String((m && m.field) || ''),
    group: String((m && m.group) || ''),
    type: String((m && m.type) || ''),
    label: String((m && m.label) || '').slice(0, 80)
  }));
}

/**
 * Samo mapowanie pól (klucz, typ, etykieta) w trybie `mapping_only`: PHP zwraca je
 * przed odczytem jakiegokolwiek zgłoszenia, więc audyt nie przenosi wartości zgłoszeń
 * i nie zależy od ich poprawności.
 */
function fetchOrderAnalyticsMapping_() {
  const config = getOrderAnalyticsConfig_();
  const response = wpFetch_(wpBridgePath_(ORDER_ANALYTICS_ENDPOINT) + '?mapping_only=1');
  if (response.code < 200 || response.code >= 300) {
    throw new Error('Zlecenia: endpoint HTTP ' + response.code + ': ' + String(response.text || '').slice(0, 500));
  }
  const payload = response.json || {};
  if (Number(payload.form_id) !== config.formId || !Array.isArray(payload.mapping) || payload.entries !== undefined) {
    throw new Error('Zlecenia: nieprawidłowa odpowiedź endpointu w trybie mapowania.');
  }
  return orderMappingFrom_(payload);
}

function fetchOrderAnalyticsPage_(page, perPage) {
  const config = getOrderAnalyticsConfig_();
  const pageNumber = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(perPage) || 100));
  const response = wpFetch_(
    wpBridgePath_(ORDER_ANALYTICS_ENDPOINT) + '?page=' + encodeURIComponent(pageNumber) + '&per_page=' + encodeURIComponent(pageSize)
  );
  if (response.code < 200 || response.code >= 300) {
    throw new Error('Zlecenia: endpoint HTTP ' + response.code + ': ' + String(response.text || '').slice(0, 500));
  }
  const payload = response.json || {};
  if (Number(payload.form_id) !== config.formId || !Number.isInteger(Number(payload.count)) || !Array.isArray(payload.entries)) {
    throw new Error('Zlecenia: nieprawidłowa odpowiedź endpointu.');
  }
  const mapping = orderMappingFrom_(payload);
  const expected = orderExpectedMapping_(config);
  const actual = mapping.map(m => m.field + (m.group ? ':' + m.group : ''));
  if (actual.join(', ') !== expected.join(', ')) {
    // Snippet sprzed zmiany Script Properties czyta stare pola; pełna synchronizacja
    // przepisałaby zakładkę po cichu źle zaklasyfikowanymi zleceniami.
    throw new Error(
      'Zlecenia: most w WordPressie czyta inne pola (' + actual.join(', ') + ') niż wskazują Script Properties (' +
      expected.join(', ') + '). Kolejno: rollbackOrderAnalyticsBridge(), prepareOrderAnalyticsBridge() (zaktualizuje kod ' +
      'nieaktywnego snippetu) i activateOrderAnalyticsBridge(). Zakładka bez zmian.'
    );
  }
  return { count: Number(payload.count), mapping: mapping, entries: payload.entries.map(orderAnalyticsEntry_) };
}

/** Wszystkie zgłoszenia; liczba musi się zgadzać, inaczej pełna synchronizacja skasowałaby wiersze. */
function readAllOrderAnalytics_() {
  const perPage = 100;
  const first = fetchOrderAnalyticsPage_(1, perPage);
  if (first.count > ORDER_ANALYTICS_MAX_ENTRIES) {
    throw new Error('Zlecenia: liczba zgłoszeń przekracza limit bezpieczeństwa ' + ORDER_ANALYTICS_MAX_ENTRIES + '.');
  }
  const byId = new Map();
  first.entries.forEach(entry => byId.set(entry.entryId, entry));
  const totalPages = Math.max(1, Math.ceil(first.count / perPage));
  for (let page = 2; page <= totalPages; page += 1) {
    const current = fetchOrderAnalyticsPage_(page, perPage);
    if (current.count !== first.count) throw new Error('Zlecenia: liczba zgłoszeń zmieniła się w trakcie importu. Spróbuj ponownie.');
    current.entries.forEach(entry => byId.set(entry.entryId, entry));
  }
  const entries = Array.from(byId.values()).sort((a, b) => a.entryId - b.entryId);
  if (entries.length !== first.count) {
    throw new Error('Zlecenia: oczekiwano ' + first.count + ' unikalnych zgłoszeń, pobrano ' + entries.length + '. Zakładka bez zmian.');
  }
  return { entries: entries, mapping: first.mapping };
}

/** Pierwszy dzień poza retencją jako `RRRR-MM-DD`: wiersze wcześniejsze nie trafiają do zakładki. */
function orderRetentionCutoff_(now) {
  return orderShiftMonths_(orderToday_(now), -ORDER_ANALYTICS_RETENTION_MONTHS);
}

/**
 * Dzień importu w strefie ARKUSZA, liczony jednym formatowaniem. Składowe daty
 * z `new Date()` są w strefie skryptu, a ta bywa inna — granica retencji
 * przesunęłaby się wtedy o dobę (uwaga Codexa w #205).
 */
function orderToday_(now) {
  return Utilities.formatDate(now, performanceTimeZone_(), 'yyyy-MM-dd');
}

/**
 * Pełna synchronizacja: zakładka odzwierciedla bieżące zgłoszenia w WordPressie
 * w granicach retencji. Zgłoszenie usunięte w WordPressie (np. na żądanie klienta)
 * znika z zakładki przy następnym imporcie, a ponowny import niczego nie dubluje.
 */
function importOrderAnalytics_(now) {
  const at = now || new Date();
  const read = readAllOrderAnalytics_();
  const cutoff = orderRetentionCutoff_(at);
  // Jeden dzień zapasu na różnicę strefy WordPressa i arkusza: zgłoszenie z dziś
  // w Warszawie bywa „jutrem” dla arkusza w innej strefie.
  const latest = orderShiftDays_(orderToday_(at), 1);
  let expired = 0;
  let undated = 0;
  let withService = 0;
  let withoutVariant = 0;
  const rows = [];
  read.entries.forEach(e => {
    // Bez prawdziwej daty nie da się ustalić wieku zgłoszenia, a data z przyszłości
    // omijałaby retencję latami: wiersz wracałby przy każdej synchronizacji.
    if (!e.date || e.date > latest) {
      undated++;
      return;
    }
    if (e.date < cutoff) {
      expired++;
      return;
    }
    if (e.service) {
      withService++;
      if (!e.serviceOption) withoutVariant++;
    }
    rows.push([e.entryId, e.date, e.service, e.serviceOption, e.fromCity, e.fromRegion, e.toCity, e.toRegion, e.sourcePage, at]);
  });

  const sheet = ensureSheetWithHeader_(ORDER_ANALYTICS_SHEET, ORDER_ANALYTICS_HEADER);
  const width = ORDER_ANALYTICS_HEADER.length;
  const lastRow = sheet.getLastRow();
  ensureSheetRows_(sheet, Math.max(rows.length, 1) + 1);
  // Region jako tekst: arkusz zamieniłby „05” na liczbę 5 i zgubił zero wiodące.
  [ORDER_ANALYTICS_HEADER.indexOf('Skąd (region)'), ORDER_ANALYTICS_HEADER.indexOf('Dokąd (region)')].forEach(i => {
    sheet.getRange(2, i + 1, Math.max(rows.length, 1), 1).setNumberFormat('@');
  });
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, width).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, width).setValues(rows);
  return {
    fetched: read.entries.length, written: rows.length, expired: expired, undated: undated,
    withService: withService, withoutVariant: withoutVariant, mapping: read.mapping
  };
}

/** Menu WordPress → Importuj zlecenia do analityki. */
function importujZleceniaAnalityka() {
  const result = withScriptLock_('import zleceń do analityki', () => importOrderAnalytics_());
  showOrderAnalyticsMessage_(
    'Zlecenia pobrane do „' + ORDER_ANALYTICS_SHEET + '”.\n\n' +
    'Zgłoszenia w WordPressie: ' + result.fetched + '\nW zakładce: ' + result.written +
    '\nPominięte jako starsze niż ' + ORDER_ANALYTICS_RETENTION_MONTHS + ' miesiące: ' + result.expired +
    '\nPominięte bez prawidłowej daty (brak, niemożliwa albo z przyszłości — retencja by ich nie objęła): ' + result.undated +
    // Wszystkie bez daty to objaw mostu, nie danych: 26.09 PHP czytało pole do
    // wyświetlania zamiast surowej daty i odrzuciło 334 z 334 zgłoszeń.
    (result.fetched > 0 && result.undated === result.fetched
      ? '\nUWAGA: żadne zgłoszenie nie ma prawidłowej daty — to wskazuje na błąd mostu, a nie na dane.'
      : '') +
    '\nWiersze z usługą bez rozpoznanego wariantu: ' + result.withoutVariant + ' z ' + result.withService +
    // Ten sam objaw mostu co brak dat: 26.09 PHP szukało etykiety po wartości opcji,
    // a Forminator zapisuje pod kluczem pola etykietę, więc wariant był pusty w 334 z 334.
    (result.withService > 0 && result.withoutVariant === result.withService
      ? '\nUWAGA: żaden wiersz z usługą nie ma rozpoznanego wariantu — to wskazuje na błąd mostu, a nie na dane.'
      : '') +
    '\n\nMapowanie pól (klucz, typ, etykieta):\n' + orderMappingText_(result.mapping) +
    '\n\nDo arkusza trafiają wyłącznie: data, usługa i jej wariant, miejscowości, regiony z dwóch cyfr kodu ' +
    'i ścieżka strony wysłania. Bez danych kontaktowych.'
  );
  return result;
}
