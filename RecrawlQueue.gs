/**
 * Kolejka recrawl (#92): które strony Google powinien odwiedzić ponownie.
 *
 * Nie zgłasza niczego do Google. Dla zwykłych landingów nie ma publicznego API
 * odpowiadającego przyciskowi „Poproś o zindeksowanie”, a Indexing API jest
 * przeznaczone dla innych typów treści. Ten plik tylko klasyfikuje i raportuje,
 * żeby człowiek wiedział, którą stronę zgłosić ręcznie w Search Console.
 *
 * Wszystko liczone z danych, które już mamy, bez żadnego zapytania do API:
 *   `SITEMAP URLS`   – `lastmod`, czyli data zmiany wg witryny,
 *   `Dziennik zmian` – ręczny rejestr zmian (nadpisuje `lastmod`, gdy nowszy),
 *   `URL INSPEKCJA`  – ostatni crawl i werdykt Google,
 *   `SEO LIVE`       – stan produkcyjny i celowe wyjątki (noindex, przekierowania).
 *
 * E-mail działa jak alerty z #42: zgłasza wyłącznie NOWE rekomendacje. Strona,
 * która czeka od tygodnia, nie wraca codziennie w kolejnym mailu; wraca dopiero,
 * gdy zmieni się jej stan. Kolumna `Wyciszone` = TAK wyłącza stronę na stałe.
 */

const RECRAWL_SHEET = 'RECRAWL QUEUE';
/** Ręczny rejestr zmian prowadzony przez człowieka; rozpoznawany po nagłówkach. */
const RECRAWL_CHANGELOG_SHEET = 'Dziennik zmian';
const RECRAWL_HEADER = [
  'URL',
  'Data zmiany',
  'Źródło daty zmiany',
  'Ostatni crawl Google',
  'Dni od zmiany',
  'Status',
  'Powód',
  'Wyciszone',
  'Powiadomiono',
  'Sprawdzono'
];
const RECRAWL_STATUS = {
  current: 'AKTUALNE',
  waiting: 'OCZEKUJE NA RECRAWL',
  ask: 'WARTO POPROSIĆ RĘCZNIE',
  noCrawl: 'BRAK CRAWLA',
  excluded: 'WYKLUCZONA / NIE DOTYCZY',
  unknown: 'BRAK DATY ZMIANY'
};
const RECRAWL_DEFAULT_STALE_DAYS = 7;
const RECRAWL_TRIGGER_HANDLER = 'kolejkaRecrawlTrigger';
const RECRAWL_TRIGGER_HOUR = 10;

/** Próg dni oczekiwania na crawl; Script Property RECRAWL_STALE_DAYS nadpisuje domyślne 7. */
function recrawlStaleDays_() {
  const raw = PropertiesService.getScriptProperties().getProperty('RECRAWL_STALE_DAYS');
  const value = Number(String(raw || '').trim());
  return value > 0 ? value : RECRAWL_DEFAULT_STALE_DAYS;
}

/** Wartość z arkusza jako czas w ms; Date, „yyyy-MM-dd HH:mm” i ISO. null gdy nieczytelne. */
function recrawlDate_(value) {
  if (!value && value !== 0) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
  const text = String(value).trim();
  if (!text) return null;
  const t = new Date(text.indexOf(' ') > 0 && text.indexOf('T') < 0 ? text.replace(' ', 'T') : text).getTime();
  return isNaN(t) ? null : t;
}

function recrawlDayDiff_(fromMs, toMs) {
  return Math.floor((toMs - fromMs) / 86400000);
}

/** Wiersze arkusza od 2 w dół jako tablice; pusta tablica, gdy arkusza nie ma. */
function recrawlSheetRows_(name, width) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
}

/** Mapa znormalizowany URL → { lastmod } z arkusza SITEMAP URLS. */
function recrawlSitemapIndex_() {
  const map = {};
  recrawlSheetRows_(SITEMAP_URLS_SHEET, SITEMAP_URLS_HEADER.length).forEach(row => {
    const url = String(row[0] || '').trim();
    if (url) map[seoLiveNormalizeUrl_(url)] = { lastmod: recrawlDate_(row[2]) };
  });
  return map;
}

/**
 * Najnowsza data zmiany per URL z arkusza `Dziennik zmian`. Arkusz jest ręczny,
 * więc kolumny rozpoznajemy po nagłówku: pierwsza z „url” i pierwsza z „data”.
 * Brak którejkolwiek = dziennik jest pomijany, co raport mówi wprost.
 */
