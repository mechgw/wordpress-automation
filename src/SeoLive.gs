/**
 * Live SEO regression check (#53): czy opublikowana strona wygląda tak, jak
 * zamierzaliśmy, TERAZ, bez czekania na ponowny crawl Google.
 *
 * Arkusz `SEO LIVE`: adres w kolumnie A i oczekiwania w B..H; wynik, różnice
 * i czas w I..K; w L werdykt z indeksu Google (arkusz URL INSPEKCJA, #45),
 * żeby oba obrazy były obok siebie i wyraźnie podpisane.
 *
 * Oczekiwania (puste = nie sprawdzaj, poza statusem i robots):
 *   B status HTTP końcowej odpowiedzi (puste = 200)
 *   C URL docelowy po przekierowaniach (puste = sam adres, bez przekierowania)
 *   D <title>          E pierwszy <h1>        F <link rel="canonical">
 *   G robots: 'index' (domyślnie) albo 'noindex'; meta robots/googlebot i X-Robots-Tag
 *   H schema: lista @type z JSON-LD po przecinku, każdy musi wystąpić
 *
 * Pobranie przez UrlFetchApp bez logowania, przekierowania śledzone ręcznie
 * (do SEO_LIVE_MAX_REDIRECTS), żeby porównać cel. Błąd sieci jednego adresu
 * nie przerywa reszty. Handler triggera wysyła jeden zbiorczy e-mail tylko
 * o NOWYCH rozbieżnościach (wiersz, który poprzednio był OK lub pusty).
 */

const SEO_LIVE_SHEET = 'SEO LIVE';
const SEO_LIVE_HEADER = [
  'URL',
  'Oczekiwany status HTTP',
  'Oczekiwany URL docelowy',
  'Oczekiwany title',
  'Oczekiwany H1',
  'Oczekiwany canonical',
  'Oczekiwane robots',
  'Oczekiwane schema (@type)',
  'Wynik (live)',
  'Różnice',
  'Sprawdzono',
  'Indeks Google (URL INSPEKCJA)'
];
const SEO_LIVE_MAX_REDIRECTS = 5;
const SEO_LIVE_TRIGGER_HANDLER = 'sprawdzStronyLiveTrigger';
const SEO_LIVE_TRIGGER_HOUR = 9;

