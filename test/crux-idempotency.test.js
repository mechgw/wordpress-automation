'use strict';

/**
 * #155: idempotencja zapisu CrUX do „CWV FIELD”.
 *
 * Stan zmierzony w arkuszu produkcyjnym 2026-09-13: 52 wiersze, 28 kluczy,
 * 24 nadmiarowe. Podział przebiegał dokładnie po jednej linii — wiersze
 * z pustym „Okres do” (markery dostępności) nie zdublowały się ani razu,
 * wiersze z datą wystąpiły potrójnie. Typ komórki potwierdził pasek stanu:
 * zaznaczenie kolumny „Okres do” daje agregat „Min.”, czyli wartość liczbową,
 * a zaznaczenie kolumny „Metryka” tylko „Liczba”.
 *
 * Stub arkusza nie parsuje zapisywanych łańcuchów na daty, więc warunek
 * produkcyjny odtwarzamy wprost: podmieniamy komórkę na obiekt daty. Używamy
 * `gas.$Date`, bo źródła działają w osobnym kontekście VM i `Date` z testu nie jest
 * tam rozpoznawany — w Apps Script `getValues()` oddaje datę z tego samego świata
 * co kod, więc to artefakt harnessu, nie różnica zachowania.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const URLS = 'PERFORMANCE URLS';
const FIELD = 'CWV FIELD';
const URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const FIELD_HEADER = ['Okres do', 'URL', 'Form factor', 'Metryka', 'p75', 'Stan', 'Źródło', 'Pobrano'];
const FIELD_KEY = [{ column: 0, dateFormat: 'yyyy-MM-dd' }, 1, 2, 3];
const URL = 'https://www.example.pl/';
const KEY = { PAGESPEED_API_KEY: 'klucz-testowy' };
const COL = { period: 0, url: 1, form: 2, metric: 3, p75: 4, state: 5, source: 6, fetched: 7 };
const LCP = 'largest_contentful_paint';

const rekord = (okres, lcp) => JSON.stringify({
  record: {
    collectionPeriod: { lastDate: { year: 2026, month: 9, day: okres } },
    metrics: {
      largest_contentful_paint: { percentiles: { p75: lcp } },
      interaction_to_next_paint: { percentiles: { p75: 180 } },
      cumulative_layout_shift: { percentiles: { p75: 0.05 } }
    }
  }
});

/** Dane dla konkretnego adresu; domena nie jest wtedy nawet pytana. */
const zAdresu = (okres = 1, lcp = 2100) => body => (body.origin
  ? { code: 404, text: '{}' }
  : { code: 200, text: rekord(okres, lcp) });
/** Adres bez danych, domena z danymi — najczęstszy przypadek na produkcji. */
const zDomeny = (okres = 1, lcp = 2100) => body => (body.origin
  ? { code: 200, text: rekord(okres, lcp) }
  : { code: 404, text: '{}' });
/** Ani adres, ani domena: to informacja o ruchu, nie awaria. */
const brakDanych = () => ({ code: 404, text: '{}' });
/** Awaria API — odczyt się nie udał, a to co innego niż brak danych. */
const awaria = () => ({ code: 500, text: 'boom' });

function scenariusz(opcje = {}) {
  let odpowiedz = brakDanych;
  const gas = loadProject(Object.assign({
    properties: KEY,
    sheets: { [URLS]: [URLS_HEADER, [URL, 'homepage', '']] },
    fetch: (url, params) => odpowiedz(JSON.parse(params.payload))
  }, opcje));
  return {
    gas,
    przebieg(responder) {
      odpowiedz = responder;
      return plain(gas.runCruxMeasurement_());
    },
    wiersze: () => gas.$sheet(FIELD).slice(1).filter(r => String(r[COL.url] || '') !== ''),
    markery: () => gas.$sheet(FIELD).slice(1)
      .filter(r => r[COL.metric] === 'wszystkie' && r[COL.state] === 'INSUFFICIENT_DATA')
  };
}

/** Okres w postaci porównywalnej — komórka bywa łańcuchem, bywa datą. */
const okres = value => {
  if (typeof value === 'string') return value;
  const pad = n => String(n).padStart(2, '0');
  return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate());
};

/** To, co arkusz robi z zapisanym łańcuchem „RRRR-MM-DD”: zamienia go na datę. */
function arkuszParsujeDaty(gas) {
  let zamienione = 0;
  gas.$sheet(FIELD).slice(1).forEach(row => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(row[COL.period]));
    if (!m) return;
    row[COL.period] = new gas.$Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    zamienione++;
  });
  return zamienione;
}

