'use strict';

/**
 * #99: monitoring świeżości obejmuje wszystkie zadania cykliczne, nie tylko
 * importy. Zadanie, które przestało działać, było dotąd nieodróżnialne od
 * zadania, które nie ma nic do zgłoszenia.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const MAIL = { ALERT_EMAIL: 'alerty@example.pl' };
const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString();
const jobRecord = (gas, prop) => JSON.parse(gas.$properties[prop]);
const counts = out => ({ opened: plain(out).opened, closed: plain(out).closed });

/** Rekord udanego przebiegu sprzed `h` godzin, tak jak zapisuje go recordJobRun_. */
const ranHoursAgo = h => JSON.stringify({
  lastRun: { finishedAt: hoursAgo(h), ok: true, trigger: true, detail: 'przebieg' },
  lastOk: { finishedAt: hoursAgo(h), ok: true, trigger: true, detail: 'przebieg' }
});

describe('#99: recordJobRun_ zapisuje przebieg zadania monitorującego', () => {
  test('sukces zapisuje lastRun i lastOk, a wynik funkcji wraca nietknięty', () => {
    const gas = loadProject({});
    const out = gas.recordJobRun_('SEO_LIVE', true, () => ({ detail: '3 rozbieżności', own: 1 }));
    assert.equal(plain(out).own, 1, 'wynik zadania nie jest przesłaniany przez zapis');
    const rec = jobRecord(gas, 'LAST_RUN_SEO_LIVE');
    assert.equal(rec.lastRun.ok, true);
    assert.equal(rec.lastRun.detail, '3 rozbieżności');
    assert.equal(rec.lastOk.finishedAt, rec.lastRun.finishedAt);
  });

  test('błąd jest zapisany i rzucony dalej, a poprzedni udany przebieg zostaje', () => {
    const gas = loadProject({ properties: { LAST_RUN_SEO_LIVE: ranHoursAgo(2) } });
    const previous = jobRecord(gas, 'LAST_RUN_SEO_LIVE').lastOk.finishedAt;
    assert.throws(() => gas.recordJobRun_('SEO_LIVE', true, () => { throw new Error('GSC API HTTP 500'); }), /HTTP 500/);
    const rec = jobRecord(gas, 'LAST_RUN_SEO_LIVE');
    assert.equal(rec.lastRun.ok, false);
    assert.match(rec.lastRun.error, /HTTP 500/);
    assert.equal(rec.lastOk.finishedAt, previous, 'ostatni poprawny przebieg nie jest kasowany przez błąd');
  });
});

