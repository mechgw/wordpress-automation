# Standard testów

Podstawowy standard testów w tym repozytorium: jakie warstwy istnieją, jak ma wyglądać każdy test,
co jest zabronione i jak bramki to egzekwują. Dokumenty towarzyszące:

- [test-matrix-template.md](test-matrix-template.md) — matryca wypełniana przed napisaniem testów.
- `.github/PULL_REQUEST_TEMPLATE.md` — miejsce, gdzie zapisuje się dowody.
- `.quality/coverage-policy.json`, `.quality/changed-lines-ignore.json` — kontrakt pokrycia.

Zaadaptowane z zasad testowania repozytorium Laravel `system`, przeskalowane do projektu Google
Apps Script bez bazy danych, bez frameworka UI i bez przeglądarki.

## 1. Warstwy

| Warstwa               | Co to jest                                                                                          | Gdzie działa                        | Szybkość |
| --------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------- | -------- |
| **Unit (VM)**         | `node --test` ładuje pliki `.gs` do VM z zastubowanymi usługami Google (`test/helpers/gas.js`)      | lokalnie, pre-commit, CI            | ms       |
| **Test ręczny w arkuszu** | pozycje menu *Sprawdź połączenie*, *Test Rank Math bridge*, *Test biblioteki mediów* uruchamiane w arkuszu | człowiek, przed / po wdrożeniu | sekundy  |
| **Bramka runtime**    | drift check (żywy projekt == `main`), workflow deployu (lint, push, niezmienna wersja)              | GitHub Actions                      | minuty   |

Każda warstwa łapie coś, czego inne nie potrafią: warstwa VM dowodzi logiki i kontraktów, test w
arkuszu dowodzi poświadczeń i endpointów, bramka runtime dowodzi tego, co faktycznie jest wdrożone.
Żadna nie zastępuje innej.

## 2. Dziesięć zasad operacyjnych

| #   | Zasada                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Jedno zachowanie na test.** Kilka asercji jest w porządku, gdy opisują jeden wynik; niezwiązane sprawdzenia idą do osobnych testów.                                  |
| 2   | **Stan zamiast zachowania.** Sprawdzaj zwróconą wartość, rzucony błąd, żądanie, które zostałoby wysłane, komórkę arkusza, która zostałaby zapisana. Nie „funkcja została wywołana”. |
| 3   | **Najpierw matryca.** Nietrywialna zmiana albo zadanie czysto testowe: wypełnij [matrycę](test-matrix-template.md) przed napisaniem kodu. Zmiana trywialna: krótka matryca, ale obecna. |
| 4   | **Zmienione linie są pokryte.** 100 % linii instrukcji, które dodajesz lub zmieniasz w `*.gs`, musi wykonać się pod testem. Wyjątki trafiają do `.quality/changed-lines-ignore.json` z uzasadnieniem. |
| 5   | **Zapadka, nigdy regres.** Progi per plik w `.quality/coverage-policy.json` idą tylko w górę. Obniżenie wymaga uzasadnienia i issue z follow-upem.                      |
| 6   | **Obowiązek regresji.** Poprawka błędu wychodzi z testem, który padał przed poprawką i przechodzi po niej, plus co najmniej jeden przypadek brzegowy.                   |
| 7   | **Stuby, nie sieć.** Żadnych prawdziwych wywołań Google, WordPressa ani GA4 z testów. `UrlFetchApp` jest zastubowany, a kształt żądania jest sprawdzany asercją.        |
| 8   | **Bez ruletki asercji.** Ściana `assert.equal` na niezwiązanych polach jest odrzucana w review. Nazwij zachowanie; podziel test.                                        |
| 9   | **Świadomość realmu.** Obiekty i daty przekraczające granicę VM porównuje się przez `plain()` i tworzy przez `gas.$Date` (zob. §5).                                     |
| 10  | **Pre-commit to podłoga, CI to sufit.** Hook uruchamia lint, testy i bramkę pokrycia na plikach ze stage'a; CI powtarza je względem `main`.                             |

## 3. Złoty standard każdego testu

- **Nazwa opisuje zachowanie**, nie funkcję: `'odrzuca namespace z ukośnikiem'`, nie
  `'getWpConfig_ test 3'`. Zestawy (`describe`) nazywa się od pliku źródłowego plus obszaru.
- **Arrange / Act / Assert** są wizualnie rozdzielone. Dokładnie jedna akcja w *Act*.
- **Deterministyczny**: stałe daty przez `new gas.$Date(2026, 8, 5)`, stałe właściwości, stałe
  odpowiedzi fetch. Nigdy `new Date()` bez kontroli, nigdy prawdziwe strefy czasowe.
- **Izolowany**: każdy test buduje własny projekt przez `loadProject({...})`; żadnego wspólnego
  mutowalnego stanu między testami.
- **Sprawdzaj kontrakt widziany przez wywołującego**: zwróconą wartość, rzucony `Error` z treścią
  (`assert.throws(fn, /Brak Script Property: X/)`), wywołanie `UrlFetchApp` zapisane w
  `gas.$fetchCalls`, wartość zapisaną przez zastubowany zakres arkusza.
- **Ścieżki błędów są pełnoprawne**: brak właściwości, zniekształcona właściwość, odpowiedź nie-JSON,
  kod błędu HTTP. Zestaw z samą ścieżką szczęśliwą dla funkcji, która waliduje wejście, jest
  niekompletny.
- **Różnorodność asercji dla funkcji z efektami ubocznymi**: funkcja, która pobiera i zapisuje,
  musi mieć asercję zarówno na żądanie, jak i na zapis, nie na jedno z nich.

## 4. Zabronione