describe('#155: klucz zapisu jest kanoniczny', () => {
  test('1: dwa przebiegi tego samego okresu nie mnożą wierszy i podmieniają wartości', () => {
    const s = scenariusz();
    s.przebieg(zAdresu(1, 2100));
    s.przebieg(zAdresu(1, 2400));

    assert.equal(s.wiersze().length, 6, 'trzy metryki razy dwa form factory');
    assert.deepEqual(
      s.wiersze().filter(r => r[COL.metric] === LCP).map(r => r[COL.p75]),
      [2400, 2400],
      'w arkuszu została nowa wartość, nie stara'
    );
  });

  test('2: „Okres do” tekstem po stronie zapisu, datą w arkuszu — jeden wiersz', () => {
    const s = scenariusz();
    s.przebieg(zAdresu(1));
    assert.equal(arkuszParsujeDaty(s.gas), 6, 'warunek produkcyjny odtworzony');
    assert.ok(s.wiersze()[0][COL.period] instanceof s.gas.$Date);

    s.przebieg(zAdresu(1));
    assert.equal(s.wiersze().length, 6, 'bez normalizacji byłoby dwanaście');
  });

  test('3: symetrycznie — data po stronie zapisu, tekst w arkuszu', () => {
    const s = scenariusz();
    s.przebieg(zAdresu(1));
    const przychodzacy = s.wiersze()
      .filter(r => r[COL.form] === 'PHONE' && r[COL.metric] === LCP)
      .map(r => r.slice());
    przychodzacy.forEach(r => { r[COL.period] = new s.gas.$Date(2026, 8, 1); r[COL.p75] = 3000; });

    s.gas.upsertPerformanceRows_(FIELD, FIELD_HEADER, FIELD_KEY, przychodzacy);

    const lcp = s.wiersze().filter(r => r[COL.form] === 'PHONE' && r[COL.metric] === LCP);
    assert.equal(lcp.length, 1, 'ta sama data z dwóch stron to jeden klucz');
    assert.equal(lcp[0][COL.p75], 3000);

    // Druga połowa kontraktu: normalizacja ma zrównać tę samą datę, a nie każdą.
    przychodzacy.forEach(r => { r[COL.period] = new s.gas.$Date(2026, 8, 8); r[COL.p75] = 3300; });
    s.gas.upsertPerformanceRows_(FIELD, FIELD_HEADER, FIELD_KEY, przychodzacy);

    const oba = s.wiersze().filter(r => r[COL.form] === 'PHONE' && r[COL.metric] === LCP);
    assert.deepEqual(oba.map(r => okres(r[COL.period])), ['2026-09-01', '2026-09-08'], 'inna data to inny klucz');
  });

  test('7: nowy okres dokłada wiersze, starszego nie rusza', () => {
    const s = scenariusz();
    s.przebieg(zAdresu(1));
    arkuszParsujeDaty(s.gas);
    s.przebieg(zAdresu(8));

    const okresy = s.wiersze().map(r => okres(r[COL.period]));
    assert.equal(s.wiersze().length, 12);
    assert.equal(okresy.filter(o => o === '2026-09-08').length, 6, 'nowy okres');
    assert.equal(new Set(okresy).size, 2, 'oba okresy obok siebie');
  });

  test('10: duplikaty sprzed poprawki zwijają się przy pierwszym zapisie', () => {
    // Kształt z produkcji: ten sam komplet zapisany trzy razy, „Okres do” datą.
    const s = scenariusz();
    s.przebieg(zAdresu(1));
    arkuszParsujeDaty(s.gas);
    const kopie = s.wiersze().map(r => r.slice());
    s.gas.$sheet(FIELD).push(...kopie.map(r => r.slice()), ...kopie.map(r => r.slice()));
    assert.equal(s.wiersze().length, 18, 'trzy kopie sześciu wierszy');

    s.przebieg(zAdresu(8));

    assert.equal(s.wiersze().length, 12, 'sześć zwiniętych plus sześć nowych');
    const stare = s.wiersze().filter(r => okres(r[COL.period]) === '2026-09-01');
    assert.equal(stare.length, 6, 'historia została, ale bez kopii');
  });

  test('11: zwijanie zostawia kopię najnowszą, a nie najniżej położoną', () => {
    // Kopie potrafią się różnić: jedna z danych domeny, druga z odczytu adresu.
    // Zakładkę wolno posortować, więc pozycja wiersza nie jest chronologią.
    const s = scenariusz();
    s.przebieg(zDomeny(1, 2900));
    arkuszParsujeDaty(s.gas);
    const starsze = s.wiersze().map(r => r.slice());
    starsze.forEach(r => { r[COL.fetched] = new s.gas.$Date(2026, 8, 10); });
    const nowsze = starsze.map(r => r.slice());
    nowsze.forEach(r => {
      r[COL.p75] = 2100;
      r[COL.source] = 'CRUX';
      r[COL.fetched] = new s.gas.$Date(2026, 8, 12);
    });

    // Arkusz posortowany malejąco po „Pobrano”: nowsza kopia leży WYŻEJ.
    const grid = s.gas.$sheet(FIELD);
    grid.length = 1;
    grid.push(...nowsze, ...starsze);
    assert.equal(s.wiersze().length, 12);

    s.przebieg(zAdresu(8, 2000));

    const stare = s.wiersze().filter(r => okres(r[COL.period]) === '2026-09-01');
    assert.equal(stare.length, 6, 'po jednej kopii na klucz');
    assert.deepEqual([...new Set(stare.map(r => r[COL.source]))], ['CRUX'], 'przeżyła kopia nowsza');
    assert.deepEqual(
      stare.filter(r => r[COL.metric] === LCP).map(r => r[COL.p75]),
      [2100, 2100],
      'wartość z nowszego odczytu, nie z niżej położonego wiersza'
    );
  });

  test('12: „Pobrano” bywa tekstem — porównanie działa, a wartość nieczytelna przegrywa', () => {
    // Kolumna sformatowana jako tekst oddaje łańcuch, nie datę; obie postaci
    // trafiają obok siebie w tej samej zakładce.
    const s = scenariusz();
    s.przebieg(zDomeny(1, 2900));
    arkuszParsujeDaty(s.gas);
    const wzor = s.wiersze()[0].slice();
    const kopia = (p75, pobrano) => {
      const row = wzor.slice();
      row[COL.p75] = p75;
      row[COL.fetched] = pobrano;
      return row;
    };

    const grid = s.gas.$sheet(FIELD);
    grid.length = 1;
    grid.push(
      kopia(2700, '2026-09-12'),
      kopia(2800, 'nie wiadomo'),
      kopia(2900, new s.gas.$Date(2026, 8, 10))
    );

    s.przebieg(zAdresu(8, 2000));

    const stare = s.wiersze().filter(r => okres(r[COL.period]) === '2026-09-01');
    assert.equal(stare.length, 1, 'trzy kopie zwinięte do jednej');
    assert.equal(stare[0][COL.fetched], '2026-09-12', 'tekstowa data wygrywa z wcześniejszą');
    assert.equal(stare[0][COL.p75], 2700);
  });
});