function recrawlChangeLog_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(RECRAWL_CHANGELOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { used: false, reason: 'brak arkusza „' + RECRAWL_CHANGELOG_SHEET + '”', map: {} };

  const width = Math.min(sheet.getLastColumn(), 26);
  const header = sheet.getRange(1, 1, 1, width).getValues()[0].map(h => String(h || '').toLowerCase());
  const urlCol = header.findIndex(h => h.indexOf('url') >= 0 || h.indexOf('adres') >= 0);
  const dateCol = header.findIndex(h => h.indexOf('data') >= 0);
  if (urlCol < 0 || dateCol < 0) {
    return { used: false, reason: 'nie znaleziono kolumn z adresem i datą w „' + RECRAWL_CHANGELOG_SHEET + '”', map: {} };
  }

  const map = {};
  sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues().forEach(row => {
    const url = String(row[urlCol] || '').trim();
    const when = recrawlDate_(row[dateCol]);
    if (!url || when === null) return;
    const key = seoLiveNormalizeUrl_(url);
    if (!map[key] || when > map[key]) map[key] = when;
  });
  return { used: true, reason: '', map: map };
}

/** Mapa znormalizowany URL → { expectedRobots, differences, result } z arkusza SEO LIVE. */
function recrawlLiveIndex_() {
  const map = {};
  recrawlSheetRows_(SEO_LIVE_SHEET, SEO_LIVE_HEADER.length).forEach(row => {
    const url = String(row[0] || '').trim();
    if (!url) return;
    map[seoLiveNormalizeUrl_(url)] = {
      expectedRobots: String(row[6] || '').toLowerCase(),
      result: String(row[8] || ''),
      differences: String(row[9] || '')
    };
  });
  return map;
}

/**
 * Klasyfikuje jeden adres. `inspection` to wiersz z URL INSPEKCJA,
 * `sitemap`/`live` to wpisy z map wyżej, `changedAt` to data zmiany (ms albo null).
 * Zwraca { status, reason, recommend }.
 */
function classifyRecrawl_(url, inspection, sitemap, live, changedAt, nowMs, staleDays) {
  if (!sitemap) {
    return { status: RECRAWL_STATUS.excluded, reason: 'poza sitemapą (monitorowana ręcznie, nie zgłaszamy)', recommend: false };
  }
  if (live && live.expectedRobots.indexOf('noindex') >= 0) {
    return { status: RECRAWL_STATUS.excluded, reason: 'celowy noindex', recommend: false };
  }
  if (live && /(^|; )cel: /.test(live.differences)) {
    return { status: RECRAWL_STATUS.excluded, reason: 'strona przekierowuje; napraw przekierowanie zanim poprosisz o indeksowanie', recommend: false };
  }

  const crawledAt = recrawlDate_(inspection.lastCrawl);
  const verdict = String(inspection.verdict || '');
  const liveOk = live && live.result.indexOf('OK') === 0;

  // Brak crawla jest precyzyjniejszą diagnozą niż „nie ma w indeksie”, więc idzie pierwszy.
  if (crawledAt === null) {
    return { status: RECRAWL_STATUS.noCrawl, reason: 'Google jeszcze nie odwiedził tego adresu', recommend: true };
  }

  // Strona działa, Google ją odwiedził, ale nie ma jej w indeksie: najmocniejszy
  // powód do ręcznej prośby, niezależnie od dat. To przypadek adresów, które
  // Google nadal pamięta jako 404.
  if (liveOk && verdict && verdict.indexOf('ZAINDEKSOWANY') !== 0) {
    return {
      status: RECRAWL_STATUS.ask,
      reason: 'strona działa (live OK), ale Google jej nie ma w indeksie: ' + verdict + (inspection.coverage ? ' – ' + inspection.coverage : ''),
      recommend: true
    };
  }
  if (changedAt === null) {
    return { status: RECRAWL_STATUS.unknown, reason: 'brak wiarygodnej daty zmiany (lastmod ani Dziennik zmian)', recommend: false };
  }
  if (crawledAt >= changedAt) {
    return { status: RECRAWL_STATUS.current, reason: 'crawl po ostatniej zmianie', recommend: false };
  }

  const waitingDays = recrawlDayDiff_(changedAt, nowMs);
  if (waitingDays >= staleDays) {
    return { status: RECRAWL_STATUS.ask, reason: 'zmiana ' + waitingDays + ' dni temu, Google nadal nie odwiedził strony', recommend: true };
  }
  return { status: RECRAWL_STATUS.waiting, reason: 'zmiana ' + waitingDays + ' dni temu, crawl jeszcze może nadejść', recommend: false };
}

