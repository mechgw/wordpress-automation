# Zapadka długu rozmiaru i złożoności

Zgłoszenie: #240 (silnik). Konkretne miary dołączają osobne zgłoszenia, każda jako jeden klucz w pliku limitów.

Zasada: **dług może tylko maleć**. Nowy kod mieści się w limitach bez wyjątków, a istniejące przekroczenia
są zapisane w bazie i nie mogą urosnąć. Silnik: `scripts/quality/debt-ratchet.js`
(`npm run quality:debt`), testy: `test/debt-ratchet.test.js`.

## Pliki

| Plik | Co zawiera |
| --- | --- |
| `.quality/debt-limits.json` | zakresy (wzorce plików, typ źródła, tryb kluczy) i limity miar; **jedyne miejsce progów** |
| `.quality/debt-baseline.json` | dług istniejący w dniu wprowadzenia miary: funkcje (skrót AST ciała i miary) oraz pliki (miary) |
| `scripts/quality/debt-ratchet.js` | silnik: pomiar ESLintem, klucze funkcji, porównanie, baza i stan bazowy z gita |

Plik limitów i baza to pliki bramki: zmiana wymaga przeglądu jak `.quality/coverage-policy.json`.

## Miary

Miara to klucz w `limits` zakresu. Znane miary i reguły ESLint, z których silnik je czyta:

| Klucz | Poziom | Reguła ESLint | Co liczy |
| --- | --- | --- | --- |
| `complexity` | funkcja | `complexity` | złożoność cyklomatyczna |
| `lines` | funkcja | `max-lines-per-function` | linie kodu bez pustych i komentarzy, razem z funkcjami zagnieżdżonymi |
| `statements` | funkcja | `max-statements` | instrukcje |
| `params` | funkcja | `max-params` | parametry |
| `depth` | funkcja | `max-depth` | największe zagnieżdżenie bloków; komunikat ESLint jest per blok, silnik przypisuje maksimum do najwęższej funkcji |
| `fileLines` | plik | `max-lines` | linie kodu pliku bez pustych i komentarzy |

Wartość jest czytana z komunikatu ESLint (`Maximum allowed is N` to limit, w nawiasie jest wartość).
Format komunikatów jest przypięty wersją ESLint w `package-lock.json`, a test
(`miary z komunikatów ESLint`) uruchamia prawdziwy ESLint na kodzie o znanych wartościach, więc zmiana
formatu zaczerwieni testy zamiast cicho zmienić wynik.

Dodanie miary: jeden klucz w `limits` zakresu (np. `"complexity": 12`) i `node scripts/quality/debt-ratchet.js
write-baseline`; PR zawiera wynik w bazie. Miara spoza tabeli (np. liczba funkcji w pliku) wymaga rozszerzenia
`METRICS` w silniku i testu.

## Zakresy i klucze funkcji

Każdy zakres ma `files` (wzorce względem korzenia repo; muszą kończyć się rozszerzeniem, ESLint inaczej pomija plik),
`sourceType` (`script` dla `.gs`, `commonjs` dla skryptów Node) i `keyMode`.

Klucz funkcji w bazie: `zakres::nazwa`. W Apps Script wszystkie funkcje top-level dzielą jedną przestrzeń nazw
(`keyMode: global`), więc przeniesienie funkcji do innego pliku nie zmienia klucza. W modułach (`keyMode: file`) do
klucza dochodzi ścieżka pliku. Dalej:

- funkcje zagnieżdżone: `zewnętrzna>wewnętrzna`,
- funkcje anonimowe i przypisane do właściwości obiektu: `zewnętrzna>#<8 znaków skrótu ciała>`; klucz zależy od
  ciała, nie od kolejności, więc dopisanie nowej funkcji anonimowej przed dotychczasową go nie zmienia,
- identyczne klucze w jednym miejscu dostają sufiks `~2`, `~3` w kolejności położenia; funkcje o tej samej nazwie
  i różnych ciałach są dodatkowo zgłaszane jako `key-conflict` (informacja).

Skrót to SHA-1 z AST ciała bez pozycji (`espree`, wersja przypięta lockiem, jawna zależność deweloperska).
Komentarze, odstępy i położenie go nie zmieniają. **Zmiana wersji `espree` albo ESLint to migracja bazy** (patrz niżej).

## Reguły

Wynik `RED` blokuje (kod 1) w trybie `--mode=enforce`; w `--mode=report` silnik tylko raportuje (kod 0).

| Kod | Reguła |
| --- | --- |
| `over-limit-no-entry` | funkcja ponad limit bez wpisu w bazie |
| `metric-without-entry` | funkcja ma wpis, ale nie dla tej miary |
| `growth` | miara rośnie względem wpisu |
| `shrink` | miara spadła: lokalnie informacja, w CI czerwone (wpis trzeba obniżyć w tym samym PR) |
| `repaid` | miara poniżej limitu: lokalnie informacja, w CI czerwone (usuń miarę z wpisu) |
| `entry-without-function` | wpis bez funkcji (usunięta albo zmieniona) |
| `entry-renamed` | funkcja ma nowy klucz, ten sam skrót ciała: przenieś wpis |
| `file-*` | to samo dla miar plików (`file-over-limit-no-entry`, `file-growth`, `file-shrink`, `file-repaid`, `file-entry-without-file`, `file-metric-without-entry`) |
| `new-entry`, `new-file-entry` | baza z PR ma nowy wpis względem stanu bazowego (patrz niżej) |
| `growth-vs-base`, `file-growth-vs-base` | wpis rośnie względem stanu bazowego |