/** Adres bez fragmentu i końcowych ukośników, host małymi literami: do porównań. */
function seoLiveNormalizeUrl_(value) {
  const s = String(value || '').trim().replace(/#.*$/, '');
  const m = /^(https?:\/\/[^/]+)(.*)$/i.exec(s);
  if (!m) return s.replace(/\/+$/, '');
  return m[1].toLowerCase() + m[2].replace(/\/+$/, '');
}

/** Location z przekierowania względem bieżącego adresu (absolutny, //host, /ścieżka, względny). */
function seoLiveResolveUrl_(base, location) {
  const loc = String(location || '').trim();
  if (/^https?:\/\//i.test(loc)) return loc;
  const m = /^(https?:)\/\/([^/]+)(\/[^?#]*)?/i.exec(base);
  const origin = m[1] + '//' + m[2];
  if (loc.startsWith('//')) return m[1] + loc;
  if (loc.startsWith('/')) return origin + loc;
  const path = m[3] || '/';
  return origin + path.replace(/[^/]*$/, '') + loc;
}

function seoLiveHeader_(headers, name) {
  const key = Object.keys(headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : '';
}

/**
 * Pobiera adres, śledząc przekierowania ręcznie. Zwraca
 * { code, finalUrl, html, headers, chain } gdzie chain to kolejne adresy.
 */
function seoLiveFetch_(url) {
  const chain = [url];
  let current = url;
  for (let hop = 0; hop <= SEO_LIVE_MAX_REDIRECTS; hop++) {
    const response = UrlFetchApp.fetch(current, {
      muteHttpExceptions: true,
      followRedirects: false,
      validateHttpsCertificates: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wordpress-automation live check)' }
    });
    const code = response.getResponseCode();
    const headers = response.getAllHeaders() || {};
    const location = seoLiveHeader_(headers, 'Location');
    if (code >= 300 && code < 400 && location) {
      current = seoLiveResolveUrl_(current, location);
      chain.push(current);
      continue;
    }
    return { code, finalUrl: current, html: response.getContentText() || '', headers, chain };
  }
  throw new Error('Za dużo przekierowań (> ' + SEO_LIVE_MAX_REDIRECTS + '): ' + chain.join(' → '));
}

/** Tekst z fragmentu HTML: bez tagów, z rozkodowanymi podstawowymi encjami, pojedyncze spacje. */
function seoLiveText_(fragment) {
  return String(fragment || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, '\'').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function seoLiveAttr_(tag, name) {
  const m = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i').exec(tag);
  return m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : '';
}

/** Co strona mówi o sobie: title, H1, canonical, robots (meta + nagłówek), typy schema. */
function seoLiveExtract_(html, headers) {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const h1Match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);

  let canonical = '';
  (html.match(/<link\b[^>]*>/gi) || []).forEach(tag => {
    if (!canonical && /\bcanonical\b/i.test(seoLiveAttr_(tag, 'rel'))) canonical = seoLiveAttr_(tag, 'href').trim();
  });

  const robots = [];
  (html.match(/<meta\b[^>]*>/gi) || []).forEach(tag => {
    const name = seoLiveAttr_(tag, 'name').toLowerCase();
    if (name === 'robots' || name === 'googlebot') robots.push(seoLiveAttr_(tag, 'content').toLowerCase());
  });
  const xRobots = seoLiveHeader_(headers, 'X-Robots-Tag').toLowerCase();
  if (xRobots) robots.push('header: ' + xRobots);

  const types = [];
  (html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || []).forEach(block => {
    (block.match(/"@type"\s*:\s*"([^"]+)"/g) || []).forEach(m => types.push(/"([^"]+)"\s*$/.exec(m)[1]));
    (block.match(/"@type"\s*:\s*\[([^\]]*)\]/g) || []).forEach(m => (m.match(/"([^"]+)"/g) || []).slice(1).forEach(q => types.push(q.replace(/"/g, ''))));
  });

  return {
    title: titleMatch ? seoLiveText_(titleMatch[1]) : '',
    h1: h1Match ? seoLiveText_(h1Match[1]) : '',
    canonical,
    robots: robots.join(' | '),
    types: types.filter((t, i, arr) => arr.indexOf(t) === i)
  };
}

function seoLiveQuote_(value) {
  return value ? '„' + value + '”' : 'brak';
}

/** Oczekiwania wiersza (kolumny B..H) w jednym obiekcie. */
function seoLiveExpectations_(line) {
  return {
    // Pusty = 200; liczba = ta liczba; cokolwiek innego zostaje tekstem i da różnicę,
    // żeby literówka w oczekiwaniu nie udawała zgodności.
    status: String(line[1] || '').trim() === '' ? 200 : (/^\d{3}$/.test(String(line[1]).trim()) ? Number(line[1]) : String(line[1]).trim()),
    target: String(line[2] || '').trim(),
    title: String(line[3] || '').trim(),
    h1: String(line[4] || '').trim(),
    canonical: String(line[5] || '').trim(),
    robots: String(line[6] || '').trim().toLowerCase(),
    schema: String(line[7] || '').split(',').map(s => s.trim()).filter(Boolean)
  };
}

