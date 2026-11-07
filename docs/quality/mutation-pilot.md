# Pilot testów mutacyjnych dla `src/*.gs`

Status: **`no-go-izolacja` dla dalszego wykonywania w tym środowisku** (audyt #238 z 2026-11-02 i 2026-11-05; Refs #234).
Przebieg z 2026-11-02 odbył się bez izolacji systemowej wymaganej w #234, więc jego liczby są **wyłącznie
diagnostyką techniczną** i nie potwierdzają spełnienia kryterium izolacji. Dalsze przebiegi tylko w
zweryfikowanej izolacji (odcięta sieć, bez sekretów, bez `GIT_*`), czyli w CI na Linuksie (#253), po
sondach odmowy; narzędzia same odmawiają startu bez nich (sekcja „Izolacja”). Pilot na osobnej gałęzi, bez bramki i bez CI. Zmiany `package.json`,
`package-lock.json` i konfiguracji nie są przeznaczone do scalenia do `main`. Nic tu nie jest
wymogiem dla PR-ów. Pełne listy linii: [mutation-pilot-listy.md](mutation-pilot-listy.md).

Test mutacyjny psuje kod na próbę (np. zamienia `||` na `&&`, `>=` na `>`, usuwa blok) i sprawdza,
czy jakikolwiek test to zauważy. Mutant, który przeżył, to miejsce, w którym kod można popsuć,
a testy zostaną zielone. Pokrycie linii tego nie pokazuje: linia może się wykonać i nic nie sprawdzać.

## Wynik w skrócie: diagnostyka, nie wynik zgodny z #234 (2026-11-02, StrykerJS 10.1.1, Node 24, Windows)

- **Technicznie most działa na całym `src/*.gs`** (to nie jest stwierdzenie zgodności z #234): 29 plików, 15 298 mutantów, wszystkie mutatory Strykera włączone,
  bez wykluczeń i bez pomijania mutantów statycznych.
- **Zabite z asercją: 10 139 (66,3 %)**. Zabite bez asercji (test padł na wyjątku, nie na porównaniu):
  1 282. Ocalałe: 3 740. Bez pokrycia (żaden test nie wykonuje linii): 89. Przekroczenia czasu: 48.
  Przy liczeniu jak Stryker (zabite z wyjątkiem i przekroczenia czasu też są wykryte) wychodzi 75,0 %.
- **Bramka pokrycia jest zielona dla wszystkich 29 plików** (99,14 % linii, 116 niepokrytych linii
  w trzech plikach: `WordPress.gs` 85, `GA4.gs` 21, `Kod.gs` 10), a mimo to **3 740 mutantów przeżywa
  na liniach pokrytych**. Pokrycie linii wykrywa 0,6 % tego, co pokazują mutacje (89 mutantów na
  niepokrytych liniach). Oba źródła zgadzają się co do tych 89: mapa z pokrycia i LCOV dały tę samą liczbę.
- **Czas to minuty na plik, nie sekundy**: mediana pliku 7 minut, od 6 s (`Version.gs`) do 69 min
  (`Status.gs`, 1 336 mutantów). Cały przebieg: ok. 5,5 godziny zegarowo, na zwykłej maszynie
  roboczej współdzielonej z innymi (obciążenie procesora 50–85 %), 3–4 procesy Strykera, w części
  czasu dwa łańcuchy naraz.

## Ścieżka: źródło → mutant → VM → test

| Krok | Co się dzieje |
| --- | --- |
| 1 | `src/<Nazwa>.gs` (edytowany jest tylko on) |
| 2 | `scripts/mutation/prepare-shadow.js` kopiuje go do `.stryker-shadow/<Nazwa>.js` (identyczna treść, te same numery linii). Stryker nie ma parsera `.gs` (`No parser registered for .gs!`), więc mutuje kopię |
| 3 | Stryker instrumentuje kopię w `.stryker-tmp/sandbox-*` i dla każdego mutanta uruchamia komendę testową z `__STRYKER_ACTIVE_MUTANT__=<id>` |
| 4 | `scripts/mutation/vm-preload.js` (`node --require`) przekierowuje odczyt `src/<Nazwa>.gs` w `gas.js` na zinstrumentowaną kopię i wstrzykuje numer aktywnego mutanta do kontekstu `vm` (który nie ma `process.env`) |
| 5 | `gas.js` wykonuje kod w `vm.runInContext`, test wywołuje funkcję i sprawdza asercją |
| 6 | Raport JSON wskazuje lokalizację w kopii; numer linii = numer linii w `.gs` |

`test/helpers/gas.js`, `test/*.js` i `src/*.gs` pozostają bez zmian.

## Dobór testów per mutant

Runner `command` nie zna pokrycia per test, a każdy test ładuje wszystkie 29 plików. Cały zestaw to
ok. 50 s równolegle albo ponad 2 min po kolei na mutant, czyli dla `WordPress.gs` ponad 8 godzin.
Dlatego:

1. `coverage-map.js` uruchamia każdy plik testów osobno z pokryciem LCOV i odejmuje linie wykonane
   przy samym ładowaniu (`load-only.test.js`). Wynik: które linie `src` wykonuje który test.
2. `run-file.js` robi przebieg indeksujący (komenda, która pada tylko z aktywnym mutantem, daje szybko
   listę wszystkich mutantów z id i linią) i dla każdego mutanta wybiera testy wykonujące jego linie.
3. `run-for-mutant.js` uruchamia te pliki po kolei, od najmniejszego, i przerywa na pierwszej porażce.
   Mutant bez żadnego testu nie uruchamia nic i jest oznaczany `NoCoverage`. Mutant wykonywany już przy
   ładowaniu (stała, tablica; ok. 500 sztuk) dostaje testy pliku.

To przybliżenie, więc sprawdzone próbką (sekcja „Kontrole”).

## Użycie

```bash
npm ci
node scripts/mutation/coverage-map.js            # raz, ok. 3 min
node scripts/mutation/run-file.js WordPress.gs --concurrency=3
node scripts/mutation/report.js WordPress.gs     # zestawienie z LCOV: reports/mutation/LISTY.md, TABELA.md
npm run test:coverage                            # LCOV potrzebny dla report.js
```

Jedna funkcja: `npx stryker run --mutate ".stryker-shadow/WordPress.js:1563-1627" --commandRunner.command "node scripts/mutation/run-tests.js test/wordpress-commands.test.js"`
po `npm run mutation:prepare -- WordPress.gs`. `classify.js` dzieli zabite na `killed-assert` i `killed-other`.
`run-file.js` i `validate-selection.js` zaczynają od sond izolacji i bez ich przejścia nie startują; cały łańcuch procesów dostaje minimalne środowisko (`safe-env.js`).

## Wyniki per plik

Wynik = zabite z asercją / wszystkie mutanty. „Linie LCOV” to to, co mierzy obecna bramka (`quality:gate`).

| Plik | Mutantów | Zabite z asercją | Zabite bez asercji | Ocalałe | Bez pokrycia | Przekroczenia czasu | Wynik (asercja) | Linie LCOV (próg) | Niepokryte linie |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| AdsCostExperiment.gs | 275 | 197 | 21 | 57 | 0 | 0 | 71,6 % | 100 % (95 %) | 0 |
| Alerts.gs | 440 | 334 | 37 | 69 | 0 | 0 | 75,9 % | 100 % (95 %) | 0 |
| BusinessProfile.gs | 483 | 349 | 27 | 107 | 0 | 0 | 72,3 % | 100 % (95 %) | 0 |
| CodeSnippets.gs | 218 | 138 | 14 | 65 | 0 | 1 | 63,3 % | 100 % (95 %) | 0 |
| Diagnostics.gs | 420 | 327 | 22 | 71 | 0 | 0 | 77,9 % | 100 % (95 %) | 0 |
| FormSourcePageContext.gs | 299 | 201 | 33 | 65 | 0 | 0 | 67,2 % | 100 % (95 %) | 0 |
| ForminatorHistory.gs | 446 | 255 | 63 | 127 | 0 | 1 | 57,2 % | 100 % (95 %) | 0 |
| GA4.gs | 915 | 400 | 128 | 353 | 30 | 4 | 43,7 % | 97,53 % (94 %) | 21 |
| GlobalFooterMigration.gs | 645 | 370 | 21 | 251 | 0 | 3 | 57,4 % | 100 % (95 %) | 0 |
| Kod.gs | 697 | 514 | 63 | 109 | 3 | 8 | 73,7 % | 98,57 % (96 %) | 10 |
| Lock.gs | 37 | 34 | 2 | 1 | 0 | 0 | 91,9 % | 100 % (100 %) | 0 |
| OrderAnalytics.gs | 1065 | 627 | 177 | 260 | 0 | 1 | 58,9 % | 100 % (100 %) | 0 |
| Payloads.gs | 174 | 104 | 5 | 64 | 0 | 1 | 59,8 % | 100 % (95 %) | 0 |
| PendingChanges.gs | 177 | 122 | 7 | 48 | 0 | 0 | 68,9 % | 100 % (95 %) | 0 |
| Performance.gs | 1557 | 993 | 201 | 355 | 0 | 8 | 63,8 % | 100 % (95 %) | 0 |
| PerformanceMigration.gs | 172 | 133 | 2 | 37 | 0 | 0 | 77,3 % | 100 % (95 %) | 0 |
| PhoneInquiries.gs | 135 | 103 | 11 | 20 | 0 | 1 | 76,3 % | 100 % (100 %) | 0 |
| RecrawlQueue.gs | 532 | 359 | 26 | 147 | 0 | 0 | 67,5 % | 100 % (95 %) | 0 |
| SchemaChecks.gs | 372 | 254 | 15 | 102 | 0 | 1 | 68,3 % | 100 % (95 %) | 0 |
| SeoLive.gs | 682 | 506 | 35 | 140 | 0 | 1 | 74,2 % | 100 % (95 %) | 0 |
| SheetCatalog.gs | 417 | 323 | 38 | 56 | 0 | 0 | 77,5 % | 100 % (95 %) | 0 |
| SheetUsage.gs | 560 | 417 | 20 | 117 | 0 | 6 | 74,5 % | 100 % (95 %) | 0 |
| SitemapUrls.gs | 307 | 184 | 18 | 99 | 0 | 6 | 59,9 % | 100 % (95 %) | 0 |
| Sitemaps.gs | 197 | 160 | 15 | 22 | 0 | 0 | 81,2 % | 100 % (95 %) | 0 |
| SourceFreshness.gs | 252 | 229 | 10 | 13 | 0 | 0 | 90,9 % | 100 % (100 %) | 0 |
| Status.gs | 1336 | 888 | 206 | 238 | 0 | 4 | 66,5 % | 100 % (95 %) | 0 |
| UrlInspection.gs | 201 | 166 | 9 | 26 | 0 | 0 | 82,6 % | 100 % (95 %) | 0 |
| Version.gs | 5 | 0 | 0 | 5 | 0 | 0 | 0 % | 100 % (100 %) | 0 |
| WordPress.gs | 2282 | 1452 | 56 | 716 | 56 | 2 | 63,6 % | 95,73 % (95 %) | 85 |
| **Razem** | **15298** | **10139** | **1282** | **3740** | **89** | **48** | **66,3 %** | | **116** |

Czasy per plik (sekundy zegarowe) są w `reports/mutation/time-*.json`; od 6 s (`Version.gs`) do 4 164 s (`Status.gs`).

### Gdzie mutanty uciekają, wg rodzaju zmiany

| Mutator | Mutantów | Zabite z asercją | Ocalałe | % ocalałych |
| --- | ---: | ---: | ---: | ---: |
| StringLiteral (teksty) | 4384 | 2560 | 1604 | 37 % |
| ConditionalExpression | 3950 | 2734 | 822 | 21 % |
| BlockStatement | 1414 | 1119 | 59 | 4 % |
| EqualityOperator | 1134 | 826 | 208 | 18 % |
| LogicalOperator | 1071 | 708 | 242 | 23 % |
| BooleanLiteral | 659 | 526 | 52 | 8 % |
| ObjectLiteral | 498 | 344 | 99 | 20 % |
| Regex | 462 | 264 | 174 | 38 % |
| ArrayDeclaration | 432 | 273 | 112 | 26 % |
| ArithmeticOperator | 394 | 261 | 100 | 25 % |
| MethodExpression | 388 | 169 | 200 | 52 % |
| CallExpression | 251 | 169 | 47 | 19 % |
| ArrowFunction | 161 | 116 | 13 | 8 % |
| UpdateOperator | 64 | 44 | 3 | 5 % |
| UnaryOperator | 21 | 17 | 4 | 19 % |
| AssignmentOperator | 15 | 9 | 1 | 7 % |

Teksty (komunikaty dla użytkownika) to 43 % ocalałych; bez nich wynik wynosi 69,4 %. To nie jest
„szum”: zmieniony komunikat w arkuszu to widoczna dla użytkownika zmiana, ale najtańsza do pominięcia.
Najgorzej wypadają `MethodExpression` (52 % ocalałych: usunięcie `.trim()`, `.slice()` itp.) i `Regex`.

## Kontrole (wymagania #234)

| Kontrola | Wynik |
| --- | --- |
| Zerowa, kod oryginalny i zinstrumentowany bez aktywnego mutanta | oba exit 0, 1289 testów, 0 porażek (to samo N). Dodatkowo suchy przebieg Strykera na każdym pliku przed jego mutantami |
| Dodatnia: id 67, `WordPress.gs:1612`, warunek kontrolny zastąpiony `false` | Aktywowany przez Strykera: pada dokładnie test „REPLACE_PAGE_CONTENT_TEXT: odczyt kontrolny bez podmiany jest błędem”, `AssertionError`. Ta sama zamiana wpisana ręcznie w `src/WordPress.gs` bez Strykera: pada ten sam test. (Mutant wskazany po pierwszym przebiegu, nie przed nim.) |
| Ujemna a: zmiana, której żaden test nie sprawdza | `1612` `\|\|` → `&&`, `1603` `>= 300` → `> 300`: Stryker `Survived`; ręcznie ta sama zmiana: 113 testów zielonych |
| Ujemna b: mutanty `Payloads.gs`, wybrany test nie wykonuje ich | 174 z 174 `Survived`, 0 zabitych |
| Ujemna c: komenda, która przechodzi bez mutanta, a z aktywnym zawsze pada | Stryker raportuje 100 %; `classify.js`: 14 × `killed-other`, 0 × `killed-assert`, pomiar nieważny |
| Powtarzalność | `replacePageContentText_`: 5 przebiegów, zawsze 40 / 32; dwa z mapą id → status: 0 różnic. `Payloads.gs`: 3 przebiegi, 0 różnic w mapie id → status między dwoma pierwszymi; trzeci (z doborem testów) różni się jednym mutantem, który z `Survived` przeszedł w `Timeout` (podział 104 / 64 / 5 / 1) |
| Zabite bez asercji (1 282) | Ślad stosu w `src/*.gs`: 1 048; bez śladu `.gs` (wyjątek w teście po zwróceniu złej wartości, np. `JSON.parse(undefined)`): 234. Wzmianek o preludium, loaderze lub Strykerze: 0. Mimo to nie są liczone do wyniku |
| Dobór testów nie ukrywa zabić | Próbka ok. 180 mutantów (ocalałe, bez pokrycia, wszystkie ocalałe statyczne z `AdsCostExperiment`, `BusinessProfile`, `Performance`) uruchomiona ponownie z pełnym zestawem: **żaden nie został zabity**. Wyjątek: jeden z dwóch przekroczeń czasu w `WordPress.gs` (linia 644) pełny zestaw zabija, drugie (linia 603, `{}` zamiast bloku) to prawdziwe zawieszenie |
| Brak regresji | Czysty `main` i gałąź pilota: `npm test`, `test:coverage` po 1297/1297, `quality:gate` PASS |

Uwagi do kontroli:

- Testy czytające `src/*.gs` jako **tekst** (`scheduled-jobs`, `*-completeness`, `source-freshness`,
  `pomiar-canonical`, `business-profile`) widzą w kopii zinstrumentowanej inny tekst i padają niezależnie
  od mutanta. Przy próbce kontrolnej trzeba je wykluczyć (`--exclude=`); w głównych przebiegach
  nie były wybierane, bo nie wykonują linii funkcji. Skutek: **ten rodzaj testów nie może oceniać
  mutantów**, a mutant w kodzie sprawdzanym tylko takim testem przeżywa.
- `Timeout` (48) obejmuje zawieszenia mutanta i mutanty wolniejsze niż limit (60 s dla `WordPress.gs`, 300 s dla pierwszych plików, 90 s dla reszty, plus wielokrotność suchego przebiegu);
  część z nich w pełnym zestawie jest zabijana. Dlatego jest podawany osobno.
- Runner `command` nie ma pokrycia per mutant. Status `NoCoverage` pochodzi z mapy pokrycia, nie ze Strykera.

## Niepokryte linie i obecna bramka pokrycia

Bramka (`quality:gate`) sprawdza pokrycie linii per plik wobec progu (`.quality/coverage-policy.json`) oraz
100 % zmienionych linii. Wszystkie 29 plików ją przechodzą. Niepokryte linie (LCOV, `npm run test:coverage`):

- `WordPress.gs` (85 z 1 992 linii, próg 95 %): `213-230 274-291 475-476 532-533 582-583 617-618 641 666-667 676-677 698-699 735-736 745-746 767-768 782-783 852-853 855-856 1236-1237 1276-1277 1354-1355 1376-1377 1412-1413 1461-1462 1524-1525 1567-1568 1604-1605 1833-1834 1901-1902`
- `GA4.gs` (21 linii) i `Kod.gs` (10 linii): lista w pliku z listami.

Pokrycie gałęzi (wg raportu `node --test`): 88,03 % ogółem, nie jest w bramce.
Rozjazd z mutacjami: bramka mierzy, czy linia się wykonała, mutacje mierzą, czy test zauważy jej zmianę.
Pliki w 100 % pokryte, ale z wynikiem poniżej 60 %: `ForminatorHistory.gs` 57,2 %, `GlobalFooterMigration.gs`
57,4 %, `OrderAnalytics.gs` 58,9 % (próg 100 %), `Payloads.gs` 59,8 %, `SitemapUrls.gs` 59,9 %.

## Izolacja: `no-go-izolacja`

Obowiązująca treść #234 wymaga przed uruchomieniem mutantów odcięcia sieci i zasobów zewnętrznych,
braku poświadczeń oraz sond odmowy; przy nieskutecznej izolacji wynikiem jest `no-go-izolacja` i brak
biegu. Przebieg z 2026-11-02 tego nie spełnił (uruchomiono go przed sprawdzeniem tego wymogu):

- sieć nie była odcięta na poziomie systemu, sond odmowy połączenia i zapisu poza katalogiem nie wykonano,
- pierwsze przebiegi próbne i proces Strykera dziedziczyły pełne środowisko hosta, w tym poświadczenia
  i `GIT_*` (czyszczenie dotyczyło dopiero procesu testów); incydent z `GIT_DIR` i prawdziwym
  `.git/config` pokazał, że granica procesu nie wystarczała,
- osłona w postaci `vm` bez `process`, `require` i `fetch` oraz atrap usług Google nie jest izolacją
  systemową (kod hosta, Stryker i testy działały z uprawnieniami użytkownika).

Skutki:

- liczby z tego dokumentu zachowano jako diagnostykę techniczną; nie są dowodem spełnienia AC izolacji
  i nie uzasadniają integracji z CI ani Ready/merge tego PR-a,
- **dalsze przebiegi w tym środowisku są wstrzymane**; nie uruchomiono ich po audycie,
- narzędzia wymuszają to mechanicznie: `run-file.js` i `validate-selection.js` zaczynają od
  `isolation-probe.js` (sieć: połączenia z publicznymi adresami muszą się nie udać; zapis poza katalogiem
  przebiegu i odczyt konfiguracji użytkownika muszą się nie udać; brak poświadczeń, `GIT_*` i `.clasp*`)
  i przy jakiejkolwiek porażce kończą się kodem 3 bez startu Strykera, bez flagi to wyłączającej.
  Na maszynie roboczej, na której zrobiono pilot, sonda daje: sieć osiągalna (1.1.1.1:443, 8.8.8.8:53),
  zapis w katalogu nadrzędnym możliwy, odczyt `.gitconfig` możliwy, 43 zmienne z poświadczeniami lub
  `GIT_*` w otoczeniu; `run-file.js` kończy się kodem 3 i nie tworzy `.stryker-tmp`,
- całe drzewo procesów dostaje minimalne środowisko z allowlisty (`safe-env.js`: `PATH`, `SystemRoot`,
  `TEMP` itp. i dwie zmienne pilota; wszystko inne, w tym każde `GIT_*`, jest odrzucane; test:
  `node --test scripts/mutation/safe-env.test.js`). Dotyczy to Strykera, loadera i testów; wcześniej filtr
  po wzorcu działał tylko w procesie testów,
- kolejna próba: zweryfikowane środowisko z odciętą siecią (kontener z `--network none` albo
  `unshare -n`), katalogiem tylko do zapisu w kopii i bez sekretów, na Linuksie w CI zgodnie z #253;
  sonda musi tam przejść, zanim ruszy pierwszy mutant. Naprawa dziedziczenia `GIT_*` w testach
  z `git init` jest zgłoszona osobno (#292).

## Koszt i wnioski

- Cały `src/*.gs`: ok. 5,5 godziny zegarowo (mutacje) plus ok. 2 godziny na weryfikacje i narzędzia,
  przy 3–4 procesach Strykera. Jedna funkcja z wąską listą testów: 2–3 minuty. Zmieniony plik: 1–70 minut.
- Bez doboru testów per mutant całość to ponad tydzień; dobór jest więc warunkiem sensu.
- Ograniczenia: dobór testów to przybliżenie (próbka nie wykazała błędu); testy czytające kod jako tekst
  nie nadają się do mutacji; wynik dotyczy jednej maszyny i jednego dnia; mutanty „zabite bez asercji”
  (8,4 %) wymagają ręcznej oceny, jeśli ktoś chciałby je zaliczyć do zabitych.
