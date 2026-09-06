/**
 * Sitemapa jako źródło listy monitorowanych adresów (#89).
 *
 * `sitemaps.list` w Search Console zwraca stan samych sitemap (daty, błędy,
 * liczbę zgłoszonych adresów), NIE listę adresów. Żeby dostać adresy, trzeba
 * pobrać XML każdej sitemapy i go sparsować. To robi ten plik.
 *
 * Trzy warstwy:
 *   `SITEMAPY`      – zdrowie sitemap (Sitemaps.gs, bez zmian),
 *   `SITEMAP URLS`  – lista adresów z XML: adres, sitemapa źródłowa, lastmod, czas odczytu,
 *   monitoring      – z tej listy dosypywane są brakujące adresy do `SEO LIVE`
 *                     i `URL INSPEKCJA`, więc nowa strona nie wymaga pamiętania
 *                     o dwóch dodatkowych zakładkach.
 *
 * Zasada: synchronizacja WYŁĄCZNIE dopisuje. Adres, który zniknął z sitemapy,
 * nie jest usuwany z monitoringu, bo to często właśnie ten adres trzeba
 * pilnować (celowe 301, strona wycofana). Takie wiersze są zgłaszane w oknie
 * jako „spoza sitemapy”, a decyzja należy do człowieka. Dzięki temu ręcznie
 * dopisane wyjątki są trwałe i nie trzeba dla nich osobnej listy.
 */

const SITEMAP_URLS_SHEET = 'SITEMAP URLS';
const SITEMAP_URLS_HEADER = ['URL', 'Sitemapa źródłowa', 'lastmod', 'Odczytano'];
/** Zabezpieczenia przed sitemapą, która odsyła do samej siebie albo jest ogromna. */
const SITEMAP_MAX_FILES = 30;
const SITEMAP_MAX_URLS = 5000;
const SITEMAP_SYNC_TRIGGER_HANDLER = 'odswiezMonitoringZSitemapTrigger';
const SITEMAP_SYNC_TRIGGER_HOUR = 6;

/** Podstawowe encje XML; sitemapy zwykle kodują tylko ampersand. */
function decodeXmlEntities_(text) {
  return String(text || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;|&#0?39;/g, '\'')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

function firstTagValue_(block, tag) {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(block);
  return m ? decodeXmlEntities_(m[1]) : '';
}

/**
 * Parsuje XML sitemapy. Zwraca { isIndex, entries: [{ loc, lastmod }] }.
 * Bloki `<url>` i `<sitemap>` czytamy osobno, więc `<image:loc>` w środku
 * wpisu nie trafia do wyniku jako osobny adres.
 */
function parseSitemapXml_(xml) {
  const text = String(xml || '');
  const isIndex = /<sitemapindex[\s>]/i.test(text);
  const blockTag = isIndex ? 'sitemap' : 'url';
  const blocks = text.match(new RegExp('<' + blockTag + '(?:\\s[^>]*)?>[\\s\\S]*?<\\/' + blockTag + '>', 'gi')) || [];
  const entries = [];
  blocks.forEach(block => {
    const loc = firstTagValue_(block, 'loc');
    if (loc) entries.push({ loc: loc, lastmod: firstTagValue_(block, 'lastmod') });
  });
  return { isIndex: isIndex, entries: entries };
}

/** Pobiera XML sitemapy; błąd HTTP jest jawny, nie cichy. */
function fetchSitemapXml_(url) {
  const response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wordpress-automation sitemap reader)' }
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('HTTP ' + code);
  return response.getContentText() || '';
}

/**
 * Przechodzi sitemapy wszerz, rozwijając indeksy. Zwraca
 * { urls: [{ url, sitemap, lastmod }], files, errors: [{ sitemap, error }] }.
 * Każdy plik pobierany najwyżej raz, adresy deduplikowane po normalizacji.
 */
function collectSitemapUrls_(roots) {
  const queue = roots.slice();
  const visited = {};
  const seen = {};
  const urls = [];
  const errors = [];
  let files = 0;

  while (queue.length && files < SITEMAP_MAX_FILES && urls.length < SITEMAP_MAX_URLS) {
    const sitemapUrl = String(queue.shift() || '').trim();
    if (!sitemapUrl || visited[sitemapUrl]) continue;
    visited[sitemapUrl] = true;
    files++;

    let parsed;
    try {
      parsed = parseSitemapXml_(fetchSitemapXml_(sitemapUrl));
    } catch (e) {
      errors.push({ sitemap: sitemapUrl, error: String(e && e.message ? e.message : e) });
      continue;
    }

    parsed.entries.forEach(entry => {
      if (parsed.isIndex) {
        if (!visited[entry.loc]) queue.push(entry.loc);
        return;
      }
      const key = seoLiveNormalizeUrl_(entry.loc);
      if (seen[key] || urls.length >= SITEMAP_MAX_URLS) return;
      seen[key] = true;
      urls.push({ url: entry.loc, sitemap: sitemapUrl, lastmod: entry.lastmod });
    });
  }

  return { urls: urls, files: files, errors: errors, truncated: queue.length > 0 || urls.length >= SITEMAP_MAX_URLS };
}

/** Adresy z kolumny A arkusza monitoringu, znormalizowane, z numerem wiersza. */
function monitoredUrls_(sheetName) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
  const out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().forEach((row, i) => {
    const url = String(row[0] || '').trim();
    if (url) out[seoLiveNormalizeUrl_(url)] = { url: url, row: i + 2 };
  });
  return out;
}

