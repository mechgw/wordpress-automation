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
    throw new Error(
      'Inne uruchomienie jeszcze trwa (' + label + '). Importy i komendy WordPress ' +
      'współdzielą jedną blokadę; spróbuj ponownie za chwilę.'
    );
  }

  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
