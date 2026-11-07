'use strict';

/**
 * #275: funkcje znaczników wykonań w pełni zabijają mutanty Strykera.
 *
 * `RunMarkers.gs` (znaczniki przeniesione ze Status.gs plus adnotacja wyjątku) ma
 * zbiegłe mutanty z pilotażu #234: filtr prefiksu, granica wieku, sortowanie,
 * zwolnienie blokady, komunikaty logu, redakcja wiadomości. Testy wołają funkcje
 * wprost i sprawdzają dokładne wyniki.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const MIN = 60 * 1000;
const STALE = 7 * MIN;
const NOW = Date.parse('2026-10-20T10:00:00Z');
const projekt = () => loadProject({});
const znacznik = (gas, nazwa, job, wiekMs, extra = {}) => {
  gas.$properties[nazwa] = JSON.stringify(Object.assign({ job, runId: nazwa, startedAt: new Date(NOW - wiekMs).toISOString(), trigger: true }, extra));
};
const logger = gas => {
  const wpisy = [];
  gas.Logger = { log: m => wpisy.push(m) };
  return wpisy;
};
const nazwy = lista => plain(lista.map(f => f.name));
const wywolaniaBlokady = gas => plain(gas.$lock.filter(c => Array.isArray(c)));

describe('#275: abandonedRunMarkers_', () => {
  test('tylko właściwości z prefiksem RUNNING_; inne z podobną treścią są ignorowane', () => {
    const gas = projekt();
    znacznik(gas, 'RUNNING_GSC_a', 'GSC', 10 * MIN);
    znacznik(gas, 'INNA_WLASCIWOSC', 'GSC', 10 * MIN);
    znacznik(gas, 'XRUNNING_GSC_b', 'GSC', 10 * MIN);

    assert.deepEqual(nazwy(gas.abandonedRunMarkers_('GSC', NOW)), ['RUNNING_GSC_a']);
  });

  test('nieczytelna wartość i znacznik innego zadania nie są zwracane', () => {
    const gas = projekt();
    gas.$properties.RUNNING_GSC_zly = '{niepoprawny json';
    znacznik(gas, 'RUNNING_GA4_a', 'GA4', 10 * MIN);
    znacznik(gas, 'RUNNING_GSC_ok', 'GSC', 10 * MIN);

    assert.deepEqual(nazwy(gas.abandonedRunMarkers_('GSC', NOW)), ['RUNNING_GSC_ok']);
  });

  test('wiek: dokładnie 7 minut jeszcze żyje, 7 minut i milisekunda to porzucony', () => {
    const gas = projekt();
    znacznik(gas, 'RUNNING_GSC_granica', 'GSC', STALE);
    znacznik(gas, 'RUNNING_GSC_starszy', 'GSC', STALE + 1);

    assert.deepEqual(nazwy(gas.abandonedRunMarkers_('GSC', NOW)), ['RUNNING_GSC_starszy']);
  });

  test('od najstarszego, niezależnie od kolejności właściwości', () => {
    const gas = projekt();
    znacznik(gas, 'RUNNING_GSC_srodek', 'GSC', 20 * MIN);
    znacznik(gas, 'RUNNING_GSC_najnowszy', 'GSC', 10 * MIN);
    znacznik(gas, 'RUNNING_GSC_najstarszy', 'GSC', 30 * MIN);

    assert.deepEqual(nazwy(gas.abandonedRunMarkers_('GSC', NOW)), ['RUNNING_GSC_najstarszy', 'RUNNING_GSC_srodek', 'RUNNING_GSC_najnowszy']);
  });
});

describe('#275: reclaimAbandonedRuns_', () => {
  test('bez porzuconych znaczników nie bierze blokady', () => {
    const gas = projekt();
    znacznik(gas, 'RUNNING_GSC_zywy', 'GSC', MIN);

    assert.deepEqual(plain(gas.reclaimAbandonedRuns_('GSC', NOW)), []);
    assert.deepEqual(wywolaniaBlokady(gas), []);
  });

  test('bez trzymanej blokady: bierze ją na 3 s, czyta i zwalnia', () => {
    const gas = projekt();
    znacznik(gas, 'RUNNING_GSC_a', 'GSC', 10 * MIN);

    const out = gas.reclaimAbandonedRuns_('GSC', NOW);

    assert.deepEqual(nazwy(out), ['RUNNING_GSC_a']);
    assert.deepEqual(wywolaniaBlokady(gas), [['tryLock', 3000], ['releaseLock']]);
  });

  test('blokada już trzymana przez to wykonanie: nie bierze jej ponownie i nie zwalnia', () => {
    const gas = projekt();
    znacznik(gas, 'RUNNING_GSC_a', 'GSC', 10 * MIN);
    gas.$lock.held = true;

    const out = gas.reclaimAbandonedRuns_('GSC', NOW);

    assert.deepEqual(nazwy(out), ['RUNNING_GSC_a']);
    assert.deepEqual(wywolaniaBlokady(gas), []);
    assert.equal(gas.$lock.held, true);
  });

  test('blokada zajęta przez inne wykonanie: pusta lista, bez zwalniania', () => {
    const gas = loadProject({ lockHeld: true });
    znacznik(gas, 'RUNNING_GSC_a', 'GSC', 10 * MIN);

    assert.deepEqual(plain(gas.reclaimAbandonedRuns_('GSC', NOW)), []);
    assert.deepEqual(wywolaniaBlokady(gas), [['tryLock', 3000]]);
  });
});

describe('#275: settleAbandonedRuns_ i abandonedRunNote_', () => {
  const znaleziony = nazwa => ({ name: nazwa, marker: { job: 'GSC', startedAt: new Date(NOW - 10 * MIN).toISOString(), trigger: true } });

  test('błąd zapisu śladu zostawia znacznik i loguje wiadomość wyjątku', () => {
    const gas = projekt();
    const wpisy = logger(gas);
    gas.$properties.RUNNING_GSC_a = '{}';

    const out = gas.settleAbandonedRuns_([znaleziony('RUNNING_GSC_a')], () => { throw new Error('boom'); });

    assert.deepEqual(plain(out), []);
    assert.ok('RUNNING_GSC_a' in gas.$properties, 'znacznik zostaje');
    assert.deepEqual(wpisy, ['Porzucony znacznik RUNNING_GSC_a czeka na kolejny odzysk: boom']);
  });

  test('wyjątek bez message (napis, null, obiekt) jest logowany w całości albo przez message', () => {
    const gas = projekt();
    const wpisy = logger(gas);
    gas.$properties.RUNNING_GSC_a = '{}';
    const f = znaleziony('RUNNING_GSC_a');

    gas.settleAbandonedRuns_([f], () => { throw 'napis'; });
    gas.settleAbandonedRuns_([f], () => { throw null; });
    gas.settleAbandonedRuns_([f], () => { throw { message: 'wiadomosc' }; });

    assert.deepEqual(wpisy, [
      'Porzucony znacznik RUNNING_GSC_a czeka na kolejny odzysk: napis',
      'Porzucony znacznik RUNNING_GSC_a czeka na kolejny odzysk: null',
      'Porzucony znacznik RUNNING_GSC_a czeka na kolejny odzysk: wiadomosc'
    ]);
  });

  test('abandonedRunNote_: adnotacja bez tekstu (inny typ) nie udaje przyczyny', () => {
    const gas = projekt();
    const start = new Date(NOW - 10 * MIN).toISOString();

    assert.match(gas.abandonedRunNote_({ startedAt: start, failure: {} }), /możliwe przerwanie przez limit czasu/);
    assert.match(gas.abandonedRunNote_({ startedAt: start, failure: { message: 42 } }), /możliwe przerwanie przez limit czasu/);
    assert.match(gas.abandonedRunNote_({ startedAt: start, failure: { message: 'przyczyna' } }), /obsługa wyniku przerwana wyjątkiem: przyczyna; praca zakończona/);
  });
});

describe('#275: markerFailureText_ - redakcja i ucięcie', () => {
  test('znak DEL jest zastępowany spacją', () => {
    const gas = projekt();

    assert.equal(gas.markerFailureText_(new Error('a\u007fb')), 'a b');
  });

  test('spacje na początku nie liczą się do limitu 200 znaków', () => {
    const gas = projekt();

    const baza = 'ab '.repeat(100);

    const tekst = gas.markerFailureText_(new Error(' ' + baza));

    assert.equal(tekst, baza.slice(0, 200).trim());
    assert.equal(tekst.length, 200, 'bez spacji z przodu wszystkie 200 znaków limitu to treść');
  });

  test('para nazwa = wartość ze spacjami wokół znaku równości', () => {
    const gas = projekt();

    assert.equal(gas.markerFailureText_(new Error('token = abc123 koniec')), 'token=[ukryto] koniec');
    assert.equal(gas.markerFailureText_(new Error('password : tajne1 koniec')), 'password=[ukryto] koniec');
  });

  test('klucz w cudzysłowie (JSON): wartość krótka i długa nie zostaje w komunikacie', () => {
    const gas = projekt();

    assert.equal(gas.markerFailureText_(new Error('{"access_token":"abc.DEF-ghi","password":"shortPass"}')), '{"access_token"=[ukryto],"password"=[ukryto]}');
    assert.equal(gas.markerFailureText_(new Error('cfg {"authorization": "Basic dXNlcjpwYXNz"} end')), 'cfg {"authorization"=[ukryto]} end');
  });

  test('klucz i wartość w apostrofach; wartość w cudzysłowie ze spacją', () => {
    const gas = projekt();

    assert.equal(gas.markerFailureText_(new Error("{'api_key': 'tajne 1', 'x': 1}")), "{'api_key'=[ukryto], 'x': 1}");
    assert.equal(gas.markerFailureText_(new Error('password: "ab cd" koniec')), 'password=[ukryto] koniec');
  });

  test('JSON zagnieżdżony w napisie (cudzysłowy z ukośnikiem)', () => {
    const gas = projekt();

    assert.equal(gas.markerFailureText_(new Error('{\\"password\\":\\"ab cd\\",\\"x\\":1}')), '{\\"password\\"=[ukryto],\\"x\\":1}');
  });

  test('zwykły tekst bez pary klucz-wartość zostaje bez zmian', () => {
    const gas = projekt();

    assert.equal(gas.markerFailureText_(new Error('słowo "token" w cudzysłowie i key bez wartości')), 'słowo "token" w cudzysłowie i key bez wartości');
    assert.equal(gas.markerFailureText_(new Error('{"name":"anna","count":5}')), '{"name":"anna","count":5}');
  });

  test('adres http (bez s) z zapytaniem też jest redagowany', () => {
    const gas = projekt();

    assert.equal(gas.markerFailureText_(new Error('GET http://example.com/a/b?id=7&x=1 odrzucony')), 'GET http://example.com/a/b?[ukryto] odrzucony');
    assert.equal(gas.markerFailureText_(new Error('GET https://example.com/a?id=7 odrzucony')), 'GET https://example.com/a?[ukryto] odrzucony');
  });

  test('ucięcie w środku [ukryto] usuwa niedomknięty fragment, bez śmieci na końcu', () => {
    const gas = projekt();

    const tekst = gas.markerFailureText_(new Error('ab '.repeat(63) + 'Bearer sekret'));

    assert.equal(tekst, 'ab '.repeat(63) + 'Bearer');
  });

  test('całe [ukryto] mieszczące się w limicie zostaje', () => {
    const gas = projekt();

    assert.equal(gas.markerFailureText_(new Error('ab '.repeat(50) + 'Bearer sekret')), 'ab '.repeat(50) + 'Bearer [ukryto]');
  });
});

describe('#275: markerFailureText_ - wartość w cudzysłowie z ukośnikiem (Codex P2, PR #291)', () => {
  const redact = tekst => projekt().markerFailureText_(new Error(tekst));

  test('JSON z cudzysłowem w wartości: cała wartość zredagowana, nic nie zostaje po cudzysłowie', () => {
    assert.equal(redact(JSON.stringify({ password: 'prefix"private-tail' })), '{"password"=[ukryto]}');
    assert.equal(redact(JSON.stringify({ token: 'a"b"c"d-sekret' })), '{"token"=[ukryto]}');
  });

  test('wiele cudzysłowów, ukośnik na końcu wartości i ukośnik w środku', () => {
    assert.equal(redact(JSON.stringify({ secret: '"x"y"z"', next: 1 })), '{"secret"=[ukryto],"next":1}');
    assert.equal(redact(JSON.stringify({ password: 'koniec\\' })), '{"password"=[ukryto]}');
    assert.equal(redact(JSON.stringify({ password: 'sr\\odek"ogon' })), '{"password"=[ukryto]}');
    assert.equal(redact(JSON.stringify({ password: '\\"\\\\"ogon', ok: 1 })), '{"password"=[ukryto],"ok":1}');
  });

  test('klucz z = zamiast :, wartość w cudzysłowie albo apostrofach z ucieczką', () => {
    assert.equal(redact('password="pre\\"fix-ogon" koniec'), 'password=[ukryto] koniec');
    assert.equal(redact("api_key = 'it\\'s-tajne-ogon' koniec"), 'api_key=[ukryto] koniec');
    assert.equal(redact("{'password': 'a\\'b-ogon'}"), "{'password'=[ukryto]}");
  });

  test('JSON zagnieżdżony w napisie: cudzysłów w wartości też jest ucieczką', () => {
    const wewnetrzny = JSON.stringify(JSON.stringify({ password: 'prefix"private-tail', x: 1 }));
    assert.equal(redact(wewnetrzny), '"{\\"password\\"=[ukryto],\\"x\\":1}"');
    assert.equal(redact('{\\"password\\":\\"koniec\\\\\\"ogon\\"}'), '{\\"password\\"=[ukryto]}');
    assert.equal(redact('{\\"password\\":\\"ab cd\\\\ef gh\\"}'), '{\\"password\\"=[ukryto]}', 'seria ukośników w środku wartości ze spacją');
  });

  test('następne pole po zredagowanym zostaje, a cudzysłów w innym polu nie jest ruszany', () => {
    assert.equal(redact(JSON.stringify({ password: 'a"b', note: 'wartość "w cudzysłowie"' })),
      '{"password"=[ukryto],"note":"wartość \\"w cudzysłowie\\""}');
  });

  test('niedomknięty cudzysłów: redagowane do separatora, nic nie zostaje', () => {
    assert.equal(redact('password="niedomkniete-ogon koniec'), 'password=[ukryto] koniec');
  });

  test('długi ciąg ukośników nie zawiesza redakcji (brak wykładniczego nawrotu)', () => {
    const start = Date.now();
    redact('password:\\"' + '\\'.repeat(5000) + 'x');
    redact('password:"' + '\\'.repeat(5001));
    assert.ok(Date.now() - start < 1000, 'redakcja trwała ' + (Date.now() - start) + ' ms');
  });
});

describe('#275: annotateRunMarker_ - logowanie błędu zapisu', () => {
  test('brak znacznika: loguje nazwę znacznika', () => {
    const gas = projekt();
    const wpisy = logger(gas);

    gas.annotateRunMarker_('GSC', 'abc', new Error('x'));

    assert.equal(wpisy.length, 1);
    assert.match(wpisy[0], /^Adnotacja znacznika RUNNING_GSC_abc nie została zapisana: /);
  });

  test('błąd zapisu z wiadomością i bez: dokładny tekst', () => {
    const gas = projekt();
    const wpisy = logger(gas);
    gas.$properties.RUNNING_GSC_a1 = JSON.stringify({ job: 'GSC' });
    const rzeczywiste = gas.PropertiesService.getScriptProperties();
    let blad = new Error('limit');
    gas.PropertiesService.getScriptProperties = () => ({
      getProperty: k => rzeczywiste.getProperty(k),
      setProperty: () => { throw blad; }
    });

    gas.annotateRunMarker_('GSC', 'a1', new Error('x'));
    blad = 'napis';
    gas.annotateRunMarker_('GSC', 'a1', new Error('x'));
    blad = { message: 'obiekt' };
    gas.annotateRunMarker_('GSC', 'a1', new Error('x'));

    assert.deepEqual(wpisy, [
      'Adnotacja znacznika RUNNING_GSC_a1 nie została zapisana: limit',
      'Adnotacja znacznika RUNNING_GSC_a1 nie została zapisana: napis',
      'Adnotacja znacznika RUNNING_GSC_a1 nie została zapisana: obiekt'
    ]);
  });
});
