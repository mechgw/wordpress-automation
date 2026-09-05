/**
 * Alerty e-mail o imporcie (#42), zbudowane na modelu stanu z Status.gs.
 *
 * Zamiast maila przy każdym zdarzeniu działa model incydentu per źródło:
 *   OK → problem   : jeden e-mail otwierający incydent (błąd, anomalia albo
 *                    nieaktualne dane),
 *   problem → problem : cisza, dopóki incydent jest otwarty,
 *   problem → OK   : incydent zamknięty; opcjonalny e-mail „import ponownie działa”.
 *
 * Konfiguracja (Script Properties):
 *   ALERT_EMAIL     adresat; brak = brak alertów, bez błędu
 *   ALERT_RECOVERY  'FALSE' wyłącza e-mail o powrocie do normy (domyślnie włączony)
 *
 * Stan incydentu jest częścią rekordu LAST_IMPORT_*:
 *   incident: { open, reason ('error'|'anomaly'|'stale'), openedAt, detail, notifiedAt }
 *
 * Codzienny strażnik `sprawdzAktualnoscImportow` (trigger ok. 08:00, po obu
 * importach) otwiera incydent 'stale', gdy źródło jest NIEAKTUALNE, i wysyła
 * jeden zbiorczy e-mail; przy otwartym incydencie milczy.
 */

const ALERT_GUARD_HANDLER = 'sprawdzAktualnoscImportow';
const ALERT_GUARD_HOUR = 8;

function alertConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    email: String(props.getProperty('ALERT_EMAIL') || '').trim(),
    recovery: String(props.getProperty('ALERT_RECOVERY') || 'TRUE').toUpperCase() !== 'FALSE'
  };
}

function spreadsheetUrl_() {
  const ss = SpreadsheetApp.getActive();
  return ss && typeof ss.getUrl === 'function' ? String(ss.getUrl() || '') : '';
}

/** Wysyła e-mail, jeśli skonfigurowano adresata. Zwraca true, gdy wysłano. */
function sendImportAlert_(subject, lines) {
  const cfg = alertConfig_();
  if (!cfg.email) return false;
  const body = lines.concat(['', 'Arkusz: ' + spreadsheetUrl_(), 'Wersja skryptu: ' + versionLabel_()]).join('\n');
  MailApp.sendEmail(cfg.email, '[wordpress-automation] ' + subject, body);
  return true;
}

/**
 * Aktualizuje incydent źródła po zapisanym runie. Wywoływane przez
 * recordImportRun_ z rekordem, który ma już lastRun (i lastOk przy sukcesie).
 * Zwraca 'opened' | 'closed' | '' i zapisuje rekord, gdy stan się zmienił.
 */
function updateImportIncident_(source, record) {
  const run = record.lastRun || {};
  const incident = record.incident && record.incident.open ? record.incident : null;
  const label = importSource_(source).label;
  const now = new Date().toISOString();

  let problem = null;
  if (!run.ok) {
    problem = { reason: 'error', detail: String(run.error || 'nieznany błąd') };
  } else if (run.anomaly) {
    problem = { reason: 'anomaly', detail: String(run.anomaly) };
  }

  if (problem && !incident) {
    record.incident = { open: true, reason: problem.reason, detail: problem.detail, openedAt: now, notifiedAt: '' };
    const sent = sendImportAlert_(
      (problem.reason === 'error' ? 'BŁĄD importu: ' : 'UWAGA, mało danych: ') + label,
      [
        'Źródło: ' + label,
        'Czas: ' + formatImportTime_(run.finishedAt || now),
        'Uruchomienie: ' + (run.trigger ? 'trigger' : 'ręczne'),
        (problem.reason === 'error' ? 'Błąd: ' : 'Szczegóły: ') + problem.detail,
        record.lastOk && record.lastOk.finishedAt ? 'Ostatni poprawny import: ' + formatImportTime_(record.lastOk.finishedAt) : 'Brak poprawnego importu.',
        '',
        'Kolejne wystąpienia tego problemu nie będą zgłaszane, dopóki import nie wróci do normy.'
      ]
    );
    if (sent) record.incident.notifiedAt = now;
    writeImportRecord_(source, record);
    return 'opened';
  }

  if (problem && incident) {
    // Incydent trwa: aktualizujemy powód/szczegóły bez kolejnego maila.
    record.incident = Object.assign({}, incident, { reason: problem.reason, detail: problem.detail });
    writeImportRecord_(source, record);
    return '';
  }

  if (!problem && incident) {
    record.incident = Object.assign({}, incident, { open: false, closedAt: now });
    writeImportRecord_(source, record);
    if (alertConfig_().recovery) {
      sendImportAlert_('Import ponownie działa: ' + label, [
        'Źródło: ' + label,
        'Czas: ' + formatImportTime_(run.finishedAt || now),
        'Wiersze: ' + (Number(run.rows) || 0) + (run.detail ? ' (' + run.detail + ')' : ''),
        'Incydent trwał od: ' + formatImportTime_(incident.openedAt) + ' (' + incident.reason + ')'
      ]);
    }
    return 'closed';
  }

  return '';
}

