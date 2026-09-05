'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bridgePath = path.join(__dirname, '..', 'wordpress', 'page-layout-rest-bridge.php');
const bridge = fs.readFileSync(bridgePath, 'utf8');

test('page-layout bridge exposes only the three GeneratePress layout meta keys required by #26', () => {
  const keys = [...bridge.matchAll(/'_generate-[^']+'/g)]
    .map(match => match[0].slice(1, -1))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();

  assert.deepEqual(keys, [
    '_generate-disable-headline',
    '_generate-full-width-content',
    '_generate-sidebar-layout-meta'
  ]);
});

test('page-layout bridge reuses the existing REST namespace instead of hardcoding a site identity', () => {
  assert.match(bridge, /WP_AUTOMATION_REST_NAMESPACE/);
  assert.match(bridge, /wp_automation_rest_namespace/);
  assert.match(bridge, /\/v1\/seo-meta/);
  assert.match(bridge, /register_rest_route\(/);
  assert.match(bridge, /'\/page-layout'/);
  assert.doesNotMatch(bridge, /citycouriers/i);
});

test('page-layout bridge requires edit permissions for reads and copies', () => {
  assert.match(bridge, /function wpa_page_layout_can_read/);
  assert.match(bridge, /current_user_can\( 'edit_post', \$post_id \)/);
  assert.match(bridge, /function wpa_page_layout_can_copy/);
  assert.match(bridge, /current_user_can\( 'edit_post', \$source_id \)/);
  assert.match(bridge, /current_user_can\( 'edit_post', \$target_id \)/);
  assert.doesNotMatch(bridge, /__return_true/);
});

test('layout copy mirrors missing meta and verifies the result after writing', () => {
  assert.match(bridge, /metadata_exists\( 'post', \$post_id, \$key \)/);
  assert.match(bridge, /update_post_meta\( \$target_id, \$key, \$source_meta\['value'\] \)/);
  assert.match(bridge, /delete_post_meta\( \$target_id, \$key \)/);
  assert.match(bridge, /\$source_layout !== \$after_layout/);
  assert.match(bridge, /wp_automation_layout_verification_failed/);
});
