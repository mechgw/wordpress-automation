'use strict';

// Wzorzec "tylko załadowanie": które linie src/*.gs wykonuje samo ładowanie projektu.
// Służy coverage-map.js do odróżnienia testów, które naprawdę wywołują kod danego pliku.
const { test } = require('node:test');
const { loadProject } = require('../../test/helpers/gas.js');

test('ładowanie projektu', () => {
  loadProject();
});
