'use strict';

/**
 * #275: wyjątek w obsłudze wyniku po udanej pracy nie udaje limitu czasu.
 *
 * Rejestratory przebiegów osłaniały `try/catch` tylko pracę. Wyjątek ze skutków
 * (np. błąd usługi Arkuszy przy `appendRow`) uciekał ze znacznikiem `RUNNING_*`,
 * a odbiór go zgłaszał jako przerwanie limitem czasu Apps Script. Numeracja
 * odpowiada macierzy z #275.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./helpers/gas');

const LOG = 'IMPORT LOG';
const MIN = 60 * 1000;
const LIMIT = /możliwe przerwanie przez limit czasu wykonania Apps Script/;
const USLUGA = 'Service Spreadsheet failed';
const udany = () => ({ rows: 5, detail: 'x', days: 1, dataFrom: '2026-10-01', dataTo: '2026-10-01' });

const projekt = () => loadProject({ properties: { ALERT_EMAIL: 'alerty@example.pl' } });
const znaczniki = gas => Object.keys(gas.$properties).filter(k => k.indexOf('RUNNING_') === 0).sort();
const wartosc = (gas, nazwa) => JSON.parse(gas.$properties[nazwa]);
const logi = gas => (gas.$sheet(LOG) || []).slice(1).filter(r => String(r[1] || '') !== '');
const postarz = (gas, nazwa, minut) => {
  const m = wartosc(gas, nazwa);
  m.startedAt = new Date(gas.$Date.now() - minut * MIN).toISOString();
  gas.$properties[nazwa] = JSON.stringify(m);
};
/** `appendImportLog_` rzuca, dopóki nie wywołasz zwróconej funkcji. */
function psujLog(gas, komunikat = USLUGA) {
  const oryginal = gas.appendImportLog_;
  gas.appendImportLog_ = () => { throw new Error(komunikat); };
  return () => { gas.appendImportLog_ = oryginal; };
}

