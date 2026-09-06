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
/** Klucz strażnika w rejestrze zadań cyklicznych (Status.gs). */
const ALERT_GUARD_JOB_KEY = 'ALERTS';
const ALERT_GUARD_HOUR = 8;

/** Ostatni powód niewysłania e-maila w tym uruchomieniu (dla okna strażnika). */
const ALERT_STATE_ = { lastError: '' };

/**
 * Adres lub lista adresów rozdzielona przecinkami, każdy w postaci nazwa@domena.tld.
 * Pusty element (przecinek na końcu, podwójny przecinek) unieważnia całość,
 * żeby do MailApp nigdy nie trafiła lista, której sam by nie przyjął.
 */
function isValidEmailList_(value) {
  const parts = String(value || '').split(',').map(p => p.trim());
  return parts.every(p => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(p));
}

/**
 * Konfiguracja alertów. `raw` to surowa wartość ALERT_EMAIL, `valid` mówi, czy
 * wygląda jak adres; `email` jest puste, gdy adresu brak lub jest nieprawidłowy,
 * więc wysyłka nigdy nie jest próbowana na wartość typu "TRUE".
 */
function alertConfig_() {
  const props = PropertiesService.getScriptProperties();
  const raw = String(props.getProperty('ALERT_EMAIL') || '').trim();
  const valid = raw !== '' && isValidEmailList_(raw);
  return {
    raw,
    valid,
    email: valid ? raw.split(',').map(p => p.trim()).join(',') : '',
    recovery: String(props.getProperty('ALERT_RECOVERY') || 'TRUE').toUpperCase() !== 'FALSE'
  };
}

/** Tekst o adresacie do okien dialogowych: adres, brak albo jawnie błędna wartość. */
function alertRecipientText_() {
  const cfg = alertConfig_();
  if (!cfg.raw) return 'wyłączone (brak ALERT_EMAIL)';
  if (!cfg.valid) return 'NIEPRAWIDŁOWY ADRES („' + cfg.raw + '”) – popraw Script Property ALERT_EMAIL';
  return cfg.email;
}

function spreadsheetUrl_() {
  const ss = SpreadsheetApp.getActive();
  return ss && typeof ss.getUrl === 'function' ? String(ss.getUrl() || '') : '';
}

/**
 * Wysyła e-mail, jeśli skonfigurowano adresata. Zwraca true, gdy wysłano.
 * Wysyłka jest best-effort: błąd MailApp (limit dzienny, zły adres) jest
 * logowany i zwracany jako false, nigdy nie zmienia wyniku importu ani strażnika.
 */
function sendImportAlert_(subject, lines) {
  const cfg = alertConfig_();
  if (!cfg.raw) {
    ALERT_STATE_.lastError = 'brak Script Property ALERT_EMAIL';
    return false;
  }
  if (!cfg.valid) {
    ALERT_STATE_.lastError = 'nieprawidłowy adres w ALERT_EMAIL („' + cfg.raw + '”)';
    Logger.log('Alert e-mail nie został wysłany (' + subject + '): ' + ALERT_STATE_.lastError);
    return false;
  }
  const body = lines.concat(['', 'Arkusz: ' + spreadsheetUrl_(), 'Wersja skryptu: ' + versionLabel_()]).join('\n');
  try {
    MailApp.sendEmail(cfg.email, '[wordpress-automation] ' + subject, body);
    ALERT_STATE_.lastError = '';
    return true;
  } catch (e) {
    ALERT_STATE_.lastError = String(e && e.message ? e.message : e);
    Logger.log('Alert e-mail nie został wysłany (' + subject + '): ' + ALERT_STATE_.lastError);
    return false;
  }
}

