/**
 * Rozpoznawanie zmian oczekujących na wykonanie (#130).
 *
 * `SEO LIVE` i kolejka `WP COMMANDS` działały niezależnie, co dawało wyścig:
 * polecenie przygotowane wieczorem, poranny live check widzi jeszcze stary
 * stan i wysyła alert o regresji, a polecenie wykonuje się później tego samego
 * dnia. Alert jest wtedy technicznie prawdziwy, ale bezużyteczny: system zna
 * już zamierzony stan i ma przygotowaną zmianę.
 *
 * Rozwiązanie jest wyłącznie po stronie interpretacji wyniku. Monitoring
 * pozostaje read-only wobec WordPressa: NIC tutaj nie wykonuje poleceń,
 * nie omija WP_ALLOW_WRITES ani potwierdzenia.
 *
 * Wyciszenie jest wąskie z rozmysłem. Tłumimy różnicę tylko wtedy, gdy istnieje
 * jednoznacznie pasujące, jawnie zatwierdzone polecenie oczekujące na
 * wykonanie, i tylko przez ograniczony czas. Niezatwierdzone polecenie, tryb
 * próbny i niejednoznaczne dopasowanie nie wyciszają niczego.
 */

/** Ile godzin oczekujące polecenie może tłumić różnicę; potem samo staje się alertem. */
const PENDING_CHANGE_GRACE_HOURS = 48;

/**
 * Które pole polecenia odpowiada której różnicy w SEO LIVE.
 *
 * Mapowanie jest jawne i wąskie, bo wyciszenie na podstawie podobieństwa
 * tekstu byłoby furtką do tłumienia prawdziwych regresji. Czego tu nie ma,
 * tego nie wyciszamy.
 */
function pendingChangeAspects_() {
  return {
    'UPDATE_RANK_MATH_FIELD:rank_math_robots': 'robots:',
    'UPDATE_RANK_MATH_FIELD:rank_math_title': 'title:',
    'PUBLISH_PAGE:': 'status:'
  };
}

/** Aspekt różnicy, który dane polecenie może wyjaśnić; '' gdy żaden. */
function pendingChangeAspect_(action, field) {
  const key = String(action || '') + ':' + String(field || '');
  return pendingChangeAspects_()[key] || '';
}

/** Próg oczekiwania w godzinach; Script Property nadpisuje wartość domyślną. */
function pendingChangeGraceHours_() {
  const raw = String(PropertiesService.getScriptProperties().getProperty('SEO_LIVE_PENDING_GRACE_HOURS') || '').trim();
  const value = Number(raw);
  return raw !== '' && value > 0 ? value : PENDING_CHANGE_GRACE_HOURS;
}

/**
 * Publiczny adres strony o danym ID, na potrzeby dopasowania do wiersza
 * SEO LIVE. Wyłącznie odczyt. Brak konfiguracji WordPressa albo błąd
 * odpowiedzi oznacza brak dopasowania, a nie wyciszenie na wszelki wypadek.
 */
function pendingChangePageLink_(postId, cache) {
  const id = String(postId || '').trim();
  if (!/^\d+$/.test(id)) return '';
  if (Object.prototype.hasOwnProperty.call(cache, id)) return cache[id];

  let link = '';
  try {
    const response = wpFetch_('/wp-json/wp/v2/pages/' + encodeURIComponent(id) + '?context=edit&_fields=id,link');
    if (response.code >= 200 && response.code < 300 && response.json) {
      link = String(response.json.link || '');
    }
  } catch (e) {
    link = '';
  }

  cache[id] = link;
  return link;
}

/**
 * Oczekujące, zatwierdzone polecenia pogrupowane po znormalizowanym adresie.
 *
 * Zwraca { url: [{ id, aspect, createdAt, action, field }] }. Wiersz, którego
 * nie da się jednoznacznie powiązać z adresem, jest pomijany: brak dopasowania
 * ma prowadzić do zwykłego alertu, nie do ciszy.
 */
function pendingChangeIndex_(now) {
  const byUrl = {};
  const sheet = SpreadsheetApp.getActive().getSheetByName(WP_COMMANDS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return byUrl;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 13).getValues();
  const cache = {};

  rows.forEach(function (row) {
    const status = String(row[7] || '').trim().toUpperCase();
    const confirm = String(row[6] || '').trim().toUpperCase();
    // Tylko polecenie czekające na wykonanie i jawnie zatwierdzone. DRY_RUN,
    // DONE, ERROR i brak potwierdzenia nie są obietnicą żadnej zmiany.
    if (status !== 'PENDING' || confirm !== 'YES') return;

    const aspect = pendingChangeAspect_(row[2], row[4]);
    if (!aspect) return;

    const link = pendingChangePageLink_(row[3], cache);
    if (!link) return;

    const key = seoLiveNormalizeUrl_(link);
    if (!byUrl[key]) byUrl[key] = [];
    byUrl[key].push({
      id: String(row[0] || ''),
      aspect: aspect,
      createdAt: row[1],
      ageHours: pendingChangeAgeHours_(row[1], now)
    });
  });

  return byUrl;
}

/** Wiek polecenia w godzinach; nieczytelna data liczy się jako świeża. */
function pendingChangeAgeHours_(createdAt, now) {
  const time = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  if (!time || isNaN(time)) return 0;
  return Math.max(0, ((now || new Date()).getTime() - time) / 3600000);
}

/**
 * Klasyfikuje różnice wiersza wobec oczekujących poleceń.
 *
 * Zwraca { covered, overdue, ids }. `covered` znaczy, że KAŻDA różnica ma
 * pasujące polecenie: jedna niewyjaśniona różnica wystarczy, żeby wiersz
 * zachował się jak dotąd. `overdue` znaczy, że któreś z pasujących poleceń
 * czeka dłużej niż próg i samo w sobie jest problemem.
 */
function classifyPendingChange_(diffs, pending) {
  if (!diffs.length || !pending || !pending.length) return { covered: false, overdue: false, ids: [] };

  const grace = pendingChangeGraceHours_();
  const used = [];

  const covered = diffs.every(function (diff) {
    const match = pending.filter(function (p) { return diff.indexOf(p.aspect) === 0; })[0];
    if (!match) return false;
    if (used.indexOf(match) < 0) used.push(match);
    return true;
  });

  if (!covered) return { covered: false, overdue: false, ids: [] };

  return {
    covered: true,
    overdue: used.some(function (p) { return p.ageHours > grace; }),
    ids: used.map(function (p) { return p.id; }),
    grace: grace
  };
}