describe('#99: strażnik obejmuje zadania monitorujące', () => {
  test('zadanie z triggerem, które dawno nie działało, otwiera incydent i idzie w mailu', () => {
    const gas = loadProject({
      properties: Object.assign({}, MAIL, { LAST_RUN_RECRAWL: ranHoursAgo(80) }),
      triggers: ['kolejkaRecrawlTrigger']
    });
    const out = gas.sprawdzAktualnoscImportow();
    assert.equal(counts(out).opened, 3, "dwa importy bez historii plus przeterminowana kolejka recrawl");
    assert.equal(gas.$mails.length, 1);
    assert.match(gas.$mails[0].body, /- kolejka recrawl: NIEAKTUALNE/);
    assert.equal(jobRecord(gas, 'LAST_RUN_RECRAWL').incident.reason, 'stale');
  });

  test('opcjonalne zadanie bez triggera i bez historii nie jest incydentem', () => {
    const gas = loadProject({ properties: MAIL });
    const out = gas.sprawdzAktualnoscImportow();
    // Otwierają się tylko incydenty importów; cztery zadania monitorujące są
    // nieużywane, więc milczą.
    assert.equal(counts(out).opened, 2, "tylko importy: zadania monitorujące są nieużywane");
    assert.equal(gas.$properties.LAST_RUN_RECRAWL, undefined);
    assert.doesNotMatch(gas.$mails[0].body, /kolejka recrawl/);
  });

  test('opcjonalne zadanie z zainstalowanym triggerem, które nigdy nie działało, jest incydentem', () => {
    const gas = loadProject({ properties: MAIL, triggers: ['kolejkaRecrawlTrigger'] });
    const out = gas.sprawdzAktualnoscImportow();
    assert.equal(counts(out).opened, 3, 'dwa importy plus włączona kolejka recrawl');
    assert.match(gas.$mails[0].body, /- kolejka recrawl: BRAK PRZEBIEGU/);
  });

  test('zadanie tygodniowe ma własny próg: po 7 dniach jest świeże, po 9 nieaktualne', () => {
    const fresh = loadProject({
      properties: Object.assign({}, MAIL, { LAST_RUN_URL_INSPECTION: ranHoursAgo(7 * 24) }),
      triggers: ['sprawdzIndeksowanieTrigger']
    });
    assert.match(fresh.jobStatusText_('URL_INSPECTION'), /^AKTYWNE – /);

    const stale = loadProject({
      properties: Object.assign({}, MAIL, { LAST_RUN_URL_INSPECTION: ranHoursAgo(9 * 24) }),
      triggers: ['sprawdzIndeksowanieTrigger']
    });
    assert.match(stale.jobStatusText_('URL_INSPECTION'), /^NIEAKTUALNE – /);
  });

  test('status zadania po błędzie nazywa błąd i ostatni poprawny przebieg', () => {
    const gas = loadProject({ properties: { LAST_RUN_SEO_LIVE: ranHoursAgo(2) }, triggers: ['sprawdzStronyLiveTrigger'] });
    assert.throws(() => gas.recordJobRun_('SEO_LIVE', true, () => { throw new Error('Nie udało się pobrać strony'); }), /pobrać/);
    const text = gas.jobStatusText_('SEO_LIVE');
    assert.match(text, /^BŁĄD .*: Nie udało się pobrać strony | ostatni poprawny przebieg: /);
    assert.match(text, /trigger: TAK$/);
  });

  test('status zadania po błędzie i bez historii mówi wprost, że nie ma poprawnego przebiegu', () => {
    const gas = loadProject({});
    assert.throws(() => gas.recordJobRun_('RECRAWL', true, () => { throw new Error('boom'); }), /boom/);
    assert.match(gas.jobStatusText_('RECRAWL'), /brak poprawnego przebiegu/);
  });

  test('powrót zadania do normy zamyka incydent', () => {
    const gas = loadProject({
      properties: Object.assign({}, MAIL, { LAST_RUN_SEO_LIVE: ranHoursAgo(80) }),
      triggers: ['sprawdzStronyLiveTrigger']
    });
    gas.sprawdzAktualnoscImportow();
    assert.equal(jobRecord(gas, 'LAST_RUN_SEO_LIVE').incident.open, true);

    // Udany przebieg zamyka incydent od razu, a nie dopiero przy następnym
    // strażniku: powrót do normy widać w tej samej chwili, w której nastąpił.
    gas.$mails.length = 0;
    gas.recordJobRun_('SEO_LIVE', true, () => ({ detail: 'bez rozbieżności' }));
    assert.equal(jobRecord(gas, 'LAST_RUN_SEO_LIVE').incident.open, false);
    assert.equal(gas.$mails[0].subject, '[wordpress-automation] Zadanie ponownie działa: live check SEO');
    assert.match(gas.$mails[0].body, /Szczegóły: bez rozbieżności/);
    assert.equal(counts(gas.sprawdzAktualnoscImportow()).closed, 0, 'strażnik nie zamyka drugi raz');
  });

  test('strażnik zapisuje własny przebieg, ale nie otwiera incydentu o sobie', () => {
    const gas = loadProject({ properties: MAIL });
    gas.sprawdzAktualnoscImportow();
    const rec = jobRecord(gas, 'LAST_RUN_ALERTS');
    assert.equal(rec.lastOk.ok, true);
    assert.equal(rec.incident, undefined, 'martwy strażnik nie miałby jak zgłosić samego siebie');
  });
});
