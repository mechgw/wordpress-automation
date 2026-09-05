'use strict';

/**
 * #42: alerty e-mail w modelu incydentu (OK → problem: jeden mail; problem →
 * problem: cisza; problem → OK: mail zamykający), strażnik nieaktualnych
 * danych, konfiguracja przez ALERT_EMAIL / ALERT_RECOVERY.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const GSC_SHEET = 'Konfiguracja GSC';
const GA4_SHEET = 'Konfiguracja GA4';
const LOG = 'IMPORT LOG';
const HEADER = ['Czas', 'Źródło', 'Typ', 'Dni', 'Wynik', 'Wiersze', 'Czas [s]', 'Szczegóły', 'Błąd / uwaga'];
const MAIL = { ALERT_EMAIL: 'alerty@example.pl' };

function sheets() {
  return {
    [GSC_SHEET]: [['k', 'v'], ['siteUrl', 'https://www.example.pl/'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']],
    [GA4_SHEET]: [['k', 'v'], ['propertyId', 'properties/111'], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['status', '']]
  };
}
const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString();
const record = (gas, source = 'GSC') => JSON.parse(gas.$properties['LAST_IMPORT_' + source]);
const counts = out => ({ opened: plain(out).opened, closed: plain(out).closed });
const ok = (gas, source = 'GSC') => gas.recordImportRun_(source, true, () => ({ rows: 5, days: 1, detail: '5 wierszy' }));
const fail = (gas, msg = 'Search Console API HTTP 500: boom', source = 'GSC') =>
  assert.throws(() => gas.recordImportRun_(source, true, () => { throw new Error(msg); }), new RegExp(msg.slice(0, 20)));

describe('incydent: błąd importu', () => {
  test('pierwszy błąd otwiera incydent i wysyła jeden e-mail z treścią błędu', () => {
    const gas = loadProject({ sheets: sheets(), properties: MAIL });
    fail(gas);
    assert.equal(gas.$mails.length, 1);
    const mail = gas.$mails[0];
    assert.equal(mail.to, 'alerty@example.pl');
    assert.equal(mail.subject, '[wordpress-automation] BŁĄD importu: Search Console (GSC)');
    assert.match(mail.body, /Błąd: Search Console API HTTP 500: boom/);
    assert.match(mail.body, /Uruchomienie: trigger/);
    assert.match(mail.body, /Brak poprawnego importu\./);
    assert.match(mail.body, /Arkusz: https:\/\/docs\.google\.com/);
    assert.match(mail.body, /Wersja skryptu: dev/);
    const inc = record(gas).incident;
    assert.equal(inc.open, true);
    assert.equal(inc.reason, 'error');
    assert.ok(inc.notifiedAt);
  });

  test('kolejne błędy przy otwartym incydencie nie wysyłają maili, ale aktualizują szczegóły', () => {
    const gas = loadProject({ sheets: sheets(), properties: MAIL });
    fail(gas, 'HTTP 500 pierwszy');
    fail(gas, 'HTTP 503 drugi');
    fail(gas, 'HTTP 504 trzeci');
    assert.equal(gas.$mails.length, 1, 'only the opening mail');
    assert.equal(record(gas).incident.detail, 'HTTP 504 trzeci');
    assert.equal(record(gas).incident.open, true);
  });

  test('udany import zamyka incydent i wysyła e-mail o powrocie do normy', () => {
    const gas = loadProject({ sheets: sheets(), properties: MAIL });
    fail(gas);
    ok(gas);
    assert.equal(gas.$mails.length, 2);
    assert.equal(gas.$mails[1].subject, '[wordpress-automation] Import ponownie działa: Search Console (GSC)');
    assert.match(gas.$mails[1].body, /Wiersze: 5 \(5 wierszy\)/);
    assert.match(gas.$mails[1].body, /Incydent trwał od: .* \(error\)/);
    assert.equal(record(gas).incident.open, false);
    assert.ok(record(gas).incident.closedAt);
  });

  test('ALERT_RECOVERY=FALSE wyłącza tylko e-mail zamykający', () => {
    const gas = loadProject({ sheets: sheets(), properties: { ...MAIL, ALERT_RECOVERY: 'FALSE' } });
    fail(gas);
    ok(gas);
    assert.equal(gas.$mails.length, 1);
    assert.equal(record(gas).incident.open, false, 'incident still closed');
  });

  test('udane importy bez incydentu nie wysyłają niczego', () => {
    const gas = loadProject({ sheets: sheets(), properties: MAIL });
    ok(gas); ok(gas);
    assert.equal(gas.$mails.length, 0);
    assert.equal(record(gas).incident, undefined);
  });

  test('bez ALERT_EMAIL incydent jest śledzony, ale nic nie jest wysyłane i nic nie rzuca', () => {
    const gas = loadProject({ sheets: sheets() });
    fail(gas);
    assert.equal(gas.$mails.length, 0);
    assert.equal(record(gas).incident.open, true);
    assert.equal(record(gas).incident.notifiedAt, '');
    ok(gas);
    assert.equal(gas.$mails.length, 0);
    assert.equal(record(gas).incident.open, false);
  });

  test('awaria MailApp nie zmienia wyniku importu: błąd importu nadal rzuca, sukces nadal wraca, incydent zapisany', () => {
    const gas = loadProject({ sheets: sheets(), properties: MAIL });
    gas.MailApp.sendEmail = () => { throw new Error('Service invoked too many times: email'); };
    fail(gas, 'HTTP 500 boom');
    assert.equal(record(gas).incident.open, true);
    assert.equal(record(gas).incident.notifiedAt, '', 'not marked as notified');
    const out = gas.recordImportRun_('GSC', true, () => ({ rows: 5, days: 1 }));
    assert.equal(plain(out).rows, 5, 'recovery mail failure does not fail the import');
    assert.equal(record(gas).incident.open, false);
    assert.equal(gas.$mails.length, 0);
  });

  test('incydent otwarty bez ALERT_EMAIL dostaje e-mail przy kolejnym błędzie, gdy adres się pojawi; potem cisza', () => {
    const gas = loadProject({ sheets: sheets() });
    fail(gas, 'HTTP 500 pierwszy');
    assert.equal(gas.$mails.length, 0);
    gas.$properties.ALERT_EMAIL = 'alerty@example.pl';
    fail(gas, 'HTTP 503 drugi');
    assert.equal(gas.$mails.length, 1);
    assert.match(gas.$mails[0].body, /Błąd: HTTP 503 drugi/);
    assert.ok(record(gas).incident.notifiedAt);
    fail(gas, 'HTTP 504 trzeci');
    assert.equal(gas.$mails.length, 1, 'silent once notified');
  });

  test('incydenty są niezależne per źródło', () => {
    const gas = loadProject({ sheets: sheets(), properties: MAIL });
    fail(gas, 'HTTP 500', 'GSC');
    ok(gas, 'GA4');
    assert.equal(gas.$mails.length, 1);
    assert.equal(record(gas, 'GSC').incident.open, true);
    assert.equal(record(gas, 'GA4').incident, undefined);
  });
});

describe('incydent: anomalia liczby wierszy', () => {
  const history = (n, rows) => Array.from({ length: n }, (_, i) => [new Date(Date.now() - (n - i) * 86400000), 'GSC', 'trigger', 1, 'OK', rows, 3, '', '']);

  test('anomalia otwiera incydent z jednym mailem, kolejne anomalie milczą, norma zamyka', () => {
    const s = sheets();
    s[LOG] = [HEADER, ...history(7, 300)];
    const gas = loadProject({ sheets: s, properties: MAIL });
    gas.recordImportRun_('GSC', true, () => ({ rows: 0, days: 1 }));
    assert.equal(gas.$mails.length, 1);
    assert.equal(gas.$mails[0].subject, '[wordpress-automation] UWAGA, mało danych: Search Console (GSC)');
    assert.match(gas.$mails[0].body, /Szczegóły: mało danych: 0 wierszy vs mediana 300/);
    assert.equal(record(gas).incident.reason, 'anomaly');

    gas.recordImportRun_('GSC', true, () => ({ rows: 1, days: 1 }));
    assert.equal(gas.$mails.length, 1, 'second anomaly is silent');

    gas.recordImportRun_('GSC', true, () => ({ rows: 300, days: 1 }));
    assert.equal(gas.$mails.length, 2);
    assert.match(gas.$mails[1].subject, /Import ponownie działa/);
  });

  test('błąd podczas otwartego incydentu anomalii nie wysyła kolejnego maila, zmienia powód', () => {
    const s = sheets();
    s[LOG] = [HEADER, ...history(7, 300)];
    const gas = loadProject({ sheets: s, properties: MAIL });
    gas.recordImportRun_('GSC', true, () => ({ rows: 0, days: 1 }));
    fail(gas);
    assert.equal(gas.$mails.length, 1);
    assert.equal(record(gas).incident.reason, 'error');
  });
});

describe('strażnik nieaktualnych danych', () => {
  function withRecords(gsc, ga4, props = MAIL) {
    return loadProject({
      sheets: sheets(),
      properties: {
        ...props,
        ...(gsc ? { LAST_IMPORT_GSC: JSON.stringify(gsc) } : {}),
        ...(ga4 ? { LAST_IMPORT_GA4: JSON.stringify(ga4) } : {})
      }
    });
  }
  const fresh = { lastOk: { finishedAt: hoursAgo(2), ok: true, rows: 5 }, lastRun: { finishedAt: hoursAgo(2), ok: true } };
  const stale = { lastOk: { finishedAt: hoursAgo(50), ok: true, rows: 5 }, lastRun: { finishedAt: hoursAgo(50), ok: true } };

  test('wszystko aktualne → brak maila, brak incydentów', () => {
    const gas = withRecords(fresh, fresh);
    const out = gas.sprawdzAktualnoscImportow();
    assert.deepEqual(counts(out), { opened: 0, closed: 0 });
    assert.equal(gas.$mails.length, 0);
  });

  test('dwa nieaktualne źródła → jeden zbiorczy e-mail i dwa incydenty stale', () => {
    const gas = withRecords(stale, null);
    const out = gas.sprawdzAktualnoscImportow();
    assert.deepEqual(counts(out), { opened: 2, closed: 0 });
    assert.equal(gas.$mails.length, 1);
    assert.equal(gas.$mails[0].subject, '[wordpress-automation] NIEAKTUALNE dane: 2 źródło(a)');
    assert.match(gas.$mails[0].body, /- Search Console \(GSC\): NIEAKTUALNE – ostatni import/);
    assert.match(gas.$mails[0].body, /- Google Analytics 4 \(GA4\): BRAK IMPORTU/);
    assert.equal(record(gas, 'GSC').incident.reason, 'stale');
    assert.equal(record(gas, 'GA4').incident.reason, 'stale');
    assert.ok(record(gas, 'GSC').incident.notifiedAt, 'notifiedAt set only after the mail went out');
    assert.ok(record(gas, 'GA4').incident.notifiedAt);
  });

  test('częściowy rekord z udanym lastRun bez lastOk jest świeży, tak jak w komórce statusu', () => {
    const gas = withRecords({ lastRun: { finishedAt: hoursAgo(3), ok: true, rows: 5 } }, fresh);
    const out = gas.sprawdzAktualnoscImportow();
    assert.deepEqual(counts(out), { opened: 0, closed: 0 });
    assert.equal(gas.$mails.length, 0);
  });

  test('otwarty incydent → strażnik milczy następnego dnia', () => {
    const gas = withRecords(stale, fresh);
    gas.sprawdzAktualnoscImportow();
    gas.sprawdzAktualnoscImportow();
    assert.equal(gas.$mails.length, 1);
  });

  test('dane znowu aktualne → incydent stale zamknięty z mailem; incydent error nie jest ruszany', () => {
    const gas = withRecords(
      { ...fresh, incident: { open: true, reason: 'stale', openedAt: hoursAgo(20), detail: 'x' } },
      { ...fresh, incident: { open: true, reason: 'error', openedAt: hoursAgo(1), detail: 'HTTP 500' } }
    );
    const out = gas.sprawdzAktualnoscImportow();
    assert.deepEqual(counts(out), { opened: 0, closed: 1 });
    assert.equal(gas.$mails.length, 1);
    assert.match(gas.$mails[0].subject, /Dane znowu aktualne: 1 źródło\(a\)/);
    assert.equal(record(gas, 'GSC').incident.open, false);
    assert.equal(record(gas, 'GA4').incident.open, true, 'error incident belongs to the import path');
  });

  test('bez ALERT_EMAIL strażnik działa bez maili; incydent bez e-maila dostaje go, gdy adres się pojawi', () => {
    const gas = withRecords(stale, fresh, {});
    const out = gas.sprawdzAktualnoscImportow();
    assert.deepEqual(counts(out), { opened: 1, closed: 0 });
    assert.equal(gas.$mails.length, 0);
    assert.equal(record(gas, 'GSC').incident.notifiedAt, '');

    gas.$properties.ALERT_EMAIL = 'alerty@example.pl';
    const again = gas.sprawdzAktualnoscImportow();
    assert.deepEqual(counts(again), { opened: 0, closed: 0 }, 'no new incident');
    assert.equal(gas.$mails.length, 1);
    assert.match(gas.$mails[0].subject, /NIEAKTUALNE dane: 1 źródło\(a\)/);
    assert.ok(record(gas, 'GSC').incident.notifiedAt);

    gas.sprawdzAktualnoscImportow();
    assert.equal(gas.$mails.length, 1, 'silent once notified');
  });

  test('gdy MailApp zawiedzie, incydent stale zostaje otwarty bez notifiedAt i strażnik nie rzuca', () => {
    const gas = withRecords(stale, fresh);
    gas.MailApp.sendEmail = () => { throw new Error('quota'); };
    const out = gas.sprawdzAktualnoscImportow();
    assert.deepEqual(counts(out), { opened: 1, closed: 0 });
    assert.equal(record(gas, 'GSC').incident.open, true);
    assert.equal(record(gas, 'GSC').incident.notifiedAt, '');
  });
});

describe('menu, trigger i okno statusu', () => {
  test('ustawCodzienneAlerty instaluje trigger o 08:00, zastępuje stary i informuje o adresacie', () => {
    const gas = loadProject({ sheets: sheets(), properties: MAIL, triggers: ['sprawdzAktualnoscImportow'] });
    gas.ustawCodzienneAlerty();
    const guards = gas.$triggers.filter(t => t.getHandlerFunction() === 'sprawdzAktualnoscImportow');
    assert.equal(guards.length, 1);
    assert.deepEqual(guards[0].$spec, { handler: 'sprawdzAktualnoscImportow', everyDays: 1, atHour: 8 });
    assert.match(gas.$alerts[0][0], /Alerty trafią na: alerty@example\.pl/);
  });

  test('bez ALERT_EMAIL instalacja ostrzega, że alerty nie będą wysyłane', () => {
    const gas = loadProject({ sheets: sheets() });
    gas.ustawCodzienneAlerty();
    assert.match(gas.$alerts[0][0], /brak Script Property ALERT_EMAIL/);
  });

  test('okno „Status danych” pokazuje incydent, adresata alertów i obecność strażnika', () => {
    const gas = loadProject({ sheets: sheets(), properties: MAIL, triggers: ['sprawdzAktualnoscImportow'] });
    fail(gas);
    gas.showImportStatus();
    const text = gas.$alerts[0][0];
    assert.match(text, /Incydent: OTWARTY od .* \(error\), e-mail wysłany/);
    const silent = loadProject({ sheets: sheets() });
    fail(silent);
    silent.showImportStatus();
    assert.match(silent.$alerts[0][0], /Incydent: OTWARTY od .* \(error\), bez e-maila\n/);
    assert.match(text, /Google Analytics 4 \(GA4\)\n[^\n]*\n[^\n]*\n {2}Incydent: brak/);
    assert.match(text, /Alerty e-mail: alerty@example\.pl \| strażnik: TAK/);
  });

  test('bez adresata okno mówi, że alerty są wyłączone', () => {
    const gas = loadProject({ sheets: sheets() });
    gas.showImportStatus();
    assert.match(gas.$alerts[0][0], /Alerty e-mail: wyłączone \(brak ALERT_EMAIL\) \| strażnik: NIE/);
  });
});

describe('#69: walidacja ALERT_EMAIL', () => {
  test('wartość niebędąca adresem (np. TRUE) jest pokazana wprost w oknie statusu i przy instalacji strażnika', () => {
    const gas = loadProject({ sheets: sheets(), properties: { ALERT_EMAIL: 'TRUE' } });
    gas.showImportStatus();
    assert.match(gas.$alerts[0][0], /Alerty e-mail: NIEPRAWIDŁOWY ADRES \(„TRUE”\) – popraw Script Property ALERT_EMAIL \| strażnik: NIE/);
    gas.ustawCodzienneAlerty();
    assert.match(gas.$alerts[1][0], /ALERT_EMAIL ma nieprawidłową wartość \(„TRUE”\), alerty nie będą wysyłane/);
  });

  test('przy nieprawidłowym adresie wysyłka nie jest próbowana, incydent zostaje bez e-maila', () => {
    const gas = loadProject({ sheets: sheets(), properties: { ALERT_EMAIL: 'TRUE' } });
    gas.MailApp.sendEmail = () => { throw new Error('must not be called'); };
    fail(gas);
    assert.equal(record(gas).incident.open, true);
    assert.equal(record(gas).incident.notifiedAt, '');
    assert.equal(gas.$mails.length, 0);
  });

  test('lista adresów rozdzielona przecinkami jest akceptowana, pojedynczy zły element ją unieważnia', () => {
    const gas = loadProject({ sheets: sheets() });
    assert.equal(gas.isValidEmailList_('a@example.pl, b.c@sub.example.org'), true);
    assert.equal(gas.isValidEmailList_('a@example.pl, TRUE'), false);
    assert.equal(gas.isValidEmailList_('bez-malpy.pl'), false);
    assert.equal(gas.isValidEmailList_(''), false);
    assert.equal(gas.isValidEmailList_('a@example.pl,'), false, 'trailing comma');
    assert.equal(gas.isValidEmailList_('a@example.pl,,b@example.pl'), false, 'double comma');
    assert.equal(gas.isValidEmailList_(',a@example.pl'), false, 'leading comma');
    assert.equal(gas.isValidEmailList_(' , '), false);
  });

  test('lista z przecinkiem na końcu jest traktowana jak zły adres, poprawna lista trafia do MailApp bez spacji', () => {
    const bad = loadProject({ sheets: sheets(), properties: { ALERT_EMAIL: 'a@example.pl,' } });
    bad.showImportStatus();
    assert.match(bad.$alerts[0][0], /NIEPRAWIDŁOWY ADRES \(„a@example\.pl,”\)/);
    fail(bad);
    assert.equal(bad.$mails.length, 0);

    const good = loadProject({ sheets: sheets(), properties: { ALERT_EMAIL: ' a@example.pl , b@example.pl ' } });
    fail(good);
    assert.equal(good.$mails.length, 1);
    assert.equal(good.$mails[0].to, 'a@example.pl,b@example.pl');
  });
});

describe('#69: strażnik z menu pokazuje wynik', () => {
  const fresh = { lastOk: { finishedAt: hoursAgo(2), ok: true, rows: 5 }, lastRun: { finishedAt: hoursAgo(2), ok: true } };
  const stale = { lastOk: { finishedAt: hoursAgo(50), ok: true, rows: 5 }, lastRun: { finishedAt: hoursAgo(50), ok: true } };
  const withRecords = (gsc, ga4, props = MAIL) => loadProject({
    sheets: sheets(),
    triggers: ['sprawdzAktualnoscImportow'],
    properties: { ...props, LAST_IMPORT_GSC: JSON.stringify(gsc), LAST_IMPORT_GA4: JSON.stringify(ga4) }
  });

  test('menu Dane wskazuje wariant z oknem, trigger nadal na funkcję bez okna', () => {
    const gas = loadProject({ sheets: sheets() });
    gas.onOpen();
    const dane = gas.$menus.find(m => m.title === 'Dane');
    assert.deepEqual(dane.items.map(i => i.fn), ['showImportStatus', 'refreshImportStatusCells', 'sprawdzAktualnoscImportowZMenu', 'ustawCodzienneAlerty']);
    gas.ustawCodzienneAlerty();
    assert.deepEqual(gas.$triggers.map(t => t.getHandlerFunction()), ['sprawdzAktualnoscImportow'], 'trigger stays on the silent handler');
  });

  test('wszystko aktualne → okno ze stanem obu źródeł, zerowymi licznikami i „e-mail niepotrzebny”', () => {
    const gas = withRecords(fresh, fresh);
    gas.sprawdzAktualnoscImportowZMenu();
    const text = gas.$alerts[0][0];
    assert.match(text, /^Sprawdzono aktualność importów:\n- Search Console \(GSC\): AKTYWNE – ostatni import: .*\n- Google Analytics 4 \(GA4\): AKTYWNE – .*\n\nOtwarte incydenty \(nieaktualne dane\): 0\nZamknięte incydenty \(dane znowu aktualne\): 0\nE-mail: niepotrzebny \(bez zmian\)\nAdresat: alerty@example\.pl$/);
    assert.equal(gas.$mails.length, 0);
  });

  test('nieaktualne źródło → okno mówi, że e-mail wyszedł i jaki', () => {
    const gas = withRecords(stale, fresh);
    gas.sprawdzAktualnoscImportowZMenu();
    assert.match(gas.$alerts[0][0], /Otwarte incydenty \(nieaktualne dane\): 1\n.*\nE-mail: wysłany \(„NIEAKTUALNE dane: 1 źródło\(a\)”\)/);
    assert.equal(gas.$mails.length, 1);
  });

  test('nieaktualne źródło bez adresu → okno podaje powód niewysłania', () => {
    const gas = withRecords(stale, fresh, {});
    gas.sprawdzAktualnoscImportowZMenu();
    assert.match(gas.$alerts[0][0], /E-mail: nie wysłano \(„NIEAKTUALNE dane: 1 źródło\(a\)”\): brak Script Property ALERT_EMAIL\nAdresat: wyłączone \(brak ALERT_EMAIL\)/);
  });

  test('błędny adres → okno podaje nieprawidłowy adres jako powód', () => {
    const gas = withRecords(stale, fresh, { ALERT_EMAIL: 'TRUE' });
    gas.sprawdzAktualnoscImportowZMenu();
    assert.match(gas.$alerts[0][0], /E-mail: nie wysłano \(„NIEAKTUALNE dane: 1 źródło\(a\)”\): nieprawidłowy adres w ALERT_EMAIL \(„TRUE”\)/);
  });

  test('awaria MailApp → okno cytuje komunikat błędu', () => {
    const gas = withRecords(stale, fresh);
    gas.MailApp.sendEmail = () => { throw new Error('Service invoked too many times: email'); };
    gas.sprawdzAktualnoscImportowZMenu();
    assert.match(gas.$alerts[0][0], /E-mail: nie wysłano \(„NIEAKTUALNE dane: 1 źródło\(a\)”\): Service invoked too many times: email/);
  });

  test('zamknięcie incydentu stale przy ALERT_RECOVERY=FALSE → okno mówi, że mail o powrocie został pominięty', () => {
    const gas = withRecords(
      { ...fresh, incident: { open: true, reason: 'stale', openedAt: hoursAgo(20), detail: 'x', notifiedAt: hoursAgo(20) } },
      fresh,
      { ...MAIL, ALERT_RECOVERY: 'FALSE' }
    );
    gas.sprawdzAktualnoscImportowZMenu();
    assert.match(gas.$alerts[0][0], /Zamknięte incydenty \(dane znowu aktualne\): 1\nE-mail: pominięty \(„Dane znowu aktualne: 1 źródło\(a\)”\): ALERT_RECOVERY=FALSE\n/);
    assert.equal(gas.$mails.length, 0);
    assert.equal(record(gas).incident.open, false);
  });

  test('zamknięcie incydentu stale → okno mówi o mailu o powrocie; oba maile w jednym przebiegu są wymienione', () => {
    const gas = withRecords(
      { ...fresh, incident: { open: true, reason: 'stale', openedAt: hoursAgo(20), detail: 'x', notifiedAt: hoursAgo(20) } },
      stale
    );
    gas.sprawdzAktualnoscImportowZMenu();
    assert.match(gas.$alerts[0][0], /Otwarte incydenty \(nieaktualne dane\): 1\nZamknięte incydenty \(dane znowu aktualne\): 1\nE-mail: wysłany \(„NIEAKTUALNE dane: 1 źródło\(a\)”\); wysłany \(„Dane znowu aktualne: 1 źródło\(a\)”\)/);
    assert.equal(gas.$mails.length, 2);
  });
});

describe('#69: import dzienny z menu jest ręczny, z triggera jest triggerem', () => {
  const HEADER_LOG = ['Czas', 'Źródło', 'Typ', 'Dni', 'Wynik', 'Wiersze', 'Czas [s]', 'Szczegóły', 'Błąd / uwaga'];
  const withRaw = () => {
    const s = sheets();
    s['GSC RAW'] = [['date']];
    s['IMPORT LOG'] = [HEADER_LOG];
    return s;
  };

  test('GSC: bez obiektu zdarzenia (menu) → ręczne; z triggerUid → trigger', () => {
    const gas = loadProject({ sheets: withRaw(), fetch: () => ({ code: 200, json: { rows: [] } }) });
    gas.importDzienny();
    assert.equal(record(gas).lastRun.trigger, false);
    assert.equal(gas.$sheet('IMPORT LOG')[1][2], 'ręczny');
    gas.importDzienny({ triggerUid: '123', authMode: 'FULL' });
    assert.equal(record(gas).lastRun.trigger, true);
    assert.equal(gas.$sheet('IMPORT LOG')[2][2], 'trigger');
  });

  test('GA4: to samo rozpoznanie; błąd z menu też jest ręczny', () => {
    const gas = loadProject({ sheets: sheets() });
    assert.throws(() => gas.importGA4Dzienny(), /propertyId|GA4/);
    assert.equal(record(gas, 'GA4').lastRun.trigger, false);
    assert.throws(() => gas.importGA4Dzienny({ triggerUid: '9' }), /propertyId|GA4/);
    assert.equal(record(gas, 'GA4').lastRun.trigger, true);
  });

  test('isTriggerRun_ odrzuca brak argumentu, prymitywy i obiekty bez triggerUid', () => {
    const gas = loadProject({ sheets: sheets() });
    assert.equal(gas.isTriggerRun_(), false);
    assert.equal(gas.isTriggerRun_(null), false);
    assert.equal(gas.isTriggerRun_('x'), false);
    assert.equal(gas.isTriggerRun_({ authMode: 'FULL' }), false);
    assert.equal(gas.isTriggerRun_({ triggerUid: 'a' }), true);
    assert.equal(gas.isTriggerRun_({ 'trigger-uid': 'a' }), true);
  });

  test('e-mail otwierający incydent mówi „ręczne” dla importu z menu', () => {
    const gas = loadProject({ sheets: sheets(), properties: MAIL, fetch: () => ({ code: 500, text: 'boom' }) });
    assert.throws(() => gas.importDzienny(), /HTTP 500/);
    assert.match(gas.$mails[0].body, /Uruchomienie: ręczne/);
  });
});
