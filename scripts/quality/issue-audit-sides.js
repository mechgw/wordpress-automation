'use strict';

/**
 * Strony bramki audytu specyfikacji (#231): kto napisał treść issue i kto
 * napisał komentarz.
 *
 * README: „Kto napisał specyfikację, ten jej nie audytuje”. Wszystko idzie
 * z jednego konta GitHuba, więc strony wyznaczają sygnały protokołu, nie pole
 * `author`:
 *   - podpis ostatniej niepustej linii (`_— Claude Code (agent lokalny)_`,
 *     `_— ChatGPT_`),
 *   - etykieta `by:agent`, którą nadaje wyłącznie agent lokalny,
 *   - aplikacja, przez którą powstał wpis (`performed_via_github_app`): ChatGPT
 *     pisze przez „ChatGPT Codex Connector”, Claude Code przez `gh` (pole puste).
 *
 * Autora treści ustala dopiero zgodność wszystkich trzech sygnałów; każda
 * niezgodność, także brak podpisu, daje autorstwo nieustalone, a to znaczy
 * „nikt nie jest ustalonym recenzentem” (fail-closed). Podpisy i etykiety to
 * protokół, nie techniczny dowód odrębności sesji: bramka sprawdza tylko to,
 * co da się odczytać.
 *
 * Wzorzec: port logiki z prywatnego repozytorium narzędzi (ten sam model
 * reconcilera, wersja w Pythonie).
 */

const CLAUDE = 'claude';
const GPT = 'gpt';
const GPT_APP = 'ChatGPT Codex Connector';
const BY_AGENT = 'by:agent';

// Podpisy zaczynają się od półpauzy (U+2014). Podpis Claude Code może mieć
// w nawiasie dopisek roli po przecinku (`agent lokalny, koordynator`): rola nie
// zmienia strony, a koordynator tak podpisuje swoje wpisy. Wzorce, nie tablica
// kluczy: obiekt „znalazłby” `constructor` albo `__proto__` jako podpis.
const DASH = String.fromCharCode(0x2014);
const SIGNATURES = [
  [new RegExp('^' + DASH + ' Claude Code \\(agent lokalny(?:, [^()]+)?\\)$'), CLAUDE],
  [new RegExp('^' + DASH + ' ChatGPT$'), GPT]
];

// Aplikacja wymagana dla strony: puste pole znaczy „przez gh”.
const SIDE_APP = { [CLAUDE]: '', [GPT]: GPT_APP };

// Cztery spacje albo tabulator (także po 1-3 spacjach) na początku linii to
// w Markdown blok kodu: cytowany przykład komendy albo podpisu nie może stać
// się werdyktem ani podpisem.
const INDENTED_CODE = /^(?: {4,}| {0,3}\t)/;

/** Niepuste linie tekstu, z CRLF i samotnym CR; linia z samych spacji jest pusta. */
function nonEmptyLines(text) {
  return String(text ?? '')
    .split(/\r\n|\r|\n/)
    .filter(line => line.trim());
}

/**
 * Pierwsza niepusta linia, przycięta; '' gdy tekstu nie ma albo ta linia jest
 * wcięta jak blok kodu. Tylko ona może zawierać komendę.
 */
function leadingLine(text) {
  const line = nonEmptyLines(text)[0] || '';
  return INDENTED_CODE.test(line) ? '' : line.trim();
}

/**
 * Strona podpisana w ostatniej niepustej linii (`claude`/`gpt`); '' gdy brak.
 * Akceptujemy podpis kanoniczny w kursywie `_..._` albo goły. Wcięty (kod),
 * przekręcony albo nie w ostatniej linii nie jest podpisem.
 */
function signatureSide(text) {
  const lines = nonEmptyLines(text);
  const last = lines[lines.length - 1];
  if (last === undefined || INDENTED_CODE.test(last)) return '';
  const signature = last.trim();
  const italic = /^_(.+)_$/.exec(signature);
  const unwrapped = italic ? italic[1] : signature;
  const found = SIGNATURES.find(entry => entry[0].test(unwrapped));
  return found ? found[1] : '';
}

/** Strona przeciwna: recenzent treści napisanej przez `side`; '' gdy autor nieustalony. */
function reviewerOf(side) {
  if (side === CLAUDE) return GPT;
  return side === GPT ? CLAUDE : '';
}

/**
 * Autor BIEŻĄCEJ treści issue: `{ side: 'claude'|'gpt'|'', reason }`.
 *
 * `app` (aplikacja issue) mówi, kto UTWORZYŁ issue, nie kto napisał obecną
 * treść; `by:agent` nadaje tylko agent lokalny; podpis mówi, kto podpisał
 * bieżącą wersję. Autor jest ustalony tylko wtedy, gdy wszystkie trzy się
 * zgadzają - przejęcie cudzej treści albo brak etykiety daje autorstwo
 * nieustalone, a nie domysł.
 */
function authorSide(body, labels, app) {
  const signed = signatureSide(body);
  const byAgent = Boolean(labels?.includes(BY_AGENT));
  const via = String(app || '');
  if (!signed) return { side: '', reason: 'brak podpisu strony w ostatniej linii treści' };
  if (via !== SIDE_APP[CLAUDE] && via !== SIDE_APP[GPT]) {
    return { side: '', reason: 'zgłoszenie utworzone przez nieznaną aplikację ' + JSON.stringify(via) };
  }
  if (signed === CLAUDE) return claudeAuthor(byAgent, via);
  return gptAuthor(byAgent, via);
}

function claudeAuthor(byAgent, via) {
  if (!byAgent) return { side: '', reason: 'podpis Claude Code bez etykiety by:agent' };
  if (via !== SIDE_APP[CLAUDE]) {
    return { side: '', reason: 'podpis Claude Code, ale zgłoszenie utworzył ' + GPT_APP };
  }
  return { side: CLAUDE, reason: 'podpis Claude Code + by:agent + utworzone przez gh' };
}

function gptAuthor(byAgent, via) {
  if (byAgent) return { side: '', reason: 'podpis ChatGPT przy etykiecie by:agent' };
  if (via !== SIDE_APP[GPT]) {
    return { side: '', reason: 'podpis ChatGPT, ale zgłoszenia nie utworzył ' + GPT_APP };
  }
  return { side: GPT, reason: 'podpis ChatGPT + bez by:agent + utworzone przez ' + GPT_APP };
}

/**
 * Strona komentarza: podpis zgodny z aplikacją, przez którą komentarz powstał;
 * '' gdy podpisu nie ma albo aplikacja się z nim nie zgadza (np. podpis ChatGPT
 * wysłany przez `gh` nie dowodzi, że pisał ChatGPT).
 */
function commentSide(comment) {
  const signed = signatureSide(comment.body);
  return signed && String(comment.app || '') === SIDE_APP[signed] ? signed : '';
}

module.exports = {
  CLAUDE,
  GPT,
  GPT_APP,
  BY_AGENT,
  leadingLine,
  signatureSide,
  reviewerOf,
  authorSide,
  commentSide
};