/**
 * Codzienny strażnik: dla każdego źródła sprawdza NIEAKTUALNE; otwiera incydent
 * 'stale' i wysyła jeden zbiorczy e-mail; zamyka incydent 'stale', gdy dane są
 * znowu aktualne (z opcjonalnym mailem). Zwraca { opened: [], closed: [] }.
 */
function sprawdzAktualnoscImportow() {
  const now = new Date();
  const opened = [];
  const closed = [];

  Object.keys(importSources_()).forEach(source => {
    const record = readImportRecord_(source);
    const stale = isImportStale_(record.lastOk, now);
    const incident = record.incident && record.incident.open ? record.incident : null;
    const label = importSource_(source).label;

    if (stale && !incident) {
      record.incident = { open: true, reason: 'stale', detail: importStatusText_(source, now), openedAt: now.toISOString(), notifiedAt: now.toISOString() };
      writeImportRecord_(source, record);
      opened.push(label + ': ' + record.incident.detail);
    } else if (!stale && incident && incident.reason === 'stale') {
      record.incident = Object.assign({}, incident, { open: false, closedAt: now.toISOString() });
      writeImportRecord_(source, record);
      closed.push(label + ': ' + importStatusText_(source, now));
    }
  });

  if (opened.length) {
    sendImportAlert_('NIEAKTUALNE dane: ' + opened.length + ' źródło(a)', [
      'Codzienny strażnik wykrył nieaktualne dane (starsze niż ' + IMPORT_STALE_AFTER_HOURS + ' h):',
      ''
    ].concat(opened.map(o => '- ' + o)).concat(['', 'Kolejne dni nie będą zgłaszane, dopóki import nie wróci do normy.']));
  }
  if (closed.length && alertConfig_().recovery) {
    sendImportAlert_('Dane znowu aktualne: ' + closed.length + ' źródło(a)', closed.map(c => '- ' + c));
  }

  return { opened: opened.length, closed: closed.length };
}

/** Instaluje codzienny trigger strażnika (ok. 08:00, po imporcie GSC i GA4). */
function ustawCodzienneAlerty() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === ALERT_GUARD_HANDLER)
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger(ALERT_GUARD_HANDLER)
    .timeBased()
    .everyDays(1)
    .atHour(ALERT_GUARD_HOUR)
    .create();

  const cfg = alertConfig_();
  SpreadsheetApp.getUi().alert(
    'Codzienny strażnik aktualności został ustawiony (ok. ' + ALERT_GUARD_HOUR + ':00).\n' +
    (cfg.email ? 'Alerty trafią na: ' + cfg.email : 'UWAGA: brak Script Property ALERT_EMAIL, alerty nie będą wysyłane.')
  );
}

function hasAlertGuardTrigger_() {
  return ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === ALERT_GUARD_HANDLER);
}

/** Jedna linia o incydencie do okna „Status danych”. */
function incidentSummary_(record) {
  const inc = record && record.incident;
  if (!inc || !inc.open) return 'Incydent: brak';
  return 'Incydent: OTWARTY od ' + formatImportTime_(inc.openedAt) + ' (' + inc.reason + ')' +
    (inc.notifiedAt ? ', e-mail wysłany' : ', bez e-maila (brak ALERT_EMAIL)');
}
