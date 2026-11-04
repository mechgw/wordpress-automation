'use strict';

/**
 * #287: spłata po metodach - rejestr zadań, menu, teksty statusu, odmowy i flagi
 * w `Status.gs`. Zbiegłe mutanty z pilotażu #234: etykiety i handlery menu,
 * definicje źródeł i zadań, teksty statusu i okna, przejmowanie odmów blokady,
 * odczyt rekordów i flag zapisu.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const projekt = (opcje = {}) => loadProject(Object.assign({ properties: { ALERT_EMAIL: 'alerty@example.pl' } }, opcje));

describe('#287: rejestr źródeł i zadań', () => {
  test('importSources_: dokładne definicje GSC i GA4', () => {
    const gas = projekt();

    assert.deepEqual(plain(gas.importSources_()), {
      GSC: { key: 'LAST_IMPORT_GSC', label: 'Search Console (GSC)', sheet: 'Konfiguracja GSC', cell: 'B8', trigger: 'importDzienny', schedule: 'codziennie ok. 05:00' },
      GA4: { key: 'LAST_IMPORT_GA4', label: 'Google Analytics 4 (GA4)', sheet: 'Konfiguracja GA4', cell: 'B9', trigger: 'importGA4Dzienny', schedule: 'codziennie ok. 06:00' }
    });
  });

  test('scheduledJobs_: dokładny rejestr zadań cyklicznych', () => {
    const gas = projekt();
    const tydzien = 8 * 24;

    assert.deepEqual(plain(gas.scheduledJobs_()), [
      { key: 'GSC', handler: 'importDzienny', label: 'import GSC', schedule: 'codziennie ok. 05:00', prop: 'LAST_IMPORT_GSC', staleAfterHours: 36 },
      { key: 'GA4', handler: 'importGA4Dzienny', label: 'import GA4', schedule: 'codziennie ok. 06:00', prop: 'LAST_IMPORT_GA4', staleAfterHours: 36 },
      { key: 'ALERTS', handler: 'sprawdzAktualnoscImportow', label: 'strażnik alertów', schedule: 'codziennie ok. 08:00', prop: 'LAST_RUN_ALERTS', staleAfterHours: 36 },
      { key: 'SITEMAP_URLS', handler: 'odswiezMonitoringZSitemapTrigger', label: 'adresy z sitemap', schedule: 'poniedziałek ok. 06:00', prop: 'LAST_RUN_SITEMAP_URLS', staleAfterHours: tydzien, optional: true },
      { key: 'URL_INSPECTION', handler: 'sprawdzIndeksowanieTrigger', label: 'inspekcja URL', schedule: 'poniedziałek ok. 07:00', prop: 'LAST_RUN_URL_INSPECTION', staleAfterHours: tydzien, optional: true },
      { key: 'SEO_LIVE', handler: 'sprawdzStronyLiveTrigger', label: 'live check SEO', schedule: 'codziennie ok. 09:00', prop: 'LAST_RUN_SEO_LIVE', staleAfterHours: 36, optional: true },
      { key: 'RECRAWL', handler: 'kolejkaRecrawlTrigger', label: 'kolejka recrawl', schedule: 'codziennie ok. 10:00', prop: 'LAST_RUN_RECRAWL', staleAfterHours: 36, optional: true },
      { key: 'PERFORMANCE', handler: 'pomiarWydajnosciCykliczny', label: 'pomiar wydajności', schedule: 'co 6 godz. (interwał konfigurowalny)', prop: 'LAST_RUN_PERFORMANCE', staleAfterHours: 36, optional: true, log: true },
      { key: 'GBP', handler: 'importBusinessProfileTrigger', label: 'Business Profile (GBP)', lockLabel: 'import Business Profile', schedule: 'codziennie ok. 11:00', prop: 'LAST_RUN_GBP', staleAfterHours: 36, optional: true, log: true }
    ]);
  });

  test('menu "Dane": dokładne etykiety i handlery', () => {
    const gas = projekt();

    gas.addStatusMenu_();

    const menu = gas.$menus.find(m => m.title === 'Dane');
    assert.deepEqual(plain(menu.items.map(i => [i.label, i.fn])), [
      ['Status danych', 'showImportStatus'],
      ['Odśwież status w komórkach', 'refreshImportStatusCells'],
      ['Sprawdź aktualność teraz (alerty)', 'sprawdzAktualnoscImportowZMenu'],
      ['Włącz codzienne alerty e-mail', 'ustawCodzienneAlerty'],
      ['Diagnostyka systemu (tylko odczyt)', 'diagnostykaSystemu'],
      ['Zajętość arkusza', 'pokazZajetoscArkusza'],
      ['Wyczyść stare snapshoty, wyniki i próby PSI', 'wyczyscStareSnapshotyIWyniki'],
      ['Przytnij puste wiersze', 'przytnijPusteWiersze'],
      ['Kanonizuj znaczniki Pomiar', 'kanonizujZnacznikiPomiaru'],
      ['Przygotuj rejestr zapytań telefonicznych', 'przygotujRejestrZapytanTelefonicznych'],
      ['Uporządkuj arkusze', 'uporzadkujArkuszeZMenu'],
      ['Ukryj arkusze techniczne', 'ukryjArkuszeTechniczne'],
      ['Pokaż arkusze techniczne', 'pokazArkuszeTechniczne']
    ]);
  });
});

describe('#287: teksty statusu', () => {
  const iso = (gas, ago) => new Date(gas.$Date.now() - ago).toISOString();

  test('importStatusText_: nieaktualny import zaczyna się od "NIEAKTUALNE" bez "AKTYWNE"', () => {
    const gas = projekt();
    const run = { finishedAt: iso(gas, 100 * HOUR), ok: true, rows: 12 };
    gas.$properties.LAST_IMPORT_GSC = JSON.stringify({ lastRun: run, lastOk: run });

    const tekst = gas.importStatusText_('GSC');

    assert.match(tekst, /^NIEAKTUALNE – ostatni import: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| 12 wierszy \| trigger: (TAK|NIE)$/);
  });

  test('jobStatusText_: stany zadania bez przebiegu', () => {
    const gas = projekt({ triggers: ['sprawdzIndeksowanieTrigger'] });
    const z = (record, trigger) => {
      gas.$properties.LAST_RUN_URL_INSPECTION = JSON.stringify(record);
      gas.hasImportTrigger_ = () => trigger;
      return gas.jobStatusText_('URL_INSPECTION', new gas.$Date());
    };

    assert.equal(z({ waitingSince: new Date().toISOString() }, true), 'BRAK PRZEBIEGU – zadanie jest włączone i czeka na pierwszy przebieg | trigger: TAK');
    assert.equal(z({ waitingSince: new Date().toISOString() }, false), 'BRAK PRZEBIEGU – uruchom zadanie z menu | trigger: NIE');
    assert.equal(z({}, true), 'BRAK PRZEBIEGU – uruchom zadanie z menu | trigger: TAK');
  });

  test('jobStatusText_: błąd z ostatnim poprawnym przebiegiem i bez, aktywne z opisem i bez, nieaktualne', () => {
    const gas = projekt();
    gas.hasImportTrigger_ = () => true;
    const teraz = new gas.$Date();
    const czas = ago => new Date(teraz.getTime() - ago).toISOString();
    const fmt = i => gas.formatImportTime_(i);
    const z = record => { gas.$properties.LAST_RUN_URL_INSPECTION = JSON.stringify(record); return gas.jobStatusText_('URL_INSPECTION', teraz); };
    const ok = { finishedAt: czas(2 * HOUR), ok: true, detail: 'sprawdzone: 5' };
    const blad = { finishedAt: czas(HOUR), ok: false, error: 'boom' };

    assert.equal(z({ lastRun: blad, lastOk: ok }), 'BŁĄD ' + fmt(blad.finishedAt) + ': boom | ostatni poprawny przebieg: ' + fmt(ok.finishedAt) + ' | trigger: TAK');
    assert.equal(z({ lastRun: blad }), 'NIEAKTUALNE – BŁĄD ' + fmt(blad.finishedAt) + ': boom | brak poprawnego przebiegu | trigger: TAK');
    assert.equal(z({ lastRun: ok, lastOk: ok }), 'AKTYWNE – ostatni przebieg: ' + fmt(ok.finishedAt) + ' | sprawdzone: 5 | trigger: TAK');
    const bezOpisu = { finishedAt: czas(2 * HOUR), ok: true };
    assert.equal(z({ lastRun: bezOpisu, lastOk: bezOpisu }), 'AKTYWNE – ostatni przebieg: ' + fmt(bezOpisu.finishedAt) + ' | trigger: TAK');
    const stary = { finishedAt: czas(400 * HOUR), ok: true, detail: 'x' };
    assert.equal(z({ lastRun: stary, lastOk: stary }), 'NIEAKTUALNE – ostatni przebieg: ' + fmt(stary.finishedAt) + ' | x | trigger: TAK');
  });

  test('isTriggerRun_: obiekt zdarzenia z triggerUid albo trigger-uid; wszystko inne to ręczne', () => {
    const gas = projekt();

    assert.equal(gas.isTriggerRun_({ triggerUid: 'a' }), true);
    assert.equal(gas.isTriggerRun_({ 'trigger-uid': 'a' }), true);
    assert.equal(gas.isTriggerRun_({}), false);
    assert.equal(gas.isTriggerRun_(undefined), false);
    assert.equal(gas.isTriggerRun_('triggerUid'), false);
    assert.equal(gas.isTriggerRun_(null), false);
  });

  test('importStageTimer_: czas etapu to różnica, nie suma znaczników czasu', () => {
    const gas = projekt();

    const stage = gas.importStageTimer_('test');
    stage('pierwszy');

    const linia = gas.$console.map(([, t]) => t).find(t => t.startsWith('[test] pierwszy: '));
    const m = /pierwszy: (\d+) ms \(od startu (\d+) ms\)/.exec(linia);
    assert.ok(m && Number(m[1]) < 10000 && Number(m[2]) < 10000, linia);
  });
});

describe('#287: okno "Status danych"', () => {
  test('linie ostatniego uruchomienia i objaśnienia', () => {
    const gas = projekt();
    const teraz = gas.$Date.now();
    const run = ok => ({ finishedAt: new Date(teraz - HOUR).toISOString(), ok, trigger: ok, rows: 1, durationMs: 2500, error: 'x' });
    gas.$properties.LAST_IMPORT_GSC = JSON.stringify({ lastRun: run(true), lastOk: run(true) });
    gas.$properties.LAST_IMPORT_GA4 = JSON.stringify({ lastRun: run(false) });

    gas.showImportStatus();

    const tekst = gas.$alerts[0][0];
    assert.match(tekst, /Ostatnie uruchomienie: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| OK \| trigger \| 3 s/);
    assert.match(tekst, /Ostatnie uruchomienie: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| BŁĄD \| ręcznie \| 3 s/);
    assert.ok(tekst.includes('\n\nZadanie jest nieaktualne po upływie własnego progu od ostatniego poprawnego przebiegu.\n'));
    assert.ok(tekst.includes('Zadanie monitorujące bez triggera, które nigdy nie działało, nie jest zgłaszane jako awaria.\n' + gas.sheetUsageLine_() + '\n'));
    assert.ok(!tekst.includes('Stryker'));
    assert.ok(tekst.includes('Harmonogram: codziennie ok. 05:00 (Konfiguracja GSC!B8) | nieaktualne po 36 h'));
  });
});

describe('#287: odczyt rekordów i flag', () => {
  test('readJobRecord_: brak, błąd składni i wartości nieobiektowe to pusty rekord', () => {
    const gas = projekt();
    const rekord = surowy => { if (surowy === undefined) delete gas.$properties.LAST_IMPORT_GSC; else gas.$properties.LAST_IMPORT_GSC = surowy; return plain(gas.readJobRecord_('GSC')); };

    assert.deepEqual(rekord(undefined), {});
    assert.deepEqual(rekord(''), {});
    assert.deepEqual(rekord('{zły'), {});
    assert.deepEqual(rekord('5'), {});
    assert.deepEqual(rekord('"napis"'), {});
    assert.deepEqual(rekord('true'), {});
    assert.deepEqual(rekord('null'), {});
    assert.deepEqual(rekord('{"a":1}'), { a: 1 });
  });

  test('readWriteFlagState_: to samo dla stanu flag zapisu', () => {
    const gas = projekt();
    const stan = surowy => { if (surowy === undefined) delete gas.$properties.WRITE_FLAGS_SINCE; else gas.$properties.WRITE_FLAGS_SINCE = surowy; return plain(gas.readWriteFlagState_()); };

    assert.deepEqual(stan(undefined), {});
    assert.deepEqual(stan(''), {});
    assert.deepEqual(stan('{zły'), {});
    assert.deepEqual(stan('5'), {});
    assert.deepEqual(stan('"napis"'), {});
    assert.deepEqual(stan('true'), {});
    assert.deepEqual(stan('null'), {});
    assert.deepEqual(stan('{"WP_DRY_RUN":"2026-10-01T00:00:00.000Z"}'), { WP_DRY_RUN: '2026-10-01T00:00:00.000Z' });
  });

  test('observeWriteFlags_: zapis tylko przy zmianie, znacznik czasu z podanego now, wyłączenie kasuje wpis', () => {
    const gas = projekt();
    const now = new gas.$Date('2026-10-20T10:00:00Z');
    const zapisy = () => gas.$events.filter(e => e[0] === 'setProperty' && e[1] === 'WRITE_FLAGS_SINCE').length;

    assert.deepEqual(plain(gas.observeWriteFlags_(now)), {});
    assert.equal(zapisy(), 0, 'bez flag nic nie jest zapisywane');

    gas.$properties.WP_ALLOW_WRITES = 'TRUE';
    assert.deepEqual(plain(gas.observeWriteFlags_(now)), { WP_ALLOW_WRITES: '2026-10-20T10:00:00.000Z' });
    assert.equal(zapisy(), 1);
    gas.observeWriteFlags_(new gas.$Date('2026-10-21T10:00:00Z'));
    assert.equal(zapisy(), 1, 'ta sama flaga nie nadpisuje znacznika');
    assert.equal(JSON.parse(gas.$properties.WRITE_FLAGS_SINCE).WP_ALLOW_WRITES, '2026-10-20T10:00:00.000Z');

    gas.$properties.WP_ALLOW_WRITES = 'FALSE';
    assert.deepEqual(plain(gas.observeWriteFlags_(now)), {});
    assert.equal(zapisy(), 2);
  });

  test('observeWriteFlags_ bez parametru now używa bieżącego czasu', () => {
    const gas = projekt();
    gas.$properties.WP_DRY_RUN = 'TRUE';

    const stan = plain(gas.observeWriteFlags_());

    assert.ok(Math.abs(Date.parse(stan.WP_DRY_RUN) - Date.now()) < 60 * 1000);
  });

  test('daysSince_: pełne dni, brak i nieczytelna data to 0, przyszłość to 0', () => {
    const gas = projekt();
    const now = new gas.$Date('2026-10-20T10:00:00Z');

    assert.equal(gas.daysSince_('2026-10-17T09:00:00Z', now), 3);
    assert.equal(gas.daysSince_('2026-10-19T11:00:00Z', now), 0);
    assert.equal(gas.daysSince_('', now), 0);
    assert.equal(gas.daysSince_('nie data', now), 0);
    assert.equal(gas.daysSince_(undefined, now), 0);
    assert.equal(gas.daysSince_('2026-11-01T00:00:00Z', now), 0);
  });

  test('importRangeKey_: klucz tylko z obu końców zakresu', () => {
    const gas = projekt();

    assert.equal(gas.importRangeKey_({ dataFrom: '2026-10-01', dataTo: '2026-10-03' }), '2026-10-01..2026-10-03');
    assert.equal(gas.importRangeKey_({ dataFrom: '2026-10-01' }), '');
    assert.equal(gas.importRangeKey_({ dataTo: '2026-10-03' }), '');
    assert.equal(gas.importRangeKey_({}), '');
    assert.equal(gas.importRangeKey_(null), '');
    assert.equal(gas.importRangeKey_(undefined), '');
  });

  test('importLogCutoff_: bez now liczy od bieżącej chwili, z now od podanej', () => {
    const gas = projekt();
    const now = new gas.$Date('2026-10-20T10:00:00Z');

    assert.equal(gas.importLogCutoff_(now), now.getTime() - 90 * 86400 * 1000);
    assert.ok(Math.abs(gas.importLogCutoff_() - (Date.now() - 90 * 86400 * 1000)) < 60 * 1000);
  });
});

describe('#287: odmowy blokady (pendingRuns_, recordPendingRun_, takeOverPendingRuns_)', () => {
  const LOG = 'IMPORT LOG';
  const NAZWA = 'PENDING_RUN_GA4_a';
  const wpis = (gas, nazwa, at, extra = {}) => {
    gas.$properties[nazwa] = JSON.stringify(Object.assign({ job: 'GA4', id: nazwa, at, trigger: true, error: 'odmowa' }, extra));
  };
  const logi = gas => (gas.$sheet(LOG) || []).slice(1).filter(r => String(r[1] || '') !== '');
  const rekord = gas => JSON.parse(gas.$properties.LAST_IMPORT_GA4 || '{}');
  const iso = (gas, ago) => new Date(gas.$Date.now() - ago).toISOString();

  test('recordPendingRun_: pole error z wiadomością albo pustym napisem', () => {
    const gas = projekt();

    gas.recordPendingRun_('GA4', 'zajęte');
    gas.recordPendingRun_('GA4');

    const wpisy = Object.keys(gas.$properties).filter(k => k.indexOf('PENDING_RUN_GA4_') === 0).map(k => JSON.parse(gas.$properties[k]));
    assert.deepEqual(wpisy.map(w => w.error).sort(), ['', 'zajęte']);
    assert.ok(wpisy.every(w => w.job === 'GA4' && w.trigger === true && !isNaN(Date.parse(w.at))));
  });

  test('pendingRuns_: tylko klucze z prefiksem, czytelne, znanego zadania i daty, od najstarszego', () => {
    const gas = projekt();
    wpis(gas, 'PENDING_RUN_GA4_nowszy', iso(gas, MIN));
    wpis(gas, 'PENDING_RUN_GA4_starszy', iso(gas, 5 * MIN));
    wpis(gas, 'INNA_GA4_a', iso(gas, 3 * MIN));
    gas.$properties.PENDING_RUN_GA4_zly = '{niepoprawny';
    wpis(gas, 'PENDING_RUN_X_a', iso(gas, 3 * MIN), { job: 'NIEZNANE' });
    wpis(gas, 'PENDING_RUN_GA4_baddata', 'nie data');

    assert.deepEqual(plain(gas.pendingRuns_().map(f => f.name)), ['PENDING_RUN_GA4_starszy', 'PENDING_RUN_GA4_nowszy']);
  });

  test('bez parametru own wszystkie wpisy są przejmowane; wpis znika, ślad w logu z typem trigger i błędem ucietym do 300', () => {
    const gas = projekt();
    wpis(gas, NAZWA, iso(gas, 5 * MIN), { error: 'x'.repeat(500) });
    wpis(gas, 'PENDING_RUN_GA4_b', iso(gas, 4 * MIN), { error: undefined });

    gas.takeOverPendingRuns_();

    assert.deepEqual(Object.keys(gas.$properties).filter(k => k.indexOf('PENDING_RUN_') === 0), []);
    const wiersze = logi(gas);
    assert.equal(wiersze.length, 2);
    assert.equal(wiersze[0][2], 'trigger');
    assert.equal(wiersze[0][4], 'BŁĄD');
    assert.equal(String(wiersze[0][8]).length, 300);
    assert.equal(wiersze[1][8], '');
  });

  test('odmowa późniejsza niż przebieg przejmującego czeka; wcześniejsza jest przejmowana', () => {
    const gas = projekt();
    const own = { key: 'GA4', run: { finishedAt: iso(gas, 2 * MIN), ok: true } };
    wpis(gas, 'PENDING_RUN_GA4_pozniej', iso(gas, MIN));
    wpis(gas, 'PENDING_RUN_GA4_wczesniej', iso(gas, 5 * MIN));

    gas.takeOverPendingRuns_(own);

    assert.deepEqual(Object.keys(gas.$properties).filter(k => k.indexOf('PENDING_RUN_') === 0), ['PENDING_RUN_GA4_pozniej']);
  });

  test('udany przebieg tego samego zadania nie później niż odmowa: odmowa tylko w logu, rekord bez zmian', () => {
    const gas = projekt();
    const at = iso(gas, 3 * MIN);
    const own = { key: 'GA4', run: { finishedAt: at, ok: true } };
    gas.$properties.LAST_IMPORT_GA4 = JSON.stringify({ lastRun: { finishedAt: at, ok: true } });
    wpis(gas, NAZWA, at);

    gas.takeOverPendingRuns_(own);

    assert.equal(logi(gas).length, 1, 'wiersz odmowy');
    assert.equal(rekord(gas).lastRun.ok, true);
    assert.equal(rekord(gas).incident, undefined);
  });

  test('przebieg innego zadania albo nieudany nie wygasza odmowy', () => {
    const gas = projekt();
    const at = iso(gas, 3 * MIN);
    wpis(gas, NAZWA, at);

    gas.takeOverPendingRuns_({ key: 'GSC', run: { finishedAt: iso(gas, MIN), ok: true } });
    assert.equal(rekord(gas).lastRun.ok, false, 'inne zadanie: odmowa zapisana jako rekord');

    wpis(gas, 'PENDING_RUN_GA4_b', at);
    gas.takeOverPendingRuns_({ key: 'GA4', run: { finishedAt: iso(gas, MIN), ok: false } });
    assert.equal(rekord(gas).lastRun.ok, false);
  });

  test('rekord nowszy niż odmowa nie jest cofany; rekord z tą samą odmową dokańcza się bez ponownego zapisu', () => {
    const gas = projekt();
    const at = iso(gas, 3 * MIN);
    const nowszy = { finishedAt: iso(gas, MIN), ok: true };
    gas.$properties.LAST_IMPORT_GA4 = JSON.stringify({ lastRun: nowszy });
    wpis(gas, NAZWA, at);

    gas.takeOverPendingRuns_();

    assert.equal(rekord(gas).lastRun.ok, true, 'nowszy przebieg zostaje');
    assert.equal(rekord(gas).incident, undefined);

    const gas2 = projekt();
    const dokladnie = { finishedAt: at, ok: false, trigger: true, error: 'odmowa' };
    gas2.$properties.LAST_IMPORT_GA4 = JSON.stringify({ lastRun: dokladnie });
    wpis(gas2, NAZWA, at);

    gas2.takeOverPendingRuns_();

    assert.equal(rekord(gas2).lastRun.error, 'odmowa');
    assert.equal(rekord(gas2).incident.open, true, 'incydent dokończony');
  });

  test('rekord z inną odmową tego samego czasu (inny tekst) nie jest uznany za niedokończone przejęcie', () => {
    const gas = projekt();
    const at = iso(gas, 3 * MIN);
    gas.$properties.LAST_IMPORT_GA4 = JSON.stringify({ lastRun: { finishedAt: at, ok: false, error: 'inny tekst' } });
    wpis(gas, NAZWA, at);

    gas.takeOverPendingRuns_();

    assert.equal(rekord(gas).lastRun.error, 'inny tekst', 'nowsza-lub-równa odmowa nie nadpisuje rekordu');
  });

  test('bez rekordu: odmowa zapisuje rekord i incydent z błędem', () => {
    const gas = projekt();
    wpis(gas, NAZWA, iso(gas, 3 * MIN));

    gas.takeOverPendingRuns_();

    assert.equal(rekord(gas).lastRun.ok, false);
    assert.equal(rekord(gas).lastRun.error, 'odmowa');
    assert.equal(rekord(gas).incident.reason, 'error');
  });

  test('błąd przejęcia zostawia wpis i loguje nazwę oraz wiadomość', () => {
    const gas = projekt();
    const wpisy = [];
    gas.Logger = { log: m => wpisy.push(m) };
    wpis(gas, NAZWA, iso(gas, 3 * MIN));
    gas.appendImportLog_ = () => { throw new Error('arkusz niedostępny'); };

    gas.takeOverPendingRuns_();

    assert.ok(NAZWA in gas.$properties, 'wpis zostaje');
    assert.deepEqual(wpisy, ['Wpis oczekujący ' + NAZWA + ' czeka na kolejne przejęcie: arkusz niedostępny']);
    gas.appendImportLog_ = () => { throw 'napis'; };
    gas.takeOverPendingRuns_();
    assert.equal(wpisy[1], 'Wpis oczekujący ' + NAZWA + ' czeka na kolejne przejęcie: napis');
  });
});
