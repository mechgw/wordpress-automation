'use strict';

/**
 * #286: stronicowanie importu GSC kończy się na pierwszej krótkiej stronie.
 * Mały plik, żeby mutanty pętli stronicowania ginęły tu, zanim dojdą do testów
 * z nieograniczonymi atrapami API (te przy takim mutancie nigdy by się nie skończyły).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./helpers/gas');

const CFG = 'Konfiguracja GSC';
const HEADER = ['date', 'query', 'page', 'country', 'device', 'clicks', 'impressions', 'ctr', 'position', 'downloaded'];
const WIERSZ = { keys: ['2026-10-01', 'f', '/s', 'pol', 'MOBILE'], clicks: 1, impressions: 10, ctr: 0.1, position: 3 };
const stage = () => {};

function projekt(rowLimit, fetch) {
  const rows = [['Klucz', 'Wartość'], ['siteUrl', 'https://www.example.pl/'], ['rowLimit', rowLimit], ['', ''], ['', ''], ['', ''], ['', ''], ['status', '']];
  return loadProject({ sheets: { [CFG]: rows, 'GSC RAW': { rows: [HEADER] } }, fetch });
}
function ograniczone(odpowiedz) {
  const stan = { n: 0 };
  const fetch = () => {
    if (++stan.n > 6) throw new Error('stronicowanie nie kończy się');
    return odpowiedz;
  };
  return { stan, fetch };
}

test('krótka strona kończy import po jednym zapytaniu, z limitem z konfiguracji', () => {
  const { stan, fetch } = ograniczone({ code: 200, json: { rows: [WIERSZ] } });
  const gas = projekt(100, fetch);

  assert.equal(gas.importRange_('2026-10-01', '2026-10-01', { stage }).rows, 1);
  assert.equal(stan.n, 1);
});

test('brak limitu w konfiguracji: domyślne 25000, jedna krótka strona kończy import', () => {
  const { stan, fetch } = ograniczone({ code: 200, json: { rows: [WIERSZ] } });
  const gas = projekt('', fetch);

  gas.importRange_('2026-10-01', '2026-10-01', { stage });

  assert.equal(stan.n, 1);
  assert.equal(JSON.parse(gas.$fetchCalls[0].params.payload).rowLimit, 25000);
});

test('odpowiedź bez pola rows kończy import po jednym zapytaniu', () => {
  const { stan, fetch } = ograniczone({ code: 200, json: {} });
  const gas = projekt(100, fetch);

  assert.equal(gas.importRange_('2026-10-01', '2026-10-01', { stage }).rows, 0);
  assert.equal(stan.n, 1);
});