describe('#275: adnotacja znacznika przy wyjątku z obsługi wyniku', () => {
  test('1: import - wyjątek z appendImportLog_ po udanym fn() wychodzi z tą samą wiadomością; znacznik zostaje z adnotacją', () => {
    const gas = projekt();
    psujLog(gas);

    assert.throws(() => gas.recordImportRun_('GA4', true, udany), new RegExp(USLUGA));

    const nazwy = znaczniki(gas);
    assert.equal(nazwy.length, 1);
    const znacznik = wartosc(gas, nazwy[0]);
    assert.equal(znacznik.failure.message, USLUGA);
    assert.ok(!Number.isNaN(Date.parse(znacznik.failure.at)));
    assert.equal(znacznik.job, 'GA4');
    assert.equal(znacznik.trigger, true);
    assert.ok(JSON.parse(gas.$properties.LAST_IMPORT_GA4).lastOk, 'praca zapisana');
  });

  test('2: zadanie - to samo dla recordJobRunLocked_', () => {
    const gas = projekt();
    psujLog(gas);

    assert.throws(() => gas.recordJobRun_('PERFORMANCE', true, () => ({ rows: 1, detail: 'ok' })), new RegExp(USLUGA));

    const nazwy = znaczniki(gas);
    assert.equal(nazwy.length, 1);
    assert.equal(wartosc(gas, nazwy[0]).failure.message, USLUGA);
    assert.equal(wartosc(gas, nazwy[0]).job, 'PERFORMANCE');
  });

  test('3: kolejny przebieg po 8 min - wiersz, incydent i mail podają przyczynę, bez zdania o limicie czasu', () => {
    const gas = projekt();
    const napraw = psujLog(gas);
    assert.throws(() => gas.recordImportRun_('GA4', true, udany));
    postarz(gas, znaczniki(gas)[0], 8);
    napraw();

    gas.recordImportRun_('GA4', true, udany);

    const przyczyna = new RegExp('obsługa wyniku przerwana wyjątkiem: ' + USLUGA + '; praca zakończona');
    const blad = logi(gas).find(r => r[4] === 'BŁĄD');
    assert.match(String(blad[8]), przyczyna);
    assert.doesNotMatch(String(blad[8]), LIMIT);
    const incydent = JSON.parse(gas.$properties.LAST_IMPORT_GA4).incident;
    assert.match(incydent.detail, przyczyna);
    assert.doesNotMatch(incydent.detail, LIMIT);
    assert.match(gas.$mails[0].body, przyczyna);
    assert.doesNotMatch(gas.$mails[0].body, LIMIT);
    assert.deepEqual(znaczniki(gas), [], 'odebrany znacznik schodzi');
  });

  test('4: znacznik bez adnotacji (ubicie) - tekst jak dotąd, ostrożny', () => {
    const gas = projekt();
    gas.$properties.RUNNING_GA4_stary = JSON.stringify({ job: 'GA4', runId: 'stary', startedAt: new Date(gas.$Date.now() - 10 * MIN).toISOString(), trigger: true });

    gas.recordImportRun_('GA4', true, udany);

    const blad = logi(gas).find(r => r[4] === 'BŁĄD');
    assert.match(String(blad[8]), LIMIT);
    assert.doesNotMatch(String(blad[8]), /obsługa wyniku przerwana/);
  });

  test('5: zapis adnotacji rzuca - oryginalny wyjątek wychodzi, znacznik bez failure, odbiór ostrożny', () => {
    const gas = projekt();
    psujLog(gas);
    const rzeczywiste = gas.PropertiesService.getScriptProperties();
    gas.PropertiesService.getScriptProperties = () => ({
      getProperty: k => rzeczywiste.getProperty(k),
      getProperties: () => rzeczywiste.getProperties(),
      deleteProperty: k => rzeczywiste.deleteProperty(k),
      setProperty: (k, v) => {
        if (k.indexOf('RUNNING_') === 0 && v.indexOf('"failure"') >= 0) throw new Error('quota');
        return rzeczywiste.setProperty(k, v);
      }
    });

    assert.throws(() => gas.recordImportRun_('GA4', true, udany), new RegExp(USLUGA));

    const nazwy = znaczniki(gas);
    assert.equal(nazwy.length, 1);
    assert.equal(wartosc(gas, nazwy[0]).failure, undefined);
    postarz(gas, nazwy[0], 8);
    assert.match(gas.abandonedRunNote_(wartosc(gas, nazwy[0])), LIMIT);
    assert.doesNotMatch(gas.abandonedRunNote_(wartosc(gas, nazwy[0])), /obsługa wyniku przerwana/);
  });

  test('5b: znacznika już nie ma (JSON.parse(null)) - adnotacja nie maskuje wyjątku', () => {
    const gas = projekt();
    const rzeczywiste = gas.PropertiesService.getScriptProperties();
    gas.PropertiesService.getScriptProperties = () => ({
      getProperty: k => (k.indexOf('RUNNING_') === 0 ? null : rzeczywiste.getProperty(k)),
      getProperties: () => rzeczywiste.getProperties(),
      deleteProperty: k => rzeczywiste.deleteProperty(k),
      setProperty: (k, v) => rzeczywiste.setProperty(k, v)
    });
    psujLog(gas);

    assert.throws(() => gas.recordImportRun_('GA4', true, udany), new RegExp(USLUGA));
  });

  test('6: wiadomość z nową linią i tabulatorem - failure.message w jednej linii', () => {
    const gas = projekt();
    psujLog(gas, 'pierwsza\nlinia\r\ndruga\tkolumna\u0001koniec');

    assert.throws(() => gas.recordImportRun_('GA4', true, udany));

    const tekst = wartosc(gas, znaczniki(gas)[0]).failure.message;
    assert.equal(tekst, 'pierwsza linia druga kolumna koniec');
    assert.ok(!tekst.split('').some(ch => ch < ' '), 'bez znaków sterujących');
  });

  test('7: wiadomość 5000 znaków - najwyżej 200', () => {
    const gas = projekt();
    psujLog(gas, 'błąd ' + 'a b '.repeat(1250));

    assert.throws(() => gas.recordImportRun_('GA4', true, udany));

    const tekst = wartosc(gas, znaczniki(gas)[0]).failure.message;
    assert.ok(tekst.length <= 200, String(tekst.length));
    assert.ok(tekst.startsWith('błąd a b'));
  });

  test('8: wiadomość z tokenem, kluczem, e-mailem i adresem z zapytaniem - nic z tego w znaczniku, logu, incydencie ani mailu', () => {
    const gas = projekt();
    const sekrety = ['abc.DEF-ghi', 'S3CR3T-VALUE', 'tok-abc.XYZ', 'sekret.osoba', 'KLUCZ-W-ZAPYTANIU', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'];
    const napraw = psujLog(gas,
      'Bearer abc.DEF-ghi odrzucony; api_key=S3CR3T-VALUE; access_token: tok-abc.XYZ; kontakt sekret.osoba@example.com; ' +
      'GET https://api.example.com/v1/zasob?key=KLUCZ-W-ZAPYTANIU&x=1 oraz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd');
    assert.throws(() => gas.recordImportRun_('GA4', true, udany));
    const tekst = wartosc(gas, znaczniki(gas)[0]).failure.message;
    napraw();
    postarz(gas, znaczniki(gas)[0], 8);
    gas.recordImportRun_('GA4', true, udany);

    const wszystko = [tekst, JSON.stringify(logi(gas)), gas.$properties.LAST_IMPORT_GA4, gas.$mails.map(m => m.body).join('\n')].join('\n');
    sekrety.forEach(s => assert.ok(!wszystko.includes(s), 'wyciekło: ' + s));
    assert.match(tekst, /\[ukryto\]/);
    assert.match(tekst, /^Bearer \[ukryto\] odrzucony; api_key=\[ukryto\]; access_token=\[ukryto\]; kontakt \[ukryto\]; GET https:\/\/api\.example\.com\/v1\/zasob\?\[ukryto\] oraz \[ukryto\]$/);
  });

  test('9: wiadomość pusta, same białe znaki albo brak - "nieznany wyjątek"', () => {
    const gas = projekt();
    assert.equal(gas.markerFailureText_(new Error('')), 'nieznany wyjątek');
    assert.equal(gas.markerFailureText_(new Error(' \n\t ')), 'nieznany wyjątek');
    assert.equal(gas.markerFailureText_(undefined), 'nieznany wyjątek');
    assert.equal(gas.markerFailureText_(null), 'nieznany wyjątek');
    assert.equal(gas.markerFailureText_('zwykły napis'), 'zwykły napis');
  });

  test('9b: ucięcie nie zostawia niedomkniętego [ukryto]', () => {
    const gas = projekt();
    const wiadomosc = 'x'.repeat(195) + ' Bearer sekretnytoken i dalej';

    const tekst = gas.markerFailureText_(new Error(wiadomosc));

    assert.ok(tekst.length <= 200);
    assert.doesNotMatch(tekst, /\[[^\]]*$/);
    assert.ok(!tekst.includes('sekretnytoken'));
  });

  test('10: tożsamość - adnotowany tylko znacznik bieżącego runId; pozostałe bajt w bajt', () => {
    const gas = projekt();
    const teraz = gas.$Date.now();
    const inneZadanie = JSON.stringify({ job: 'PERFORMANCE', runId: 'inny-job', startedAt: new Date(teraz - MIN).toISOString(), trigger: true });
    const tenSamJob = JSON.stringify({ job: 'GA4', runId: 'rownolegly', startedAt: new Date(teraz - MIN).toISOString(), trigger: false });
    gas.$properties.RUNNING_PERFORMANCE_inny = inneZadanie;
    gas.$properties.RUNNING_GA4_rownolegly = tenSamJob;
    psujLog(gas);

    assert.throws(() => gas.recordImportRun_('GA4', true, udany));

    assert.equal(gas.$properties.RUNNING_PERFORMANCE_inny, inneZadanie);
    assert.equal(gas.$properties.RUNNING_GA4_rownolegly, tenSamJob);
    const wlasny = znaczniki(gas).filter(k => k !== 'RUNNING_PERFORMANCE_inny' && k !== 'RUNNING_GA4_rownolegly');
    assert.equal(wlasny.length, 1);
    const znacznik = wartosc(gas, wlasny[0]);
    assert.equal(wlasny[0], 'RUNNING_GA4_' + znacznik.runId);
    assert.equal(znacznik.job, 'GA4');
    assert.equal(znacznik.trigger, true);
    assert.ok(!Number.isNaN(Date.parse(znacznik.startedAt)));
    assert.deepEqual(Object.keys(znacznik).sort(), ['failure', 'job', 'runId', 'startedAt', 'trigger']);
  });

  test('11: wyjątek z samej pracy fn() - ścieżka bez zmian: znacznik schodzi, rekord ok:false, bez adnotacji', () => {
    const gas = projekt();

    assert.throws(() => gas.recordImportRun_('GA4', true, () => { throw new Error('API padło'); }), /API padło/);
    assert.throws(() => gas.recordJobRun_('PERFORMANCE', true, () => { throw new Error('boom'); }), /boom/);

    assert.deepEqual(znaczniki(gas), []);
    assert.equal(JSON.parse(gas.$properties.LAST_IMPORT_GA4).lastRun.ok, false);
    assert.equal(JSON.parse(gas.$properties.LAST_RUN_PERFORMANCE).lastRun.error, 'boom');
  });
});
