'use strict';

/**
 * #103: most seo-meta pod kontrolą wersji.
 *
 * Do tej pory istniał wyłącznie jako snippet w instalacji, więc nie dało się
 * ani przejrzeć jego kontraktu, ani zmienić nazwy pola. Te testy pilnują tego,
 * co musi się zgadzać z `WordPress.gs`, i higieny publicznego repozytorium.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const bridge = fs.readFileSync(path.resolve(__dirname, '..', 'wordpress', 'seo-meta-rest-bridge.php'), 'utf8');

test('#103: endpoint zapisu jest POST-em pod tym samym namespace co reszta', () => {
  assert.match(bridge, /register_rest_route\(\s*\n\t*\$namespace \. '\/v1',\s*\n\t*'\/seo-meta'/);
  assert.match(bridge, /'methods'\s*=>\s*'POST'/);
  assert.match(bridge, /'permission_callback'\s*=>\s*'wpa_seo_meta_can_write'/);
});

test('#103: zapis obejmuje wyłącznie tytuł i opis, nie dowolne post meta', () => {
  assert.match(bridge, /'rank_math_title'/);
  assert.match(bridge, /'rank_math_description'/);
  assert.match(bridge, /in_array\( \$field, wpa_seo_meta_fields\(\), true \)/);
  assert.doesNotMatch(bridge, /update_post_meta\( \$post_id, \$request->get_param/, 'pole musi przejść przez listę dozwolonych');
});

test('#103: pusta wartość usuwa meta, czyli wraca do szablonu Rank Matha', () => {
  assert.match(bridge, /if \( '' === \$value \) \{\s*\n\t*delete_post_meta\( \$post_id, \$field \);/);
});

test('#103: zapis jest potwierdzany odczytem kontrolnym po stronie WordPressa', () => {
  assert.match(bridge, /\$stored !== \$value/);
  assert.match(bridge, /wp_automation_seo_meta_verification_failed/);
});

test('#103: pole REST jest wystawione pod nazwą docelową i historyczną z jednej definicji', () => {
  assert.match(bridge, /register_rest_field\( 'page', 'wpa_rank_math', \$seo_field \);/);
  assert.match(bridge, /register_rest_field\( 'page', 'cc_rank_math', \$seo_field \);/);
  assert.equal(bridge.split('$seo_field = array(').length - 1, 1, 'jedna definicja, żeby nazwy się nie rozjechały');
});

test('#103: uprawnienia sprawdzają wejście, potem istnienie strony, potem prawo edycji', () => {
  const order = ['wp_automation_invalid_post_id', 'wp_automation_invalid_field', 'wp_automation_page_not_found', "current_user_can( 'edit_post'"];
  let at = -1;
  for (const marker of order) {
    const next = bridge.indexOf(marker);
    assert.ok(next > at, 'kolejność sprawdzeń: ' + marker);
    at = next;
  }
});

test('#103: brak tożsamości witryny w publicznym repozytorium', () => {
  assert.doesNotMatch(bridge, /citycouriers/i);
  assert.doesNotMatch(bridge, /\bcc_rank_math_[a-z]/, 'poza jawnym aliasem nie ma innych nazw z prefiksem cc_');
});
