# CLAUDE.md

Wskazówki dla agentów AI pracujących w tym repozytorium. Dla ludzi punktem wejścia jest README.md.

## Co to jest

Projekt Google Apps Script (przypięty do arkusza Google) automatyzujący zadania WordPress, Google
Search Console i GA4. Źródła to pliki `*.gs` plus `appsscript.json`. Repozytorium jest **publiczne**:
żadnych nazw firm, domen, identyfikatorów ani poświadczeń w kodzie, komentarzach, testach ani
fixture'ach. Tożsamość witryny żyje w Script Properties (`WP_REST_NAMESPACE`, `SITE_DOMAIN`, `WP_*`).

## Język

Cała komunikacja w repozytorium jest po polsku: issues, PR-y (tytuł po prefiksie i opis), komentarze,
dokumentacja, komunikaty w arkuszu, treść commitów poza prefiksem Conventional Commits. Nazwy
techniczne zostają w oryginale: nazwy checków (`validate`, `secret-scan`, `pr-title`, `review-ack`,
`pr-template`), właściwości, komend, funkcji i plików. Komentarze techniczne w workflow'ach i
skryptach przechodzą na polski przy okazji kolejnych zmian, bez masowego tłumaczenia.

## Przebieg pracy

1. Gałąź od `main`, PR z tytułem w konwencji Conventional Commits.
2. Wypełnij szablon PR-a: macierz testów + macierz dowodów
   ([docs/quality/test-matrix-template.md](docs/quality/test-matrix-template.md)).
3. Poczekaj na recenzję Copilota i Codexa. Przeczytaj każdy komentarz; wdroż albo odpowiedz w wątku
   i rozwiąż wątek. Ochrona gałęzi wymaga rozwiązanych wątków, a Codex potrafi dotrzeć kilka minut
   po Copilocie: przed merge'em sprawdź wątki jeszcze raz. Gdy bot nie zrecenzował z powodu limitu
   użycia, PR może wejść bez jego recenzji (decyzja właściciela z 2026-09-06), z jawną adnotacją
   w komentarzu `/reviewed`.
4. Opublikuj komentarz zaczynający się od `/reviewed` (liczą się tylko właściciel/współpracownicy).
   To zmienia check `review-ack` na zielony; nowy push albo nowa **recenzja** bota (obiekt review
   lub komentarz w kodzie) wymaga nowego `/reviewed`. Zwykłe komentarze botów do PR-a, np. komunikat
   o limicie użycia, nie.
5. Merge, gdy `validate`, `secret-scan`, `pr-title`, `review-ack` są zielone i wątki rozwiązane.
   Ochrona gałęzi jest ścisła: gałąź musi być aktualna względem `main`; PR w konflikcie nie dostaje
   w ogóle checków `pull_request` (merge `main` do gałęzi, push, ponowne `/reviewed`).
6. Publikacja draftu Release Draftera wdraża tag do Apps Script po zatwierdzeniu środowiska
   `production` przez właściciela. Rollback: uruchom *Deploy to Apps Script* z `deploy_ref=<tag>`.
   Deploy czerwony wyłącznie na kroku weryfikacji: uruchom ręcznie *Apps Script drift check*
   i pobierz artefakt z patchem, zanim cokolwiek zmienisz.

## Bramki jakości

- `npm run lint` — ESLint dla `*.gs` (globalne symbole Apps Script + funkcje między plikami),
  `test/`, `scripts/`; w tym `eol-last` (znak nowej linii na końcu pliku, Apps Script go wymaga).
- `npm test` — testy jednostkowe Node; pliki `.gs` działają w VM z zastubowanymi usługami Google
  (`test/helpers/gas.js`). Stub `Utilities.formatDate` formatuje w strefie maszyny: przed pushem
  uruchom też `TZ=UTC npm test`.
- `npm run quality:gate -- --changed=base:origin/main` — progi per plik
  (`.quality/coverage-policy.json`) i **100 % pokrycia zmienionych linii `*.gs`**; wyjątki
  z uzasadnieniem w `.quality/changed-lines-ignore.json`.
- Hook pre-commit (`.githooks/pre-commit`, instalowany przez `npm ci`) uruchamia to samo na plikach
  ze stage'a.
- Trzy punkty kontrolne, zawsze: testy lokalnie przed commitem, CI przed merge'em, workflow deployu
  przed `clasp push`. Nigdy nie omijaj jednego, żeby dotrzeć do następnego.
- Standardy: [docs/quality/testing-standard.md](docs/quality/testing-standard.md).

## Rób / nie rób

- Rozszerzaj stuby harnessu zamiast rejestrować wyjątki pokrycia.
- Trzymaj `Version.gs` jako placeholdery; workflow deployu go stempluje.
- Nowy plik `*.gs`: dopisz do `SOURCES` w `test/helpers/gas.js` i do `.quality/coverage-policy.json`.
- Nie uruchamiaj `clasp push` lokalnie; jedyną drogą do produkcji jest workflow deployu.
- Nie dotykaj `.clasp.json` / `.clasprc.json` (ignorowane przez gita, poświadczenia).
- Nie obniżaj progu pokrycia bez uzasadnienia i issue z follow-upem.
- Commituj przez `git add -A && git commit`, nie `git commit -a`; sprawdź kod wyjścia commitu, zanim
  odpowiesz w wątkach, wyślesz `/reviewed` albo zmergujesz.