/**
 * Dopisuje brakujące adresy do arkusza monitoringu (tylko kolumna A) i zwraca
 * { added: [], extra: [] } – `extra` to adresy monitorowane, których nie ma
 * w sitemapie; nigdy nie są usuwane.
 */
function syncMonitoringSheet_(sheetName, header, sitemapUrls) {
  const sheet = ensureSheetWithHeader_(sheetName, header);
  const existing = monitoredUrls_(sheetName);
  const inSitemap = {};
  const added = [];

  sitemapUrls.forEach(item => {
    const key = seoLiveNormalizeUrl_(item.url);
    inSitemap[key] = true;
    if (existing[key]) return;
    added.push(item.url);
  });

  if (added.length) {
    const start = sheet.getLastRow() + 1;
    sheet.getRange(start, 1, added.length, 1).setValues(added.map(url => [url]));
  }

  const extra = Object.keys(existing).filter(key => !inSitemap[key]).map(key => existing[key].url);
  return { added: added, extra: extra };
}

/**
 * Pobiera adresy ze wszystkich sitemap witryny, zapisuje arkusz `SITEMAP URLS`
 * i dosypuje brakujące adresy do `SEO LIVE` oraz `URL INSPEKCJA`.
 */
function refreshSitemapMonitoring_() {
  const cfg = getConfig_();
  if (!cfg.siteUrl) throw new Error('Brak siteUrl w arkuszu ' + CONFIG_SHEET + '.');

  const roots = listSitemaps_(cfg.siteUrl).map(sm => String(sm.path || '')).filter(Boolean);
  if (!roots.length) {
    return { urls: 0, files: 0, errors: [], truncated: false, empty: true, seoLive: { added: [], extra: [] }, inspection: { added: [], extra: [] } };
  }

  const collected = collectSitemapUrls_(roots);
  const now = formatImportTime_(new Date().toISOString());

  const sheet = ensureSheetWithHeader_(SITEMAP_URLS_SHEET, SITEMAP_URLS_HEADER);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, SITEMAP_URLS_HEADER.length).clearContent();
  if (collected.urls.length) {
    sheet.getRange(2, 1, collected.urls.length, SITEMAP_URLS_HEADER.length)
      .setValues(collected.urls.map(item => [item.url, item.sitemap, item.lastmod, now]));
  }

  return {
    urls: collected.urls.length,
    files: collected.files,
    errors: collected.errors,
    truncated: collected.truncated,
    empty: false,
    seoLive: syncMonitoringSheet_(SEO_LIVE_SHEET, SEO_LIVE_HEADER, collected.urls),
    inspection: syncMonitoringSheet_(URL_INSPECTION_SHEET, URL_INSPECTION_HEADER, collected.urls)
  };
}