### Dług nie wchodzi przez dopisanie wpisu

`--base=<ref>` (w CI SHA bazowy PR, lokalnie `origin/main`) wczytuje ze stanu `ref` bazę, limity i skróty funkcji
oraz plików. Baza z PR może wobec niej wyłącznie **obniżać albo usuwać wpisy**. Nowa para (klucz, miara) jest
dozwolona tylko gdy:

1. na `ref` nie ma bazy (jednorazowy import; silnik pisze `INFO import`), albo
2. miara jest **nowa lub zaostrzona w tym PR** (porównanie limitów z `ref`) **i** funkcja (plik) jest niezmieniona
   względem `ref`: ten sam skrót w bazie, na `ref` i w bieżącym kodzie, albo
3. wpis jest **przeniesieniem** istniejącego wpisu pod nowy klucz (ten sam skrót, stary klucz usunięty, wartość nie
   większa); każdy stary wpis przenosi się najwyżej raz, więc kopie usuniętej funkcji pod nowymi nazwami nie powielają długu.

Czyli nowa funkcja ponad limit z dopisanym wpisem jest czerwona, podobnie funkcja zmieniona w PR, która przy
wprowadzaniu miary dostaje wpis. Wzrost istniejącego wpisu względem `ref` jest czerwony **także z uzasadnieniem**;
jedyny wyjątek to migracja po zmianie wersji narzędzia (poniżej).

Bez `--base` silnik pisze `INFO no-base` i nie sprawdza nowych wpisów. Nieznany ref to błąd (kod 2); w CI potrzebna
jest pełna historia (`fetch-depth: 0`, jest w `ci.yml`).

## Migracja po zmianie wersji ESLint albo espree

Baza zapisuje wersje narzędzi (`tool`). Gdy się zmienią, silnik pisze `INFO tool-changed`. Procedura: osobny PR,
`node scripts/quality/debt-ratchet.js write-baseline` (przelicza skróty i wartości), wzrost wartości wpisu względem
`main` wolno wprowadzić tylko z polem `"uzasadnienie"` we wpisie, gdy funkcja jest niezmieniona: ten sam skrót we wpisie,
na `main` (liczony bieżącym narzędziem) i w kodzie z PR. Różnica wartości bez zmiany kodu wynika wtedy z nowego sposobu
liczenia, nie z nowego długu.

## Uruchamianie

```
npm run quality:debt -- --mode=report --base=origin/main     # lokalnie, jak w hooku
node scripts/quality/debt-ratchet.js write-baseline          # zapis bazy z bieżącego kodu
```

Kody wyjścia: 0 zielono (albo tryb raportu), 1 czerwono, 2 błąd użycia lub narzędzia (zła konfiguracja, błąd składni
w źródle, nieznany ref, nieznany format komunikatu ESLint). Błąd nigdy nie kończy się zielonym wynikiem.

W `GITHUB_ACTIONS` (albo z `--ci`) naruszenia dostają adnotacje `::error` (`enforce`) lub `::warning` (`report`),
a spadek miary i spłacony dług są czerwone.

## Podpięcie

- **CI:** krok `Debt ratchet (report)` w jobie `validate` po lincie (`.github/workflows/ci.yml`); w PR z `--base` =
  SHA bazowy, na push do `main` bez porównania.
- **Hook:** `.githooks/pre-commit` uruchamia raport, gdy w indeksie są `src/*.gs`, `scripts/quality/*` albo pliki
  `.quality/debt-*`.
- **Tryb:** do czasu przełączenia (osobny PR po przeglądzie wyniku) tylko raport; krok nie blokuje scalenia.

## Ograniczenia

- Dotknięta funkcja musi spełniać pełne limity: osobna reguła (#241), nie część silnika.
- Komentarze `eslint-disable` i `/* eslint reguła: off */` w mierzonym kodzie są ignorowane (`allowInlineConfig: false`):
  limity nie dają się obejść komentarzem.
- Silnik widzi funkcje po składni (`espree`); funkcje tworzone dynamicznie (`new Function`) nie są mierzone.
- Tożsamość funkcji anonimowych opiera się na skrócie ciała: zmiana ciała lambdy zmienia jej klucz (wpis bez funkcji
  i nowa funkcja ponad limit), czyli wymaga spłaty albo zmieszczenia się w limicie.
- `files` zakresu musi kończyć się rozszerzeniem pliku: ESLint inaczej pomija plik. Silnik odrzuca taki wzorzec (kod 2),
  a każdy komunikat ESLint bez reguły (plik pominięty, błąd składni, błąd konfiguracji) jest błędem użycia, nie zielonym wynikiem.
- Metody klas, gettery i funkcje we właściwościach są przypisywane po początku definicji (tam ESLint raportuje miarę),
  nie po nawiasie parametrów.