describe('#155: marker dostępności danych', () => {
  test('4: dwa przebiegi bez danych dają jeden marker na parę, nie dwa', () => {
    const s = scenariusz();
    s.przebieg(brakDanych);
    s.przebieg(brakDanych);

    assert.equal(s.markery().length, 2, 'po jednym na form factor');
    assert.deepEqual([...new Set(s.markery().map(r => r[COL.period]))], [''], 'marker nie ma okresu');
  });

  test('5: gdy dane wracają, marker znika, a historia okresów zostaje', () => {
    const s = scenariusz();
    s.przebieg(brakDanych);
    assert.equal(s.markery().length, 2);
    // Wcześniejszy okres, sprzed przerwy w danych.
    s.gas.$sheet(FIELD).push([new s.gas.$Date(2026, 7, 1), URL, 'PHONE', LCP, 1900, 'OK', 'CRUX', new s.gas.$Date()]);

    s.przebieg(zAdresu(8));

    assert.deepEqual(s.markery(), [], 'zakładka nie twierdzi dwóch rzeczy naraz');
    assert.equal(s.wiersze().filter(r => r[COL.state] === 'OK').length, 7, 'sześć nowych i jeden historyczny');
    assert.equal(
      s.wiersze().filter(r => okres(r[COL.period]) === '2026-08-01').length, 1,
      'starszy okres nietknięty'
    );
  });

  test('6: gdy dane znikają, marker wraca i nie kasuje żadnego okresu', () => {
    const s = scenariusz();
    s.przebieg(zAdresu(1));
    arkuszParsujeDaty(s.gas);

    s.przebieg(brakDanych);

    assert.equal(s.markery().length, 2);
    assert.equal(s.wiersze().filter(r => r[COL.state] === 'OK').length, 6, 'żaden pomiar nie zniknął');
  });

  test('9: nieudany odczyt nie usuwa markera ani niczego innego', () => {
    const s = scenariusz();
    s.przebieg(brakDanych);
    const przed = s.gas.$sheet(FIELD).map(r => r.slice());

    assert.throws(() => s.przebieg(awaria), /CrUX HTTP 500/);

    assert.deepEqual(s.gas.$sheet(FIELD), przed, 'zakładka bez zmian');
    assert.equal(s.markery().length, 2, 'ostatnia dobra diagnoza przetrwała');
  });

  test('brak jednej metryki to nie marker dostępności — ma nazwę metryki', () => {
    const s = scenariusz();
    s.przebieg(body => (body.origin ? { code: 404, text: '{}' } : {
      code: 200,
      text: JSON.stringify({
        record: {
          collectionPeriod: { lastDate: { year: 2026, month: 9, day: 1 } },
          metrics: { largest_contentful_paint: { percentiles: { p75: 2100 } } }
        }
      })
    }));

    const puste = s.wiersze().filter(r => r[COL.state] === 'INSUFFICIENT_DATA');
    assert.equal(puste.length, 4, 'dwie metryki bez danych razy dwa form factory');
    assert.deepEqual(s.markery(), [], 'ale odczyt się udał, więc markera nie ma');
  });
});