/** E-mail otwierający incydent (błąd lub anomalia). Zwraca true, gdy wysłano. */
function sendIncidentOpenedAlert_(label, run, record, problem, now) {
  return sendImportAlert_(
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
}

/**
 * Aktualizuje incydent źródła po zapisanym runie. Wywoływane przez
 * recordImportRun_ z rekordem, który ma już lastRun (i lastOk przy sukcesie).
 * Zwraca 'opened' | 'closed' | '' i zapisuje rekord, gdy stan się zmienił.
 */
function updateImportIncident_(source, record) {
  const run = record.lastRun || {};
  const incident = record.incident && record.incident.open ? record.incident : null;
  const label = jobLabel_(source);
  const now = new Date().toISOString();

  let problem = null;
  if (!run.ok) {
    problem = { reason: 'error', detail: String(run.error || 'nieznany błąd') };
  } else if (run.anomaly) {
    problem = { reason: 'anomaly', detail: String(run.anomaly) };
  }

  if (problem && !incident) {
    // Najpierw zapis incydentu, potem e-mail: awaria wysyłki nie gubi stanu.
    record.incident = { open: true, reason: problem.reason, detail: problem.detail, openedAt: now, notifiedAt: '' };
    writeJobRecord_(source, record);
    if (sendIncidentOpenedAlert_(label, run, record, problem, now)) {
      record.incident.notifiedAt = now;
      writeJobRecord_(source, record);
    }
    return 'opened';
  }

  if (problem && incident) {
    // Incydent trwa: aktualizujemy powód/szczegóły. Cisza, chyba że e-mail
    // otwierający nigdy nie wyszedł (brak adresu, limit) – wtedy próbujemy ponownie.
    record.incident = Object.assign({}, incident, { reason: problem.reason, detail: problem.detail });
    if (!incident.notifiedAt && sendIncidentOpenedAlert_(label, run, record, problem, now)) {
      record.incident.notifiedAt = now;
    }
    writeJobRecord_(source, record);
    return '';
  }

  if (!problem && incident) {
    record.incident = Object.assign({}, incident, { open: false, closedAt: now });
    writeJobRecord_(source, record);
    if (alertConfig_().recovery) {
      // Import raportuje liczbę wierszy; zadanie monitorujące nie ma wierszy,
      // więc mówi tylko, co zrobiło.
      const isImport = Boolean(importSources_()[source]);
      sendImportAlert_((isImport ? 'Import ponownie działa: ' : 'Zadanie ponownie działa: ') + label, [
        'Źródło: ' + label,
        'Czas: ' + formatImportTime_(run.finishedAt || now),
        isImport
          ? 'Wiersze: ' + (Number(run.rows) || 0) + (run.detail ? ' (' + run.detail + ')' : '')
          : 'Szczegóły: ' + (run.detail || 'przebieg zakończony poprawnie'),
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
 * znowu aktualne (z opcjonalnym mailem). Handler triggera; z menu używaj
 * sprawdzAktualnoscImportowZMenu. Zwraca { opened, closed, mail } – `mail` to
 * czytelny opis, czy i jaki e-mail wyszedł (albo dlaczego nie).
 */
function sprawdzAktualnoscImportow() {
  const now = new Date();
  const opened = [];
  const closed = [];
  const mail = [];
  const describeSend = (subject, sent) => mail.push(sent ? 'wysłany („' + subject + '”)' : 'nie wysłano („' + subject + '”): ' + ALERT_STATE_.lastError);
  const toNotify = []; // incydenty 'stale' bez wysłanego e-maila: nowe i te z dni bez ALERT_EMAIL
  let checked = 0;

  // Wszystkie zadania cykliczne, nie tylko importy: zadanie, które przestało
  // działać, jest nieodróżnialne od zadania bez nowych zgłoszeń (#99).
  //
  // Poza samym strażnikiem: gdyby stanął, nie miałby jak zgłosić własnej awarii,
  // a przy pierwszym uruchomieniu otwierałby incydent o sobie. Martwego
  // strażnika wykrywa diagnostyka, sprawdzająca zainstalowane triggery (#100).
  scheduledJobs_().filter(job => job.key !== ALERT_GUARD_JOB_KEY).map(job => job.key).forEach(source => {
    const record = readJobRecord_(source);

    // Opcjonalne zadanie, które nigdy nie zapisało przebiegu, wymaga rozróżnienia
    // trzech sytuacji, bo każda znaczy co innego:
    //
    //   bez triggera  – nieużywane, nie zepsute; milczymy;
    //   z triggerem, pierwsza obserwacja – zadanie działa od dawna, tylko znacznik
    //     pojawił się razem z monitoringiem; dajemy mu jego własny próg na
    //     pierwszy przebieg, zamiast ogłaszać awarię tego samego ranka;
    //   z triggerem, próg minął bez przebiegu – to już realna awaria.
    //
    // Importu ten wyjątek nie obejmuje: brak importu jest incydentem od razu.
    if (scheduledJob_(source).optional && !record.lastRun && !effectiveLastOk_(record)) {
      if (!hasImportTrigger_(source)) return;
      if (!record.waitingSince) {
        record.waitingSince = now.toISOString();
        writeJobRecord_(source, record);
        return;
      }
      if (!isJobStale_(source, { finishedAt: record.waitingSince }, now)) return;
    }

    checked++;
    const stale = isJobStale_(source, effectiveLastOk_(record), now);
    const incident = record.incident && record.incident.open ? record.incident : null;
    const label = jobLabel_(source);

    if (stale && !incident) {
      record.incident = { open: true, reason: 'stale', detail: jobStatusText_(source, now), openedAt: now.toISOString(), notifiedAt: '' };
      writeJobRecord_(source, record);
      opened.push(label);
      toNotify.push({ source, record, line: label + ': ' + record.incident.detail });
    } else if (stale && incident && incident.reason === 'stale' && !incident.notifiedAt) {
      toNotify.push({ source, record, line: label + ': ' + incident.detail });
    } else if (!stale && incident && incident.reason === 'stale') {
      record.incident = Object.assign({}, incident, { open: false, closedAt: now.toISOString() });
      writeJobRecord_(source, record);
      closed.push(label + ': ' + jobStatusText_(source, now));
    }
  });

  if (toNotify.length) {
    const subject = 'NIEAKTUALNE: ' + toNotify.length + ' zadanie(a)';
    const sent = sendImportAlert_(subject, [
      'Codzienny strażnik wykrył zadania, które nie mają świeżego udanego przebiegu:',
      ''
    ].concat(toNotify.map(n => '- ' + n.line)).concat(['', 'Kolejne dni nie będą zgłaszane, dopóki zadanie nie wróci do normy.']));
    describeSend(subject, sent);
    if (sent) {
      toNotify.forEach(n => {
        n.record.incident = Object.assign({}, n.record.incident, { notifiedAt: now.toISOString() });
        writeJobRecord_(n.source, n.record);
      });
    }
  }
  if (closed.length) {
    const subject = 'Znowu aktualne: ' + closed.length + ' zadanie(a)';
    if (alertConfig_().recovery) {
      describeSend(subject, sendImportAlert_(subject, closed.map(c => '- ' + c)));
    } else {
      mail.push('pominięty („' + subject + '”): ALERT_RECOVERY=FALSE');
    }
  }

  // Codzienny przebieg to naturalny moment na odnotowanie stanu flag zapisu (#104).
  observeWriteFlags_(now);

  // Własny przebieg zapisujemy na końcu, żeby „Status danych” pokazywał, kiedy
  // strażnik ostatnio działał.
  const guard = readJobRecord_(ALERT_GUARD_JOB_KEY);
  guard.lastRun = { finishedAt: now.toISOString(), ok: true, trigger: true, detail: 'sprawdzone zadania: ' + checked };
  guard.lastOk = guard.lastRun;
  writeJobRecord_(ALERT_GUARD_JOB_KEY, guard);

  return { opened: opened.length, closed: closed.length, mail: mail.length ? mail.join('; ') : 'niepotrzebny (bez zmian)' };
}

/** Strażnik uruchomiony z menu: to samo co trigger, plus okno z wynikiem. */
function sprawdzAktualnoscImportowZMenu() {
  const out = sprawdzAktualnoscImportow();
  const now = new Date();
  const lines = ['Sprawdzono aktualność zadań cyklicznych:'];
  scheduledJobs_().forEach(job => {
    lines.push('- ' + jobLabel_(job.key) + ': ' + jobStatusText_(job.key, now));
  });
  lines.push('');
  lines.push('Otwarte incydenty (nieaktualne dane): ' + out.opened);
  lines.push('Zamknięte incydenty (dane znowu aktualne): ' + out.closed);
  lines.push('E-mail: ' + out.mail);
  lines.push('Adresat: ' + alertRecipientText_());
  SpreadsheetApp.getUi().alert(lines.join('\n'));
  return out;
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
    (cfg.valid ? 'Alerty trafią na: ' + cfg.email
      : cfg.raw ? 'UWAGA: ALERT_EMAIL ma nieprawidłową wartość („' + cfg.raw + '”), alerty nie będą wysyłane.'
        : 'UWAGA: brak Script Property ALERT_EMAIL, alerty nie będą wysyłane.')
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
    (inc.notifiedAt ? ', e-mail wysłany' : ', bez e-maila');
}