function sitemapMonitoringSummaryText_(out) {
  if (out.empty) {
    return 'Search Console nie zna żadnej sitemapy dla tej witryny, więc nie ma z czego pobrać adresów. Zgłoś sitemapę w Search Console albo sprawdź siteUrl w ' + CONFIG_SHEET + '.';
  }
  const lines = [
    'Adresy z sitemap → monitoring:',
    'Sitemapy pobrane: ' + out.files + ' | adresy w „' + SITEMAP_URLS_SHEET + '”: ' + out.urls,
    'Dopisane do „' + SEO_LIVE_SHEET + '”: ' + out.seoLive.added.length + ' | do „' + URL_INSPECTION_SHEET + '”: ' + out.inspection.added.length
  ];
  if (out.seoLive.added.length) {
    lines.push('', 'Nowe adresy w monitoringu:');
    out.seoLive.added.slice(0, 15).forEach(url => lines.push('- ' + url));
    if (out.seoLive.added.length > 15) lines.push('… i ' + (out.seoLive.added.length - 15) + ' więcej.');
  }
  if (out.seoLive.extra.length) {
    lines.push('', 'Monitorowane mimo braku w sitemapie (nie są usuwane, sprawdź czy tak ma być):');
    out.seoLive.extra.slice(0, 15).forEach(url => lines.push('- ' + url));
    if (out.seoLive.extra.length > 15) lines.push('… i ' + (out.seoLive.extra.length - 15) + ' więcej.');
  }
  if (out.errors.length) {
    lines.push('', 'Sitemapy, których nie udało się pobrać:');
    out.errors.forEach(e => lines.push('- ' + e.sitemap + ': ' + e.error));
  }
  if (out.truncated) {
    lines.push('', 'UWAGA: przerwano na limicie (' + SITEMAP_MAX_FILES + ' plików / ' + SITEMAP_MAX_URLS + ' adresów). Lista jest niepełna.');
  }
  return lines.join('\n');
}

/** Menu SEO / GSC → Odśwież adresy z sitemap. */
function odswiezMonitoringZSitemap() {
  const out = withScriptLock_('adresy z sitemap', refreshSitemapMonitoring_);
  SpreadsheetApp.getUi().alert(sitemapMonitoringSummaryText_(out));
  return out;
}

/** Handler triggera tygodniowego: bez okna, wynik w arkuszach i w logu. */
function odswiezMonitoringZSitemapTrigger() {
  const out = withScriptLock_('adresy z sitemap', refreshSitemapMonitoring_);
  Logger.log(sitemapMonitoringSummaryText_(out));
  return out;
}

/** Instaluje cotygodniowe odświeżanie (poniedziałek ok. 06:00, przed inspekcją URL). */
function ustawTygodnioweOdswiezanieSitemap() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === SITEMAP_SYNC_TRIGGER_HANDLER)
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger(SITEMAP_SYNC_TRIGGER_HANDLER)
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(SITEMAP_SYNC_TRIGGER_HOUR)
    .create();

  SpreadsheetApp.getUi().alert(
    'Cotygodniowe odświeżanie adresów z sitemap zostało ustawione (poniedziałek, ok. ' + SITEMAP_SYNC_TRIGGER_HOUR + ':00).\n' +
    'Godzinę później rusza inspekcja URL, więc nowe adresy trafią do niej w tym samym przebiegu tygodnia.'
  );
}