describe('#155: odczyt per URL zastępuje fallback domenowy', () => {
  test('8: ta sama czwórka klucza — wartość adresu wypiera wartość domeny', () => {
    const s = scenariusz();
    s.przebieg(zDomeny(1, 2900));
    arkuszParsujeDaty(s.gas);
    assert.deepEqual([...new Set(s.wiersze().map(r => r[COL.source]))], ['CRUX (domena)']);

    s.przebieg(zAdresu(1, 2100));

    assert.equal(s.wiersze().length, 6, 'nie dwa wiersze na metrykę');
    assert.deepEqual([...new Set(s.wiersze().map(r => r[COL.source]))], ['CRUX'],
      'kolumna Źródło mówi, skąd pochodzi wartość, która została');
    assert.deepEqual(
      s.wiersze().filter(r => r[COL.metric] === LCP).map(r => r[COL.p75]),
      [2100, 2100]
    );
  });
});

describe('#155: klucz liczony w strefie arkusza, nie skryptu', () => {
  // Strefa skryptu jest przypięta w `src/appsscript.json`, strefa arkusza to osobne
  // ustawienie (Plik → Ustawienia). Stub `Utilities.formatDate` ignoruje strefę, więc
  // na czas tego testu podstawiamy formater, który ją respektuje — inaczej test nie
  // mógłby w ogóle zobaczyć przesunięcia, któremu ma zapobiegać.
  const SKRYPT = 'Europe/Warsaw';
  const ARKUSZ = 'Pacific/Kiritimati';
  const PRZESUNIECIA = { [SKRYPT]: 2, [ARKUSZ]: 14 };

  const formatujWStrefie = (date, tz, pattern) => {
    if (!(tz in PRZESUNIECIA)) throw new Error('nieznana strefa: ' + tz);
    const przesunieta = new Date(date.getTime() + PRZESUNIECIA[tz] * 3600000);
    const pad = n => String(n).padStart(2, '0');
    const parts = {
      yyyy: String(przesunieta.getUTCFullYear()),
      MM: pad(przesunieta.getUTCMonth() + 1),
      dd: pad(przesunieta.getUTCDate()),
      HH: pad(przesunieta.getUTCHours()),
      mm: pad(przesunieta.getUTCMinutes()),
      ss: pad(przesunieta.getUTCSeconds())
    };
    return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, m => parts[m]);
  };

  test('13: data z komórki to północ w strefie arkusza — dzień się nie przesuwa', () => {
    const s = scenariusz({ timeZone: ARKUSZ });
    const uzyteStrefy = [];
    s.gas.Utilities.formatDate = (date, tz, pattern) => {
      uzyteStrefy.push(tz);
      return formatujWStrefie(date, tz, pattern);
    };

    s.przebieg(zAdresu(8));
    assert.deepEqual([...new Set(s.wiersze().map(r => r[COL.period]))], ['2026-09-08']);

    // Tak wygląda ta komórka, gdy arkusz sparsuje zapisany łańcuch: północ
    // 2026-09-08 w strefie ARKUSZA, czyli 2026-09-07 10:00 UTC.
    const polnocWArkuszu = new s.gas.$Date(Date.UTC(2026, 8, 7, 10, 0, 0));
    s.gas.$sheet(FIELD).slice(1).forEach(row => { row[COL.period] = polnocWArkuszu; });
    assert.equal(
      formatujWStrefie(polnocWArkuszu, SKRYPT, 'yyyy-MM-dd'), '2026-09-07',
      'w strefie skryptu to już inny dzień — strefy naprawdę się rozjeżdżają'
    );

    s.przebieg(zAdresu(8));

    assert.equal(s.wiersze().length, 6, 'ten sam okres CrUX to jeden komplet wierszy');
    assert.deepEqual([...new Set(uzyteStrefy)], [ARKUSZ], 'klucz liczony wyłącznie w strefie arkusza');
  });
});