/**
 * Przelicza kolejkę i przepisuje arkusz `RECRAWL QUEUE`, zachowując kolumny
 * człowieka (`Wyciszone`) i stan powiadomień. Zwraca podsumowanie z listą
 * nowych rekomendacji.
 */
function refreshRecrawlQueue_() {
  const sheet = ensureSheetWithHeader_(RECRAWL_SHEET, RECRAWL_HEADER);
  const previous = {};
  recrawlSheetRows_(RECRAWL_SHEET, RECRAWL_HEADER.length).forEach(row => {
    const url = String(row[0] || '').trim();
    if (url) {
      previous[seoLiveNormalizeUrl_(url)] = {
        status: String(row[5] || ''),
        muted: String(row[7] || '').trim().toUpperCase() === 'TAK',
        notifiedAt: row[8]
      };
    }
  });

  const sitemap = recrawlSitemapIndex_();
  const live = recrawlLiveIndex_();
  const changeLog = recrawlChangeLog_();
  const staleDays = recrawlStaleDays_();
  const now = new Date();
  const nowMs = now.getTime();
  const checkedAt = formatImportTime_(now.toISOString());

  const rows = [];
  const summary = { total: 0, recommended: [], newRecommended: [], muted: 0, byStatus: {}, changeLog: changeLog, staleDays: staleDays };

  recrawlSheetRows_(URL_INSPECTION_SHEET, URL_INSPECTION_HEADER.length).forEach(row => {
    const url = String(row[0] || '').trim();
    if (!url) return;
    const key = seoLiveNormalizeUrl_(url);
    const prev = previous[key] || {};
    const sitemapEntry = sitemap[key];
    const logged = changeLog.map[key];
    const changedAt = [sitemapEntry ? sitemapEntry.lastmod : null, logged === undefined ? null : logged]
      .filter(v => v !== null && v !== undefined)
      .reduce((best, v) => (best === null || v > best ? v : best), null);
    const source = changedAt === null ? ''
      : (logged !== undefined && logged === changedAt ? RECRAWL_CHANGELOG_SHEET : 'lastmod z sitemapy');

    const verdictRow = { lastCrawl: row[5], verdict: row[1], coverage: row[2] };
    const decision = classifyRecrawl_(url, verdictRow, sitemapEntry, live[key], changedAt, nowMs, staleDays);
    const muted = prev.muted === true;
    const recommend = decision.recommend && !muted;

    summary.total++;
    if (muted) summary.muted++;
    summary.byStatus[decision.status] = (summary.byStatus[decision.status] || 0) + 1;

    let notifiedAt = prev.notifiedAt || '';
    if (recommend) {
      summary.recommended.push({ url: url, reason: decision.reason });
      // Nowa rekomendacja = taka, której wcześniej nie zgłaszaliśmy. Powrót do
      // stanu bez rekomendacji czyści znacznik, więc kolejny raz zgłosi się ponownie.
      if (!notifiedAt) summary.newRecommended.push({ url: url, reason: decision.reason });
    } else {
      notifiedAt = '';
    }

    rows.push({
      key: key,
      values: [
        url,
        changedAt === null ? '' : formatImportTime_(new Date(changedAt).toISOString()),
        source,
        recrawlDate_(row[5]) === null ? '' : formatImportTime_(new Date(recrawlDate_(row[5])).toISOString()),
        changedAt === null ? '' : recrawlDayDiff_(changedAt, nowMs),
        muted ? RECRAWL_STATUS.excluded : decision.status,
        muted ? 'wyciszone ręcznie' : decision.reason,
        muted ? 'TAK' : '',
        notifiedAt,
        checkedAt
      ]
    });
  });

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, RECRAWL_HEADER.length).clearContent();
  if (rows.length) {
    ensureSheetRows_(sheet, rows.length + 1);
    sheet.getRange(2, 1, rows.length, RECRAWL_HEADER.length).setValues(rows.map(r => r.values));
  }

  summary.rowsWritten = rows.length;
  summary.notifyRows = rows;
  summary.checkedAt = checkedAt;
  summary.sheet = sheet;
  return summary;
}