/** Lista różnic „co jest (oczekiwano co)”; pusta = strona zgodna. */
function seoLiveCompare_(url, expect, fetched, page) {
  const diffs = [];
  if (typeof expect.status !== 'number') {
    diffs.push('status: ' + fetched.code + ' (oczekiwany status „' + expect.status + '” nie jest kodem HTTP; wpisz liczbę albo zostaw puste = 200)');
  } else if (fetched.code !== expect.status) {
    diffs.push('status: ' + fetched.code + ' (oczekiwano ' + expect.status + ')');
  }

  const expectedTarget = expect.target || url;
  if (seoLiveNormalizeUrl_(fetched.finalUrl) !== seoLiveNormalizeUrl_(expectedTarget)) {
    diffs.push('cel: ' + fetched.finalUrl + ' (oczekiwano ' + expectedTarget + (fetched.chain.length > 1 ? '; łańcuch: ' + fetched.chain.join(' → ') : '') + ')');
  }

  if (expect.title && page.title !== seoLiveText_(expect.title)) diffs.push('title: ' + seoLiveQuote_(page.title) + ' (oczekiwano ' + seoLiveQuote_(expect.title) + ')');
  if (expect.h1 && page.h1 !== seoLiveText_(expect.h1)) diffs.push('H1: ' + seoLiveQuote_(page.h1) + ' (oczekiwano ' + seoLiveQuote_(expect.h1) + ')');
  if (expect.canonical && seoLiveNormalizeUrl_(page.canonical) !== seoLiveNormalizeUrl_(expect.canonical)) {
    diffs.push('canonical: ' + (page.canonical || 'brak') + ' (oczekiwano ' + expect.canonical + ')');
  }

  const wantNoindex = expect.robots.indexOf('noindex') >= 0;
  const isNoindex = /noindex/.test(page.robots);
  if (wantNoindex !== isNoindex) {
    diffs.push('robots: ' + (isNoindex ? 'noindex' : 'index') + (page.robots ? ' [' + page.robots + ']' : ' [brak meta robots]') +
      ' (oczekiwano ' + (wantNoindex ? 'noindex' : 'index') + ')');
  }

  expect.schema.forEach(type => {
    if (page.types.indexOf(type) < 0) {
      diffs.push('schema: brak @type ' + type + ' (znaleziono: ' + (page.types.length ? page.types.join(', ') : 'nic') + ')');
    }
  });

  return diffs;
}

/** Werdykty z arkusza URL INSPEKCJA po znormalizowanym adresie (może nie istnieć). */
function seoLiveIndexLookup_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(URL_INSPECTION_SHEET);
  const map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues().forEach(line => {
    const key = seoLiveNormalizeUrl_(line[0]);
    // Sheets zamienia zapisany tekst daty na wartość typu Date: formatujemy zamiast rzutować.
    const checked = line[7] instanceof Date ? formatImportTime_(line[7].toISOString()) : String(line[7] || '');
    if (key && line[1]) map[key] = String(line[1]) + (checked ? ' (sprawdzono ' + checked + ')' : '');
  });
  return map;
}

/**
 * Przebieg: każdy adres z kolumny A dostaje OK / UWAGA / BŁĄD, różnice, czas
 * i werdykt z indeksu. Zwraca podsumowanie z listą nowych rozbieżności.
 */
