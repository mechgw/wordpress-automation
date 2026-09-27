/**
 * Blokada współbieżnych uruchomień (#52).
 *
 * Jeden globalny lock projektu (LockService.getScriptLock) obejmuje cały
 * krytyczny proces: import GSC, import GA4 i pętlę komend WordPress. Na
 * obecnej skali prostota jest ważniejsza od równoległości.
 *
 * Zasada: oczekiwanie jest krótkie i NIE kolejkujemy drugiego wykonania.
 * `tryLock` z krótkim limitem → brak blokady → koniec z czytelnym błędem.
 * Wolimy stracić jeden run (status importu zgłosi go jako BŁĄD) niż mieć dwa
 * procesy manipulujące tym samym arkuszem albo WordPressem.
 */

const SCRIPT_LOCK_TIMEOUT_MS = 5000;

/** Treść odmowy blokady; ta sama dla pracy pod blokadą i dla rejestratorów przebiegów. */
function scriptLockBusyMessage_(label) {
  return 'Inne uruchomienie jeszcze trwa (' + label + '). Importy i komendy WordPress ' +
    'współdzielą jedną blokadę; spróbuj ponownie za chwilę.';
}

/**
 * Wykonuje `fn` pod blokadą projektu albo rzuca błąd, gdy inne uruchomienie
 * jeszcze trwa. Blokada jest zwalniana także po błędzie.
 *
 * Wywołanie zagnieżdżone (to samo wykonanie już trzyma blokadę, np.
 * executeDryRunCommands → processWpCommands) nie przejmuje jej ponownie i jej
 * nie zwalnia; zwalnia tylko ta funkcja, która blokadę faktycznie przejęła.
 */
function withScriptLock_(label, fn) {
  const lock = LockService.getScriptLock();

  if (lock.hasLock()) {
    return fn();
  }

  if (!lock.tryLock(SCRIPT_LOCK_TIMEOUT_MS)) {
    throw new Error(scriptLockBusyMessage_(label));
  }

  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Blokada rejestratora przebiegu (#204): jeden pisarz wspólnego stanu.
 *
 * Rejestrator przejmuje blokadę PRZED odczytem rekordu i trzyma ją do końca
 * obsługi wyniku, a praca (`withScriptLock_` w środku) przechodzi gałęzią
 * wywołania zagnieżdżonego. Przed zwolnieniem `flush()`, żeby następny
 * posiadacz blokady widział wszystkie zapisy.
 *
 * Odmowa blokady nie jest przebiegiem: wykonanie bez blokady nie czyta ani nie
 * zapisuje wspólnego stanu. Z menu zostaje sam wyjątek (okno z tą samą treścią
 * co dotąd). Z triggera dodatkowo wpis oczekujący pod unikalnym kluczem, który
 * przejmie następny posiadacz blokady (`takeOverPendingRuns_`).
 */
function withRunLock_(key, trigger, fn) {
  // Walidacja klucza przed blokadą i przed pracą: rekord jest czytany dopiero po
  // pracy, więc nie może być jedyną kontrolą (uwaga Codexa w #210).
  const job = scheduledJob_(key);
  const lock = LockService.getScriptLock();

  if (lock.hasLock()) {
    return fn();
  }

  if (!lock.tryLock(SCRIPT_LOCK_TIMEOUT_MS)) {
    const message = scriptLockBusyMessage_(job.lockLabel || job.label);
    if (trigger) recordPendingRun_(key, message);
    throw new Error(message);
  }

  try {
    return fn();
  } finally {
    try {
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
  }
}
