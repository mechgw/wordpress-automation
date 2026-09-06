'use strict';

/**
 * #104: stan i czas trwania flag zapisu są widoczne.
 *
 * WP_ALLOW_WRITES to jedyny wyłącznik chroniący produkcyjny WordPress, ale
 * zostaje włączony na stałe, bo tak wygodniej. Wyłącznik zawsze włączony nie
 * chroni przed niczym. WP_DRY_RUN daje problem odwrotny: zapomniany sprawia,
 * że komendy tylko udają zapis.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const daysAgo = d => new Date(Date.now() - d * 86400000).toISOString();
const state = gas => JSON.parse(gas.$properties.WRITE_FLAGS_SINCE || '{}');

describe('#104: obserwacja flag zapisu', () => {
  test('włączenie flagi zapisuje moment, a wyłączenie go kasuje', () => {
    const gas = loadProject({ properties: { WP_ALLOW_WRITES: 'TRUE' } });
    gas.observeWriteFlags_(new Date());
    assert.ok(state(gas).WP_ALLOW_WRITES, 'moment włączenia jest zapamiętany');
    assert.equal(state(gas).WP_DRY_RUN, undefined, 'wyłączona flaga nie ma znacznika');

    gas.$properties.WP_ALLOW_WRITES = 'FALSE';
    gas.observeWriteFlags_(new Date());
    assert.deepEqual(state(gas), {}, 'wyłączenie kasuje znacznik, więc ponowne włączenie liczy się od nowa');
  });

  test('kolejne obserwacje nie przesuwają momentu włączenia', () => {
    const gas = loadProject({ properties: { WP_ALLOW_WRITES: 'TRUE', WRITE_FLAGS_SINCE: JSON.stringify({ WP_ALLOW_WRITES: daysAgo(12) }) } });
    const before = state(gas).WP_ALLOW_WRITES;
    gas.observeWriteFlags_(new Date());
    assert.equal(state(gas).WP_ALLOW_WRITES, before, 'inaczej licznik dni nigdy nie ruszyłby z miejsca');
  });

  test('tylko literalne TRUE liczy się jako włączona, tak jak w getWpConfig_', () => {
    for (const value of ['true', 'yes', '1', 'TAK']) {
      const gas = loadProject({ properties: { WP_ALLOW_WRITES: value } });
      gas.observeWriteFlags_(new Date());
      assert.deepEqual(state(gas), {}, 'wartość „' + value + '” nie włącza zapisów');
    }
  });

  test('uszkodzony znacznik nie wywraca obserwacji', () => {
    const gas = loadProject({ properties: { WP_ALLOW_WRITES: 'TRUE', WRITE_FLAGS_SINCE: 'to nie jest JSON' } });
    gas.observeWriteFlags_(new Date());
    assert.ok(state(gas).WP_ALLOW_WRITES);
  });
});

describe('#104: opis stanu flag', () => {
  const linesFor = (properties, now) => plain(loadProject({ properties }).writeFlagsStatusLines_(now));

  test('wyłączone flagi są opisane krótko, bez straszenia', () => {
    const lines = linesFor({});
    assert.deepEqual(lines, [
      'Zapisy do WordPressa (WP_ALLOW_WRITES): wyłączone.',
      'Tryb próbny (WP_DRY_RUN): wyłączony.'
    ]);
  });

  test('krótko włączona flaga podaje czas bez ostrzeżenia', () => {
    const lines = linesFor({ WP_ALLOW_WRITES: 'TRUE', WRITE_FLAGS_SINCE: JSON.stringify({ WP_ALLOW_WRITES: daysAgo(2) }) });
    assert.equal(lines[0], 'Zapisy do WordPressa (WP_ALLOW_WRITES): WŁĄCZONE od 2 dni.');
    assert.doesNotMatch(lines[0], /UWAGA/);
  });

  test('po tygodniu dochodzi ostrzeżenie nazywające problem', () => {
    const lines = linesFor({ WP_ALLOW_WRITES: 'TRUE', WRITE_FLAGS_SINCE: JSON.stringify({ WP_ALLOW_WRITES: daysAgo(9) }) });
    assert.match(lines[0], /^Zapisy do WordPressa \(WP_ALLOW_WRITES\): WŁĄCZONE od 9 dni\./);
    assert.match(lines[0], /UWAGA: wyłącznik chroni tylko wtedy, gdy bywa wyłączany\.$/);
  });

  test('dokładnie na progu ostrzeżenie już jest, dzień wcześniej jeszcze nie', () => {
    const at = linesFor({ WP_ALLOW_WRITES: 'TRUE', WRITE_FLAGS_SINCE: JSON.stringify({ WP_ALLOW_WRITES: daysAgo(7) }) });
    const before = linesFor({ WP_ALLOW_WRITES: 'TRUE', WRITE_FLAGS_SINCE: JSON.stringify({ WP_ALLOW_WRITES: daysAgo(6) }) });
    assert.match(at[0], /UWAGA/);
    assert.doesNotMatch(before[0], /UWAGA/);
  });

  test('flaga włączona dzisiaj mówi „od dziś”, a nie „od 0 dni”', () => {
    const lines = linesFor({ WP_DRY_RUN: 'TRUE', WRITE_FLAGS_SINCE: JSON.stringify({ WP_DRY_RUN: new Date().toISOString() }) });
    assert.equal(lines[1], 'Tryb próbny (WP_DRY_RUN): WŁĄCZONY od dziś.');
  });

  test('flaga włączona przed pierwszą obserwacją nie zmyśla czasu', () => {
    const lines = linesFor({ WP_DRY_RUN: 'TRUE' });
    assert.equal(lines[1], 'Tryb próbny (WP_DRY_RUN): WŁĄCZONY, czas włączenia nieznany (pierwsza obserwacja).');
  });

  test('ostrzeżenie o trybie próbnym mówi o innym problemie niż o zapisach', () => {
    const lines = linesFor({ WP_DRY_RUN: 'TRUE', WRITE_FLAGS_SINCE: JSON.stringify({ WP_DRY_RUN: daysAgo(30) }) });
    assert.match(lines[1], /UWAGA: komendy tylko udają zapis\.$/);
  });
});

describe('#104: flagi są widoczne tam, gdzie użytkownik patrzy', () => {
  test('Status danych wypisuje obie flagi i przy okazji je obserwuje', () => {
    const gas = loadProject({
      properties: { WP_ALLOW_WRITES: 'TRUE' },
      sheets: { 'Konfiguracja GSC': [['k', 'v']], 'Konfiguracja GA4': [['k', 'v']] }
    });
    gas.showImportStatus();
    const text = gas.$alerts[0][0];
    assert.match(text, /Zapisy do WordPressa \(WP_ALLOW_WRITES\): WŁĄCZONE/);
    assert.match(text, /Tryb próbny \(WP_DRY_RUN\): wyłączony\./);
    assert.ok(state(gas).WP_ALLOW_WRITES, 'samo otwarcie okna odnotowuje stan');
  });

  test('codzienny strażnik odnotowuje stan flag bez wysyłania o nich maila', () => {
    const gas = loadProject({ properties: { WP_ALLOW_WRITES: 'TRUE', ALERT_EMAIL: 'alerty@example.pl' } });
    gas.sprawdzAktualnoscImportow();
    assert.ok(state(gas).WP_ALLOW_WRITES);
    for (const mail of gas.$mails) {
      assert.doesNotMatch(mail.body, /WP_ALLOW_WRITES/, 'strażnik służy awariom, nie przypomnieniom');
    }
  });
});