- **Tautologie**: sprawdzanie wartości, którą test sam przed chwilą ustawił.
- **„Brak błędu” jako jedyna asercja**: samo `assert.doesNotThrow` niczego nie dowodzi; połącz je
  z wynikiem.
- **Testowanie szczegółów implementacji**: kolejność wywołań prywatnych helperów, nazwy zmiennych
  wewnętrznych.
- **Nadmiar stubów**: jeśli wynik da się sprawdzić bezpośrednio, nie stubuj funkcji, która go
  produkuje.
- **Snapshoty ładunków API Google**: sprawdzaj pola, na których polegasz.
- **Ponawianie albo usypianie wewnątrz testów**.
- **Testy zapisujące pliki w repozytorium** albo zostawiające artefakty (wynik pokrycia idzie do
  `coverage/`, który jest ignorowany przez gita).
- **Zaszyta tożsamość witryny**: żadnych prawdziwych domen, nazw firm, identyfikatorów właściwości
  ani poświadczeń w fixture'ach. Używaj `example.pl`, `acme`, `123456`.

## 5. Uwagi o harnessie (`test/helpers/gas.js`)

- `loadProject(opts)` uruchamia wszystkie pliki z listy `SOURCES` (`Version.gs`, `Kod.gs`, `GA4.gs`,
  `WordPress.gs`, `Status.gs`, `Alerts.gs` i kolejne) w jednym kontekście VM, więc globalne symbole
  między plikami działają dokładnie jak w Apps Script.
- Opcje: `properties` (Script Properties), `sheets` (`{ nazwa: wiersze }` dla `SpreadsheetApp`),
  `fetch` (funkcja zwracająca `{ code, text, headers }`) albo `fetchRouter`, `triggers`, `lockHeld`,
  `skip` / `override` dla plików źródłowych.
- `gas.$fetchCalls` zapisuje każde `UrlFetchApp.fetch(url, params)`; `gas.$mails`, `gas.$triggers`,
  `gas.$lock`, `gas.$alerts`, `gas.$menus` zapisują pozostałe efekty.
- `gas.$Date` to `Date` z VM; sprawdzenia `instanceof Date` w źródłach padają dla dat hosta.
- `plain(value)` zdejmuje prototyp VM, żeby `assert.deepEqual` działał na zwróconych obiektach.
- `Utilities.formatDate` w stubie formatuje w strefie maszyny (Warszawa lokalnie, UTC w CI): nigdy
  nie zapisuj w asercji literału przesuniętego o strefę; porównuj przez ten sam stub albo uruchom
  `TZ=UTC npm test` przed pushem.
- Nowy plik źródłowy? Dodaj go do `SOURCES` w helperze, inaczej bramka pokrycia zgłosi go jako
  niezaładowany.
- Potrzebujesz usługi Google, której stuby nie mają? Rozszerz stub w helperze o najmniejszą
  powierzchnię, jakiej test potrzebuje, i sprawdzaj przez nią (zapis do zakresu, utworzony trigger).

## 6. Bramki

Trzy punkty kontrolne, za każdym razem te same testy:

1. **Przed commitem** — uruchamiasz testy lokalnie po każdej zmianie kodu; hook pre-commit
   uruchamia lint, testy i bramkę pokrycia na liniach ze stage'a i odmawia commitu, gdy coś pada.
2. **Przed merge'em** — CI uruchamia lint, testy i bramkę względem gałęzi bazowej; `validate` jest
   checkiem wymaganym, nic czerwonego nie wchodzi.
3. **Przed wdrożeniem** — workflow deployu, po zatwierdzeniu w środowisku `production`, uruchamia
   lint, testy i progi per plik na dokładnie tym tagu, który idzie do Apps Script. Wydanie z
   czerwonym testem nigdy nie dociera do arkusza.

| Bramka                          | Gdzie                                | Co ją obala                                                                        |
| ------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| Zabronione artefakty            | pre-commit                           | `.clasp.json`, `.clasprc.json`, `coverage/`, `node_modules/` na stage'u            |
| ESLint                          | pre-commit, CI                       | dowolny błąd lintu w `*.gs`, `test/`, `scripts/`, `eslint.config.js` (w tym brak znaku nowej linii na końcu pliku) |
| Testy jednostkowe               | pre-commit, CI                       | dowolny padający test                                                              |
| Pokrycie per plik               | pre-commit, CI                       | plik `*.gs` poniżej progu z `.quality/coverage-policy.json`                        |
| Pokrycie zmienionych linii      | pre-commit (stage), CI (vs `main`)   | zmieniona linia instrukcji w `*.gs` z zerem wykonań i bez zarejestrowanego wyjątku |
| Tytuł PR, skan sekretów, review-ack, szablon PR | CI                    | zob. README                                                                        |

Całość ręcznie:

```bash
npm run quality:gate -- --changed=base:origin/main
```

## 7. Procedura deficytu pokrycia

Gdy zmieniona linia naprawdę nie może wykonać się w VM (okno dialogowe Apps Script, instalacja
triggera, usługa, której stuby jeszcze nie modelują):

1. Najpierw spróbuj najmniejszego rozszerzenia stubu. Większość „niemożliwych” linii potrzebuje
   tylko fałszywego zakresu albo fałszywego buildera triggera.
2. Jeśli w tej zmianie nadal nie jest to warte zachodu, dodaj wpis do
   `.quality/changed-lines-ignore.json` z dokładnymi liniami, powodem nazywającym, co je pokrywa
   zamiast tego (menu testu w arkuszu, drift check) i, jeśli stub jest planowany, issue z follow-upem.
3. Wspomnij o wyjątku w sekcji PR-a *Uzasadnienie deficytu pokrycia*.
4. Usuń wpis, gdy zastubowany test wejdzie. Rejestr to kolejka, nie cmentarz.