function runSeoLiveCheck_() {
  const sheet = ensureSheetWithHeader_(SEO_LIVE_SHEET, SEO_LIVE_HEADER);
  const summary = { checked: 0, ok: 0, warnings: 0, errors: 0, empty: false, problems: [], newProblems: [] };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    summary.empty = true;
    return summary;
  }

  const width = SEO_LIVE_HEADER.length;
  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const index = seoLiveIndexLookup_();
  const now = formatImportTime_(new Date().toISOString());

  values.forEach((line, i) => {
    const url = String(line[0] || '').trim();
    if (!url) return;
    const previous = String(line[8] || '');
    let result;
    let details;
    try {
      if (!/^https?:\/\//i.test(url)) throw new Error('Adres musi zaczynać się od http:// lub https://');
      const fetched = seoLiveFetch_(url);
      const diffs = seoLiveCompare_(url, seoLiveExpectations_(line), fetched, seoLiveExtract_(fetched.html, fetched.headers));
      result = diffs.length ? 'UWAGA: ' + diffs.length + ' różnic(e)' : 'OK';
      details = diffs.join('; ');
      summary.checked++;
      if (diffs.length) summary.warnings++; else summary.ok++;
    } catch (e) {
      result = 'BŁĄD';
      details = String(e && e.message ? e.message : e);
      summary.errors++;
    }
    const indexVerdict = index[seoLiveNormalizeUrl_(url)] || 'brak w ' + URL_INSPECTION_SHEET;
    sheet.getRange(i + 2, 9, 1, 4).setValues([[result, details, now, indexVerdict]]);
    if (result !== 'OK') {
      const lineText = url + ': ' + result + (details ? ' – ' + details : '');
      summary.problems.push(lineText);
      if (previous === '' || previous === 'OK') summary.newProblems.push(lineText);
    }
  });

  return summary;
}

function seoLiveSummaryText_(summary) {
  if (summary.empty) {
    return 'Arkusz „' + SEO_LIVE_SHEET + '” nie ma adresów. Wpisz adresy w kolumnie A i oczekiwania w B..H (od wiersza 2), potem uruchom ponownie.';
  }
  const lines = [
    'Live SEO check (stan opublikowanej strony teraz; stan w indeksie Google jest w kolumnie L):',
    'Sprawdzono: ' + (summary.checked + summary.errors) + ' | OK: ' + summary.ok + ' | UWAGA: ' + summary.warnings + ' | BŁĄD: ' + summary.errors
  ];
  if (summary.problems.length) {
    lines.push('');
    summary.problems.slice(0, 20).forEach(p => lines.push('- ' + p));
    if (summary.problems.length > 20) lines.push('… i ' + (summary.problems.length - 20) + ' więcej w arkuszu.');
  }
  return lines.join('\n');
}

/** Menu SEO / GSC → Sprawdź strony live. */
function sprawdzStronyLive() {
  const summary = withScriptLock_('live check SEO', runSeoLiveCheck_);
  SpreadsheetApp.getUi().alert(seoLiveSummaryText_(summary));
  return summary;
}

/** Handler codziennego triggera: bez okna; jeden e-mail o NOWYCH rozbieżnościach. */
function sprawdzStronyLiveTrigger() {
  const summary = recordJobRun_('SEO_LIVE', true, () => withScriptLock_('live check SEO', runSeoLiveCheck_));
  Logger.log(seoLiveSummaryText_(summary));
  if (summary.newProblems.length) {
    sendImportAlert_('Live SEO: ' + summary.newProblems.length + ' nowa(e) rozbieżność(ci)', [
      'Codzienny live check znalazł rozbieżności, których poprzednio nie było:',
      ''
    ].concat(summary.newProblems.map(p => '- ' + p)).concat([
      '',
      'Pozostałe wiersze z UWAGA/BŁĄD z poprzednich dni nie są powtarzane; pełna lista w arkuszu „' + SEO_LIVE_SHEET + '”.'
    ]));
  }
  return summary;
}

/** Instaluje codzienny live check (ok. 09:00), zastępując poprzedni. */
function ustawCodziennyLiveCheck() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === SEO_LIVE_TRIGGER_HANDLER)
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger(SEO_LIVE_TRIGGER_HANDLER)
    .timeBased()
    .everyDays(1)
    .atHour(SEO_LIVE_TRIGGER_HOUR)
    .create();

  SpreadsheetApp.getUi().alert(
    'Codzienny live check SEO został ustawiony (ok. ' + SEO_LIVE_TRIGGER_HOUR + ':00).\n' +
    'Adresy i oczekiwania: arkusz „' + SEO_LIVE_SHEET + '”. E-mail tylko o nowych rozbieżnościach, adresat: ' + alertRecipientText_()
  );
}
