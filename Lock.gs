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

/**
 * Wykonuje `fn` pod blokadą projektu albo rzuca błąd, gdy inne uruchomienie
 * jeszcze trwa. Blokada jest zwalniana także po błędzie.
 */
function withScriptLock_(label, fn) {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(SCRIPT_LOCK_TIMEOUT_MS)) {
    throw new Error(
      'Inne uruchomienie jeszcze trwa (' + label + '). Import, komendy WordPress i testy ' +
      'współdzielą jedną blokadę; spróbuj ponownie za chwilę.'
    );
  }

  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