/** Zapisuje znacznik powiadomienia dla adresów, o których właśnie wysłaliśmy mail. */
function markRecrawlNotified_(summary) {
  const notified = {};
  summary.newRecommended.forEach(item => { notified[seoLiveNormalizeUrl_(item.url)] = true; });
  summary.notifyRows.forEach((row, i) => {
    if (!notified[row.key]) return;
    summary.sheet.getRange(i + 2, 9).setValue(summary.checkedAt);
  });
}

function recrawlSummaryText_(summary) {
  if (!summary.total) {
    return 'Arkusz „' + URL_INSPECTION_SHEET + '” nie ma adresów, więc nie ma czego klasyfikować. Uruchom najpierw *Odśwież adresy z sitemap*.';
  }
  const lines = [
    'Kolejka recrawl (nic nie jest zgłaszane do Google automatycznie):',
    'Adresów: ' + summary.total + ' | próg oczekiwania: ' + summary.staleDays + ' dni' + (summary.muted ? ' | wyciszone: ' + summary.muted : ''),
    ''
  ];
  Object.keys(RECRAWL_STATUS).forEach(k => {
    const status = RECRAWL_STATUS[k];
    if (summary.byStatus[status]) lines.push(status + ': ' + summary.byStatus[status]);
  });
  if (summary.recommended.length) {
    lines.push('', 'Do ręcznego zgłoszenia w Search Console („Poproś o zindeksowanie”):');
    summary.recommended.slice(0, 20).forEach(item => lines.push('- ' + item.url + '\n  ' + item.reason));
    if (summary.recommended.length > 20) lines.push('… i ' + (summary.recommended.length - 20) + ' więcej w arkuszu.');
  } else {
    lines.push('', 'Nic nie wymaga ręcznego zgłoszenia.');
  }
  if (!summary.changeLog.used) {
    lines.push('', 'Uwaga: ' + summary.changeLog.reason + '; daty zmian pochodzą wyłącznie z sitemapy.');
  }
  return lines.join('\n');
}

/** Menu SEO / GSC → Kolejka recrawl. */
function kolejkaRecrawl() {
  const summary = withScriptLock_('kolejka recrawl', refreshRecrawlQueue_);
  SpreadsheetApp.getUi().alert(recrawlSummaryText_(summary));
  return summary;
}

/** Handler codziennego triggera: bez okna, e-mail tylko o nowych rekomendacjach. */
function kolejkaRecrawlTrigger() {
  const summary = withScriptLock_('kolejka recrawl', refreshRecrawlQueue_);
  Logger.log(recrawlSummaryText_(summary));

  if (summary.newRecommended.length) {
    const sent = sendImportAlert_('Do zgłoszenia w Search Console: ' + summary.newRecommended.length + ' stron(y)', [
      'Te strony warto ręcznie zgłosić w Search Console przez „Poproś o zindeksowanie”:',
      ''
    ].concat(summary.newRecommended.map(item => '- ' + item.url + '\n  ' + item.reason)).concat([
      '',
      'Nic nie zostało zgłoszone automatycznie: dla zwykłych stron Google nie udostępnia do tego API.',
      'Strona już zgłoszona nie wróci w kolejnym mailu. Pełna kolejka jest w arkuszu „' + RECRAWL_SHEET + '”,',
      'a wpisanie TAK w kolumnie „Wyciszone” usuwa adres z rekomendacji na stałe.'
    ]));
    if (sent) markRecrawlNotified_(summary);
  }
  return summary;
}

/** Instaluje codzienne przeliczanie kolejki (ok. 10:00, po live checku). */
function ustawCodziennaKolejkeRecrawl() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === RECRAWL_TRIGGER_HANDLER)
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger(RECRAWL_TRIGGER_HANDLER)
    .timeBased()
    .everyDays(1)
    .atHour(RECRAWL_TRIGGER_HOUR)
    .create();

  SpreadsheetApp.getUi().alert(
    'Codzienna kolejka recrawl została ustawiona (ok. ' + RECRAWL_TRIGGER_HOUR + ':00, po live checku).\n' +
    'E-mail wychodzi tylko o nowych rekomendacjach, na adres: ' + alertRecipientText_() + '\n' +
    'Nic nie jest zgłaszane do Google automatycznie.'
  );
}
