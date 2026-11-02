# Pilot testów mutacyjnych dla `src/*.gs`

Status: **pilot na osobnej gałęzi, bez bramki i bez CI** (Refs #234). Zmiany `package.json`,
`package-lock.json` i konfiguracji nie są przeznaczone do scalenia do `main`. Nic tu nie jest
wymogiem dla PR-ów.

Testy mutacyjne psują kod na próbę (np. zamieniają `||` na `&&`, `>=` na `>`) i sprawdzają, czy
jakikolwiek test to zauważy. Mutant, który przeżył, to miejsce, w którym kod można popsuć, a testy
zostaną zielone. Pokrycie linii tego nie pokazuje: linia może się wykonać i nic nie sprawdzać.

## Wynik: czy działa

**Tak, technicznie.** StrykerJS 10.1.1 z `commandRunner` i dwoma obejściami (niżej) mutuje `.gs`,
a `test/helpers/gas.js` wykonuje zmutowaną wersję. Dowody w sekcji „Kontrole”. Opłacalność zależy od
zakresu: pojedyncza funkcja to kilka minut, całość repozytorium to godziny albo dni (sekcja „Koszt”).

## Ścieżka: źródło → mutant → VM → test

| Krok | Co się dzieje |
| --- | --- |
| 1 | `src/<Nazwa>.gs` (edytowany jest tylko on) |
| 2 | `scripts/mutation/prepare-shadow.js` kopiuje go do `.stryker-shadow/<Nazwa>.js` (identyczna treść, te same numery linii). Stryker nie ma parsera `.gs` (`No parser registered for .gs!`), więc mutuje kopię |
| 3 | Stryker instrumentuje kopię w katalogu roboczym `.stryker-tmp/sandbox-*` i dla każdego mutanta uruchamia komendę testową z `__STRYKER_ACTIVE_MUTANT__=<id>` |
| 4 | `scripts/mutation/vm-preload.js` (`node --require`) przekierowuje odczyt `src/<Nazwa>.gs` w `gas.js` na zinstrumentowaną kopię i wstrzykuje numer aktywnego mutanta do kontekstu `vm` (który nie ma `process.env`) |
| 5 | `gas.js` wykonuje kod w `vm.runInContext`, test wywołuje funkcję i sprawdza asercją |
| 6 | Raport JSON wskazuje lokalizację w kopii; numer linii = numer linii w `.gs` |

`test/helpers/gas.js`, `test/*.js` i `src/*.gs` pozostają bez zmian.

## Użycie

```bash
npm ci
npm run mutation:prepare -- WordPress.gs
npx stryker run \
  --mutate ".stryker-shadow/WordPress.js:1563-1627" \
  --commandRunner.command "node scripts/mutation/run-tests.js test/wordpress-commands.test.js"
node scripts/mutation/classify.js reports/mutation/mutation.json --list
```

`run-tests.js` pomija dwa testy skanujące samo repozytorium (`repo-identity`, `source-control-chars`;
w kopii Strykera padają niezależnie od mutacji) i usuwa z otoczenia zmienne wyglądające na
poświadczenia. `classify.js` czyta surowy raport i dzieli zabite na `killed-assert` (jest nieudana
asercja) i `killed-other` (inny niezerowy wynik). Liczy się tylko `killed-assert`.
Współbieżność Strykera w konfiguracji to 2; nie podnoś jej bez sprawdzenia obciążenia maszyny.

## Kontrole (2026-11-02, Node 24, Windows, StrykerJS 10.1.1)

| Kontrola | Wynik |
| --- | --- |
| Zerowa, kod oryginalny | `run-tests.js`: exit 0, 1289 testów, 0 porażek |
| Zerowa, kod zinstrumentowany bez aktywnego mutanta | exit 0, 1289 testów, 0 porażek (to samo N). `npm test` na `main`: 1297 (8 więcej to dwa pominięte pliki skanujące repozytorium) |
| Dodatnia (mutant wskazany po pierwszym przebiegu, nie przed nim): id 67, `WordPress.gs:1612`, warunek kontrolny zastąpiony `false` | Aktywowany przez Strykera: pada dokładnie test „REPLACE_PAGE_CONTENT_TEXT: odczyt kontrolny bez podmiany jest błędem”, `AssertionError … /nie potwierdził dokładnej podmiany/`. Ta sama zamiana wpisana ręcznie w kopii roboczej `src/WordPress.gs` bez Strykera: pada ten sam test (przywrócono, `git diff` czysty) |
| Ujemna a: zmiana, której żaden test nie sprawdza | Np. `1612` `\|\|` → `&&` albo `1603` `>= 300` → `> 300`: Stryker `Survived`; ręczna zmiana tej samej linii i 113 testów `wordpress*`+`kod`: 113 zielonych |
| Ujemna b: mutanty `Payloads.gs`, ale wybrany test (`lock.test.js`) ich nie wykonuje | 174 z 174 `Survived`, 0 zabitych (`classify.js`: pomiar nieważny) |
| Ujemna c: komenda, która przechodzi bez mutanta, a przy aktywnym zawsze pada | Stryker raportuje 100 % wyniku (14/14). `classify.js`: 14 × `killed-other`, 0 × `killed-assert`, pomiar nieważny |
| Powtarzalność | 72 mutanty `replacePageContentText_`, 5 przebiegów (w tym jeden z całym zestawem testów): zawsze 40 zabitych / 32 ocalałe; dwa przebiegi z mapą id → status: 0 różnic. `Payloads.gs`, 2 przebiegi, 174 mutanty: 0 różnic |
| Brak regresji | Czysty `main` i gałąź pilota: `npm test` i `npm run test:coverage` po 1297/1297, `quality:gate` PASS. LCOV różni się wyłącznie numeracją funkcji anonimowych (kolejność), nie pokryciem |

Runner `command` nie ma pokrycia per mutant: status `NoCoverage` się tu nie pojawia, a mutant
w niewykonanym kodzie wychodzi jako `Survived`. Dlatego ocalałe trzeba zestawić z LCOV
(`npm run test:coverage`, linie z zerem trafień).

## Izolacja: warunek **niespełniony** w pełni

- Mutowany kod działa w `vm` bez `process`, `require`, `fetch` ani `XMLHttpRequest`
  (sprawdzone sondą `typeof`); `UrlFetchApp`, `SpreadsheetApp` i `ScriptApp` to atrapy z `gas.js`.
  Mutacje operatorów nie szukają ucieczki z `vm`, ale to nie jest izolacja systemowa.
- Sieć nie została odcięta na poziomie systemu (nie ma na to narzędzia bez uprawnień administratora
  albo kontenera). Sondy odmowy połączenia i zapisu poza katalogiem **nie zostały wykonane**.
- Zmienne środowiskowe z poświadczeniami były widoczne dla procesów testowych w pierwszych
  przebiegach. Testy ich nie czytają (`grep process.env` w `test/` i `src/` nie wskazuje takich
  odczytów), ale tego nie wymuszano. Od `run-tests.js` w tej wersji są usuwane przed startem testów
  (sprawdzone na liście nazw); ostatni przebieg `Payloads.gs` poszedł już z czyszczeniem.
- Do szerszego zakresu: uruchamiać w kontenerze albo WSL z odciętą siecią (`unshare -n`) i bez
  poświadczeń. Do tego czasu stosować wyłącznie na kodzie z atrapami, jak tu.

## Wyniki

| Zakres | Mutantów | Testy na mutant | Czas | `killed-assert` / ocalałe / `killed-other` |
| --- | --- | --- | --- | --- |
| `replacePageContentText_` (65 linii `WordPress.gs`) | 72 | `wordpress-commands.test.js` | 2–2,5 min | 40 / 32 / 0 |
| to samo | 72 | cały zestaw (1289 testów) | 34 min | 40 / 32 / 0 |
| cały `Payloads.gs` (139 linii) | 174 | `payloads.test.js` | 2–3 min | 104 / 65 / 5 |

Pięć `killed-other` w `Payloads.gs` to testy, które padły na wyjątku rzuconym przez zmutowany kod
(`TypeError` w `Payloads.gs:109`, własny `Error` źródła), nie na asercji; nie liczą się do wyniku.
Nie sprawdzano ich pod kątem awarii preludium (stos wskazuje `src/Payloads.gs`).

### Ocalałe w `replacePageContentText_` (32)

Klasyfikacja ręczna (ok. 10 min), na podstawie LCOV i treści testów. Żaden nie jest uznany za
równoważny bez dowodu.

| Klasa | Mutantów | Przykład |
| --- | --- | --- |
| Gałąź błędu nigdy nie uruchamiana (LCOV: 0 trafień w `1567`, `1604`) | 12 | brak testu dla ID strony nie będącego liczbą; brak testu dla odpowiedzi HTTP poza 2xx |
| Wartość domyślna albo parametr odczytu bez asercji | 15 | pusty zamiennik (`null`), `getPageRawById_(…, true)` zamienione na `false`, brak `content.raw` |
| Komunikat dla użytkownika bez asercji | 4 | w tym `+` → `-` w komunikacie wyniku (`1621`), który zamieniłby tekst w `NaN` |
| Kontrola odczytu po zapisie | 1 | `\|\|` → `&&` w `1612`: ta linia jest przedmiotem #237 |

Czyli mutacje wskazały dokładnie tę samą linię, w której później wyszedł fałszywy błąd z #237.

## Koszt

- Czas jednego mutanta z wąską listą testów: ok. 1,7 s (2 procesy Strykera); z całym zestawem: ok. 28 s.
- Liczba mutantów w całym `src/*.gs`: 15 298 (`WordPress.gs` 2 282, `GA4.gs` 915, `Kod.gs` 697).
  Rząd wielkości: ok. 7 godzin z wąskimi listami testów (których nie ma jak wybrać automatycznie,
  bo każdy test ładuje wszystkie 29 plików), ok. 5 dni z całym zestawem.
- Obciążenie: maszyna współdzielona; podczas przebiegów ogólne obciążenie procesora wynosiło
  ok. 55–100 % wobec 15–40 % bez przebiegu (nie da się odseparować cudzej pracy). Pamięć bez
  znaczenia. Każdy przebieg zostawia `.stryker-tmp/` przy przerwaniu (w `.gitignore`).
- Domyślne mutatory generują wiele mutantów na literałach tekstowych (komunikaty); do rozważenia
  `mutator.excludedMutations: ["StringLiteral"]`.

## Ograniczenia

- Dowód powtarzalności obejmuje dwa pliki i jedną maszynę.
- Rząd kosztu całości jest ekstrapolacją, nie pomiarem.
- Ocalałych poza `replacePageContentText_` nie klasyfikowano.
