# wordpress-automation

Automatyzacja Google Apps Script dla procesów WordPress, Google Search Console i Google Analytics 4.

## Status projektu

Repozytorium jest kanonicznym źródłem projektu Apps Script. Obecna wersja produkcyjna to [najnowsze wydanie](https://github.com/mechgw/wordpress-automation/releases/latest).

Merge do `main` **niczego nie wdraża**. Publikacja wydania w GitHubie uruchamia workflow *Deploy to Apps Script* dla tego taga, a opiekun zatwierdza go w środowisku `production`, zanim cokolwiek zostanie wypchnięte. Ten sam workflow można też uruchomić ręcznie względem `main`.

## Pliki

- `appsscript.json` — manifest Apps Script i zakresy OAuth.
- `Kod.gs` — wspólne punkty wejścia i integracja z Google Search Console.
- `GA4.gs` — Google Analytics 4 i automatyzacja związana z Ads.
- `WordPress.gs` — most automatyzacji REST do WordPressa.
- `Status.gs` — status importów: rekordy uruchomień w Script Properties, jednolinijkowy status w komórkach konfiguracji, arkusz `IMPORT LOG`, menu *Dane*.
- `Alerts.gs` — alerty e-mail w modelu incydentu (otwórz raz, cisza w trakcie, zamknij po powrocie do normy) i codzienny strażnik aktualności.
- `UrlInspection.gs` — stan indeksowania kluczowych adresów z API inspekcji URL Search Console, zapisywany do arkusza `URL INSPEKCJA`.
- `SeoLive.gs` — live SEO regression check: pobiera kluczowe adresy i porównuje status, cel przekierowania, title, H1, canonical, robots i schema z oczekiwaniami z arkusza `SEO LIVE`.
- `Sitemaps.gs` — stan map witryny z API Sitemaps w Search Console, zapisywany do arkusza `SITEMAPY` i podsumowany w *Status danych*.
- `Diagnostics.gs` — smoke test z menu, wyłącznie odczyt: Script Properties, zakładki, dostęp do GSC / GA4 / WordPressa, triggery, konfiguracja alertów, jedna linia raportu na krok.
- `Version.gs` — same placeholdery; workflow deployu nadpisuje go tagiem wydania, commitem i czasem przed `clasp push`, a arkusz pokazuje ten tag jako menu (*Szczegóły wdrożenia*). Drift check ignoruje ten plik.
- `eslint.config.js` — reguły lintu z globalnymi symbolami Apps Script.
- `.claspignore` — do Apps Script trafiają wyłącznie `*.gs` i `appsscript.json`.

## Sekrety i konfiguracja

Nie commituj poświadczeń ani sekretów API. Poświadczenia runtime należą do **Script Properties** w Apps Script.

Most WordPressa oczekuje obecnie właściwości:

- `WP_BASE_URL`
- `WP_USERNAME`
- `WP_APP_PASSWORD`
- `WP_ALLOW_WRITES`
- `WP_REST_NAMESPACE` — namespace snippetu REST specyficznego dla witryny, np. `acme` dla `/wp-json/acme/v1/seo-meta`.

Opcjonalne:

- `SITE_DOMAIN` — domena używana do automatycznego wyboru właściwości GA4 po URL-u strumienia web. Fallbackiem jest host z `WP_BASE_URL`; bez obu właściwość trzeba wskazać ręcznie w arkuszu konfiguracji.
- `ALERT_EMAIL` — adresat alertów importu (jeden adres albo lista po przecinku). Bez niego nic nie jest wysyłane i nic nie pada; incydenty są nadal śledzone i widoczne w *Status danych*. Wartość, która nie jest adresem (na przykład `TRUE`), nigdy nie zostanie użyta: *Status danych* i okno strażnika pokazują ją jako `NIEPRAWIDŁOWY ADRES`, dopóki nie zostanie poprawiona.
- `ALERT_RECOVERY` — `FALSE` wyłącza e-mail „import ponownie działa”; incydent i tak jest zamykany. Domyślnie włączone.
- `EXPECTED_SITEMAPS` — lista adresów sitemap po przecinku, których brak w Search Console ma być zgłaszany.

`WP_ALLOW_WRITES` powinno pozostać wyłączone, chyba że celowo wykonujesz operację zapisu.

### Współbieżność i idempotencja

- **Jeden lock skryptu** (`Lock.gs`, `LockService.getScriptLock`) obejmuje każdy import GSC/GA4 i całą pętlę *Wykonaj polecenia*. To krótkie `tryLock` (5 s) bez kolejkowania: drugie uruchomienie, które zastanie lock zajęty, kończy się komunikatem `Inne uruchomienie jeszcze trwa (…)`. Przy importach odmowa jest zapisywana jako nieudane uruchomienie w komórce statusu, więc utracony przebieg jest widoczny, zamiast dwóch przebiegów zapisujących ten sam arkusz albo tę samą stronę WordPressa.
- **Statusy poleceń w `WP COMMANDS`:** `PENDING` jest podejmowane; `RUNNING` oznacza przebieg przerwany po zajęciu wiersza (limit czasu Apps Script, awaria). Taki wiersz nigdy nie jest wykonywany ponownie automatycznie: sprawdź stronę w WordPressie, potem ustaw `ERROR` albo `PENDING` z nowym `command_id`. `SKIPPED` oznacza polecenie zapisu odrzucone, bo nie ma `command_id` albo wynik dla tego `command_id` już istnieje w `WP RESULTS`; żeby wykonać je ponownie, nadaj nowe id. Polecenia odczytu można powtarzać dowolnie.
- **Menu *WordPress → Wykonaj wiersze DRY_RUN naprawdę*** prosi o potwierdzenie, przestawia wiersze `DRY_RUN` na `PENDING` i wykonuje je; odmawia, dopóki `WP_DRY_RUN` jest `TRUE`.

`WP_DRY_RUN=TRUE` zamienia *Wykonaj polecenia* w próbę generalną: każde polecenie zapisu przechodzi walidacje, odczyty i snapshot dokładnie jak na produkcji, ale żądanie zapisu jest zatrzymywane tuż przed `UrlFetchApp.fetch`, a wiersz polecenia dostaje status `DRY_RUN` z metodą, URL-em i payloadem, które zostałyby wysłane. Odczyty nadal się wykonują. Dry run i prawdziwy zapis dzielą jeden builder żądania (`buildWpRequest_`), więc podgląd nie może różnić się od produkcji. Dry run działa bez `WP_ALLOW_WRITES`; bez `WP_DRY_RUN` blokada zapisów pozostaje bez zmian.

Nic specyficznego dla witryny (domena, nazwa firmy, namespace REST) nie jest zaszyte w źródłach; wszystko żyje w Script Properties, żeby repozytorium mogło pozostać publiczne.

### Status importów (czy dane są świeże?)

Każdy import GSC i GA4, ręczny albo z codziennego triggera, zapisuje swój wynik w Script Properties (`LAST_IMPORT_GSC`, `LAST_IMPORT_GA4`: ostatnie uruchomienie i ostatnie udane uruchomienie z czasem, liczbą wierszy, błędem, czasem trwania). Pokazują to dwa miejsca:

- **Komórki** `Konfiguracja GSC!B8` i `Konfiguracja GA4!B9`, po jednej linii, czytelne dla człowieka i dla wszystkiego, co czyta arkusz przez API:

  | Tekst komórki | Znaczenie |
  | --- | --- |
  | `AKTYWNE – ostatni import: 2026-09-05 06:02 \| 1234 wierszy \| trigger: TAK` | ostatnie uruchomienie się udało, dane są świeże, codzienny trigger zainstalowany |
  | `BŁĄD 2026-09-06 06:01: <komunikat> \| ostatni poprawny import: 2026-09-05 06:02 \| trigger: TAK` | ostatnie uruchomienie padło; dane pochodzą z poprzedniego udanego |
  | `NIEAKTUALNE – …` | ostatni udany import jest starszy niż 36 godzin (albo go nie ma); nie ufaj danym |
  | `BRAK IMPORTU – uruchom import z menu \| trigger: NIE` | nigdy nie importowano |

- **Menu *Dane* → *Status danych***: to samo dla obu źródeł plus harmonogram, wynik ostatniego uruchomienia, tryb ręczny/trigger i czas trwania. *Odśwież status w komórkach* przepisuje komórki (na przykład po zainstalowaniu triggera).

Nieudany przebieg triggera nigdy nie udaje więc świeżego importu, a komórki mówią, czy trigger jest nadal zainstalowany.

**Historia i anomalie** (arkusz `IMPORT LOG`, tworzony automatycznie): każde uruchomienie dopisuje wiersz z czasem, źródłem, typem uruchomienia (`trigger` / `ręczny`; import dzienny liczy się jako `trigger` tylko wtedy, gdy wywołał go trigger czasowy Apps Script, ta sama pozycja menu uruchomiona ręcznie to `ręczny`), liczbą dni w importowanym zakresie (`0` przy nieudanych przebiegach, gdzie zakres jest nieznany), wynikiem, liczbą wierszy, czasem trwania, szczegółami oraz błędem lub ostrzeżeniem. Wiersze starsze niż 90 dni są usuwane niezależnie od tego, gdzie leżą, więc ręczne sortowanie arkusza jest bezpieczne; reguła anomalii również pomija wygasłe wiersze i porządkuje historię po czasie, nie po pozycji wiersza. Po każdym udanym przebiegu liczba wierszy jest porównywana z medianą ostatnich 7 udanych przebiegów **tego samego profilu** (źródło + typ uruchomienia + dni), więc codzienny import triggera na 1 dzień nigdy nie jest porównywany z ręcznym uzupełnieniem 90 dni. Mniej niż 7 przebiegów w profilu oznacza brak alarmu. Zero wierszy przy dodatniej medianie albo mniej niż połowa mediany dopisuje `UWAGA: mało danych: <n> wierszy vs mediana <m>` do komórki statusu, okna *Status danych* i wiersza logu. Sam import nadal liczy się jako udany; ostrzeżenie to sygnał, żeby zajrzeć do źródła.

### Alerty e-mail (model incydentu)

Alerty wysyła `MailApp` (zakres `script.send_mail`; pierwsze wdrożenie z tym zakresem wymaga jednorazowej ponownej autoryzacji skryptu) na adres z `ALERT_EMAIL`. Nie wysyłają się przy każdym zdarzeniu, tylko per **incydent**, jeden na źródło, przechowywany w tym samym rekordzie `LAST_IMPORT_*`:

| Przejście | Co się dzieje |
| --- | --- |
| OK → problem | incydent otwarty, **jeden** e-mail ze źródłem, czasem, trybem ręczny/trigger, treścią błędu lub anomalii i ostatnim poprawnym importem |
| problem → problem | cisza; incydent aktualizuje tylko powód i szczegóły (błąd po anomalii, nowy komunikat błędu) |
| problem → OK | incydent zamknięty; e-mail *Import ponownie działa*, chyba że `ALERT_RECOVERY=FALSE` |

Problemem jest nieudany przebieg (`BŁĄD`, w tym odmowa locka) albo anomalia liczby wierszy (`UWAGA, mało danych`). Tematy zaczynają się od `[wordpress-automation]`; każda treść kończy się URL-em arkusza i wdrożoną wersją. Wysyłka jest best-effort: awaria `MailApp` (limit dzienny, zły adres) trafia do logu i nigdy nie zmienia wyniku importu ani strażnika. Incydent, którego e-mail otwierający nie mógł zostać wysłany (brak `ALERT_EMAIL`, limit), dostaje powiadomienie raz przy kolejnym wystąpieniu, gdy wysyłka stanie się możliwa, a potem milczy jak zwykle.

**Nieaktualne dane** nie mają przebiegu, na który można zareagować, więc codzienny strażnik (`sprawdzAktualnoscImportow`, menu *Dane → Sprawdź aktualność teraz (alerty)*) sprawdza oba źródła: źródło w stanie `NIEAKTUALNE` albo `BRAK IMPORTU` otwiera incydent `stale`, a wszystkie takie źródła trafiają do **jednego** zbiorczego e-maila; przy otwartym incydencie strażnik milczy. Gdy źródło znowu jest świeże, strażnik zamyka incydent (e-mail o powrocie do normy, ten sam przełącznik). Incydenty otwarte przez nieudany przebieg zostawia ścieżce importu. Pozycja menu pokazuje okno z oboma źródłami, liczbą otwartych i zamkniętych incydentów oraz informacją, czy e-mail wyszedł, a jeśli nie, to dlaczego (brak adresu, nieprawidłowy adres, błąd `MailApp`). *Dane → Włącz codzienne alerty e-mail* instaluje trigger strażnika ok. 08:00, po importach GSC i GA4; okno mówi, gdzie trafiają alerty, albo ostrzega, że `ALERT_EMAIL` brakuje lub jest nieprawidłowe. *Status danych* pokazuje otwarty incydent per źródło, adresata i to, czy trigger strażnika jest zainstalowany.

### Inspekcja URL (co Google ma w indeksie)

Arkusz `URL INSPEKCJA`, kolumna A = adresy do monitorowania (tworzony z nagłówkiem przy pierwszym uruchomieniu). *SEO / GSC → Sprawdź indeksowanie (URL INSPEKCJA)* woła API inspekcji URL Search Console dla każdego adresu i zapisuje w tym samym wierszu: werdykt (`ZAINDEKSOWANY (PASS)`, `WYKLUCZONY (NEUTRAL)`, `BŁĄD INDEKSOWANIA (FAIL)`, `NIEZNANY`), stan pokrycia w brzmieniu Google (na przykład `Excluded by 'noindex' tag`), kanoniczny wg Google i wg strony, ostatni crawl, stan robots.txt, czas sprawdzenia. Werdykt albo pokrycie inne niż w poprzednim przebiegu jest oznaczane w kolumnie *Zmiana* jako `ZMIANA: stare → nowe`; stan bez zmian czyści flagę. Jeden błędny adres trafia do kolumny *Błąd* z czasem sprawdzenia i zachowuje poprzednie wartości; pozostałe wiersze są przetwarzane dalej. Adresy bez `http(s)://` są odrzucane bez żądania.

Wynik to stan **w indeksie Google**, nie stan opublikowanej strony: po zmianie `noindex`, canonicala albo treści wiersz zmieni się dopiero po ponownym crawlu (sprawdzenie stanu live to osobne narzędzie, poniżej). API pozwala na 2000 inspekcji dziennie na witrynę; jeden przebieg obsługuje najwyżej 150 adresów i zgłasza resztę jako pominiętą. Adresy są przetwarzane najpierw te nigdy niesprawdzone, potem od najdawniej sprawdzonych (kolumna *Sprawdzono*), więc dłuższa lista rotuje w kolejnych przebiegach, zamiast zawsze zaczynać od góry. Arkusz, który ma już adresy, ale nie ma nagłówka, dostaje nagłówek wstawiony nad nimi. *Włącz cotygodniową inspekcję URL* instaluje trigger tygodniowy (poniedziałek, ok. 07:00), który wykonuje to samo sprawdzenie bez okna. Przebieg trzyma wspólny lock skryptu i korzysta z istniejącego zakresu Search Console tylko do odczytu.

### Live SEO regression check (co strona serwuje teraz)

Arkusz `SEO LIVE`: URL w kolumnie A, oczekiwania w B..H (tworzony z nagłówkiem przy pierwszym uruchomieniu). *SEO / GSC → Sprawdź strony live (SEO LIVE)* pobiera każdy adres przez `UrlFetchApp` (bez logowania, przekierowania śledzone ręcznie do 5 skoków) i porównuje go z oczekiwaniami: końcowy status HTTP (pusto = 200), końcowy URL po przekierowaniach (pusto = sam adres, więc każde przekierowanie jest różnicą), `<title>`, pierwszy `<h1>`, `<link rel="canonical">`, robots (`index` domyślnie albo `noindex`; liczą się meta `robots`/`googlebot` i nagłówek `X-Robots-Tag`) oraz wartości `@type` z JSON-LD wypisane po przecinku. Puste oczekiwania są pomijane, poza statusem i robots. Wiersz dostaje `OK`, `UWAGA: n różnic(e)` z każdą różnicą wypisaną jako `co jest (oczekiwano czego)` albo `BŁĄD` z komunikatem sieci; jeden błędny adres nigdy nie zatrzymuje pozostałych. Kolumna L powtarza werdykt z indeksu Google z `URL INSPEKCJA` dla tego samego adresu, więc stan live i stan w indeksie stoją obok siebie i są tak podpisane.

*Włącz codzienny live check SEO* instaluje trigger dzienny (ok. 09:00). Przebieg z triggera wysyła jeden e-mail (na `ALERT_EMAIL`, best-effort) wymieniający wyłącznie **nowe** różnice, czyli wiersze, które w poprzednim przebiegu były `OK` albo puste; utrzymująca się różnica nie jest powtarzana, pełnym obrazem jest arkusz.

### Sitemapy (co wie o nich Search Console)

*SEO / GSC → Sprawdź sitemapy (SITEMAPY)* wypisuje sitemapy skonfigurowanej właściwości przez API Sitemaps w Search Console i przepisuje arkusz `SITEMAPY`: ścieżka, typ (indeks albo zwykła sitemapa), czas zgłoszenia i ostatniego pobrania, flaga oczekiwania, liczba zgłoszonych adresów, ostrzeżenia, błędy, stan i czas sprawdzenia. Arkusz jest migawką API, nie listą do edycji. Stan to `OK` albo `UWAGA` dokładnie w tych przypadkach: `errors > 0`, sitemapa oczekująca dłużej niż 7 dni od zgłoszenia, sitemapa wymieniona w opcjonalnej Script Property `EXPECTED_SITEMAPS` (adresy po przecinku), której Search Console nie ma (dostaje własny wiersz), albo błąd API. Czas ostatniego pobrania jest wyłącznie informacyjny; Google nie traktuje starego pobrania jako usterki, więc skrypt też nie. Podsumowanie jest zapisywane w `SITEMAPS_STATUS` i pokazywane jako jedna linia w *Dane → Status danych*, wraz z błędem API, jeśli ostatnie sprawdzenie padło.

### Diagnostyka systemu (dlaczego coś nie działa?)

*Dane → Diagnostyka systemu (tylko odczyt)* uruchamia `smokeTest()` i pokazuje po jednej linii na krok: wymagane Script Properties (i to, które opcjonalne są ustawione; wartość `ALERT_EMAIL` nigdy nie jest wypisywana, poprawna czy nie, tylko to, czy jest skonfigurowana i czy parsuje się jako adres), arkusze konfiguracji i oczekiwane zakładki, odczyt Search Console (lista właściwości, czy `siteUrl` jest wśród nich i z jakim uprawnieniem), odczyt GA4 Data API (metadane właściwości), odczyt WordPressa (`/wp/v2/users/me`: kogo loguje hasło aplikacji i czy może edytować strony, plus przełączniki zapisu i dry run), zainstalowane triggery, adresat alertów (skonfigurowany / nieprawidłowy / brak, nigdy sam adres) i stan sitemap. Każdy krok wykonuje się nawet wtedy, gdy wcześniejszy padł, błędy zachowują kod HTTP i nic nigdzie nie jest zapisywane: żaden arkusz, żadna Script Property, żadne wywołanie WordPressa inne niż GET, żaden lock. Nie działa z CI (zob. #54: `clasp run` i odczyt komórki odrzucone jako zbyt kosztowne w konfiguracji); weryfikacja deployu (#44) dowodzi, że żyją właściwe pliki, model statusu (#43, #42) mówi, czy realne procesy działają, a to okno mówi, dlaczego nie działają.

### Sekrety repozytorium GitHub

Workflow deployu i drift checku potrzebują dwóch sekretów repozytorium (Settings → Secrets and variables → Actions):

| Sekret | Wartość |
| --- | --- |
| `CLASPRC_JSON` | Pełna zawartość `~/.clasprc.json` po lokalnym `clasp login`. |
| `APPS_SCRIPT_ID` | Identyfikator projektu Apps Script (edytor Apps Script → Ustawienia projektu → Script ID). |

`CLASPRC_JSON` rotuje się przez ponowne `clasp login` i aktualizację sekretu.

Bramka zatwierdzania to ustawienie repozytorium, nie coś, co tworzy workflow. Settings → Environments → `production` musi mieć włączone **Required reviewers** i gałęzie wdrożeniowe ograniczone do `main` i tagów `v*`. Bez tego workflow deployu wypchnąłby zmiany od razu po uruchomieniu.

Konto Google stojące za `CLASPRC_JSON` musi też mieć włączone Apps Script API na <https://script.google.com/home/usersettings>, inaczej `clasp push` kończy się błędem „User has not enabled the Apps Script API”.

## Praca lokalna

```bash
npm ci
npm run lint
npm test
```

### Testy jednostkowe

W `test/` leżą testy jednostkowe Node (`node --test`, bez dodatkowych pakietów). `test/helpers/gas.js` ładuje pliki `.gs` do kontekstu VM z drobnymi zamiennikami usług Google (`SpreadsheetApp`, `PropertiesService`, `UrlFetchApp`, `Utilities`, `ScriptApp`, `MailApp`, `LockService`), więc wspólny zasięg globalny Apps Script jest odwzorowany, a czyste helpery i warstwa konfiguracji dają się przetestować bez Google:

- parsowanie i przesuwanie dat, dopasowanie hosta/domeny, wyciąganie wierszy GA4, helpery odpowiedzi WordPressa;
- walidacja `getWpConfig_` / `wpBridgePath_` (brakujące albo zniekształcone Script Properties), kształt żądania i parsowanie odpowiedzi w `wpFetch_`;
- domyślne wartości `getGa4Config_`, obecność/brak `Version.gs`;
- `testGA4` end to end na zastubowanych odpowiedziach Admin/Data API (automatyczny wybór właściwości po domenie strumienia, przypadki niejednoznaczne i puste, co trafia do arkusza konfiguracji);
- przepływy mostu WordPressa: `testRankMathBridge`, `getPageRawById_`, `writeRankMathField_`, `getPageLayout_`, `copyPageLayout_`, wraz z wierszami wyników dopisywanymi do *WP RESULTS* i każdą nazwaną ścieżką błędu.

Stub arkusza to prawdziwa siatka komórek: fixture'y zaczynają się od wiersza 1, `gas.$cell('Konfiguracja GA4', 'B9')` czyta komórkę, `gas.$sheet(nazwa)` całą siatkę, `gas.$alerts` okna UI, a `fetchRouter([[fragmentUrl, odpowiedź], ...])` rozdziela zastubowane wywołania HTTP.

Wszystko, co naprawdę rozmawia z Sheets, GA4 albo WordPressem, pozostaje pokryte pozycjami menu *Sprawdź połączenie* / *Test …* w arkuszu oraz drift checkiem. Trzy pułapki VM przy pisaniu testów: twórz obiekty `Date` przez `gas.$Date`, porównuj obiekty zwrócone ze źródeł przez `plain()` (inny realm, inne prototypy), a `Utilities.formatDate` w stubie formatuje w strefie maszyny, więc uruchom też `TZ=UTC npm test`, zanim wypchniesz zmiany.

### Bramki jakości i standardy

- **Standard:** [docs/quality/testing-standard.md](docs/quality/testing-standard.md) (warstwy, dziesięć zasad, złoty standard, wzorce zabronione). Planuj testy przez [docs/quality/test-matrix-template.md](docs/quality/test-matrix-template.md), a dowody zapisuj w szablonie PR-a.
- **Bramka pokrycia:** `npm run quality:gate -- --changed=base:origin/main` uruchamia testy z pokryciem V8 i egzekwuje dwie zasady: progi per plik z `.quality/coverage-policy.json` (zapadka, progi idą tylko w górę) i **100 % pokrycia zmienionych linii `*.gs`**. Uzasadnione wyjątki żyją w `.quality/changed-lines-ignore.json`.
- **Hook pre-commit:** `npm ci` ustawia gitowi katalog `.githooks/` (`core.hooksPath`). Przy każdym commicie hook blokuje poświadczenia i artefakty budowania, lintuje pliki ze stage'a i uruchamia testy oraz bramkę pokrycia na zmienionych liniach `*.gs`. `git commit --no-verify` pomija go lokalnie; CI uruchamia tę samą bramkę względem `main` i blokuje merge.
- **CI:** job `validate` uruchamia lint, testy i bramkę względem commitu bazowego PR-a.
- **Deploy:** workflow deployu uruchamia lint, testy i progi per plik na wdrażanym tagu, po zatwierdzeniu `production` i przed `clasp push`. Testy pilnują więc każdego etapu: commitu, merge'a, wdrożenia.

Żeby pracować z żywym projektem Apps Script, zaloguj się raz (clasp instaluje `npm ci`):

```bash
npx clasp login
```

Potem utwórz ignorowany przez gita `.clasp.json` z identyfikatorem projektu:

```json
{ "scriptId": "<script id>", "rootDir": ".", "scriptExtensions": ["gs"] }
```

`scriptExtensions` ma znaczenie: clasp 3 domyślnie używa `.js`, co pobrałoby źródła jako `Kod.js` obok `Kod.gs`.

`clasp status` pokazuje, co zostałoby wypchnięte. Nie uruchamiaj `clasp push` lokalnie; użyj workflow deployu, żeby każde wdrożenie było zrecenzowane i zapisane.

## Przebieg pracy

`main` jest chroniony: zmiany wchodzą wyłącznie przez pull requesty, CI musi przejść, force-push jest zablokowany. Ochrona jest ścisła, więc gałąź musi być aktualna względem `main`; PR w konflikcie nie dostaje w ogóle checków `pull_request`, dopóki nie zmergujesz `main` do gałęzi.

Tytuły PR-ów muszą trzymać się Conventional Commits (pilnuje tego check *PR title*). Release Drafter używa prefiksu do ustalenia kolejnej wersji:

- `feat:` / `new:` — nowa funkcjonalność; wydanie minor.
- `fix:` / `bug:` / `hotfix:` — poprawka błędu; wydanie patch.
- `docs:` — dokumentacja; wydanie patch.
- `chore:` / `refactor:` / `ci:` / `test:` / `style:` — utrzymanie; wydanie patch.

### Checki CI przy każdym PR

- **validate** — manifest jest poprawnym JSON-em, brak zdublowanych plików `.gs.gs`, ESLint przechodzi na wszystkich źródłach `.gs`.
- **secret-scan** — Gitleaks skanuje pełną historię pod kątem zacommitowanych sekretów.
- **pr-title** — tytuł zgodny z powyższym formatem Conventional Commits.
- **review-ack** — zielony tylko wtedy, gdy (1) recenzja Copilota nie trwa i (2) komentarze botów zostały potwierdzone komentarzem `/reviewed`.
- **pr-template** (okres obserwacji, jeszcze niewymagany) — treść PR-a trzyma się szablonu: co najmniej jeden kompletny wiersz matrycy testów, każda pozycja macierzy dowodów odhaczona, oznaczona `N/A (powód)` albo jawnie odłożona (`po wdrożeniu` / `after deploy` / `follow-up` / numer issue), niepuste uzasadnienie deficytu pokrycia oraz link `Fixes:` albo `Refs:` bez placeholdera `<nr>`. Akceptowane są nagłówki polskie i angielskie. Drafty są pomijane; PR-y Dependabota zwolnione. Logika w `scripts/quality/pr-template.js`, testy w `test/pr-template.test.js`; lokalnie uruchom `PR_BODY="$(cat body.md)" node scripts/quality/pr-template.js` albo `--body-file body.md`.

### Potwierdzanie recenzji botów

1. Poczekaj, aż Copilot skończy. W trakcie figuruje jako oczekujący recenzent, a check pozostaje czerwony. Bot, który padnie albo wyczerpie limit użycia (Codex robi to regularnie), niczego nie blokuje. Codex potrafi dotrzeć kilka minut po Copilocie: przed merge'em sprawdź wątki jeszcze raz, bo ochrona gałęzi wymaga ich rozwiązania.
2. Przeczytaj komentarze. Popraw to, co warto, na resztę odpowiedz, rozwiąż wątki (wymagane przed merge'em).
3. Opublikuj komentarz do PR-a zaczynający się od `/reviewed`, a po nim krótką notatkę, co zostało przyjęte, a co odrzucone. Musi być nowszy niż ostatni commit i ostatnia **recenzja** bota (obiekt review albo komentarz w kodzie), więc nowy push albo nowa recenzja bota oznacza nowe `/reviewed`. Zwykłe komentarze botów do PR-a, na przykład komunikat Codexa o limicie użycia, nie unieważniają potwierdzenia.

Gdy oba boty nie zrecenzowały PR-a z powodu limitów, PR może zostać zmergowany bez ich recenzji (decyzja właściciela z 2026-09-06), pod warunkiem że komentarz `/reviewed` mówi o tym wprost, a pozostałe checki są zielone.

Check uruchamia się przy każdym pushu i prośbie o recenzję. Każdy komentarz do PR-a (w tym `/reviewed`) ponawia najnowszą ocenę tego PR-a, więc to komentarz zmienia check na zielony; zakończenie recenzji przez Copilota samo w sobie nie generuje zdarzenia. Jeśli wynik wygląda na nieaktualny, opublikuj `/reviewed` ponownie albo uruchom *Review gate* ręcznie z numerem PR-a. Logika żyje w `scripts/quality/review-ack.js` z testami jednostkowymi w `test/review-ack.test.js`.

```bash
gh pr comment <numer> --body "/reviewed przyjęta poprawka uprawnień, pominięta uwaga o sformułowaniu"
```

Dependabot otwiera cotygodniowe PR-y dla GitHub Actions i deweloperskich zależności npm.

## Wdrażanie do Apps Script

Normalna ścieżka to wydanie:

1. Zmerguj zmiany do `main` i upewnij się, że CI jest zielone.
2. Releases → otwórz draft przygotowany przez Release Drafter → *Publish release*. To tworzy tag `vX.Y.Z`.
3. Actions → uruchomiony właśnie przebieg *Deploy to Apps Script* → *Review deployments* → zatwierdź `production`. Nic nie jest wypychane przed zatwierdzeniem.

Workflow pobiera wydany tag, uruchamia lint i testy, wypisuje pliki, które clasp wypchnie, wykonuje `clasp push --force`, zapisuje niezmienną wersję Apps Script nazwaną od taga, a potem **weryfikuje żywy projekt**: pobiera projekt z powrotem i porównuje go z tagiem (`scripts/quality/apps-script-compare.js`, ten sam skrypt, którego używa drift check). Czerwony krok weryfikacji oznacza, że push już się odbył, ale projekt się różni; zbadaj to albo cofnij przez `deploy_ref`. Podsumowanie joba wypisuje wypchnięte pliki, wersję i wynik porównania. Pre-release'y są ignorowane.

Wdrożenie doraźne bez wydania: Actions → *Deploy to Apps Script* → *Run workflow*, zostaw *Use workflow from* na `main`, zostaw *deploy_ref* jako `main`, opcjonalnie zaznacz *create_version* i zatwierdź tak samo.

**Rollback**: to samo okno, nadal uruchamiane z `main`, ale *deploy_ref* ustawione na poprzedni tag wydania (na przykład `v2.9.1`). Workflow sprawdza, czy tag istnieje, pobiera go, lintuje i po zatwierdzeniu wypycha te źródła do Apps Script. Zawsze zostawiaj *Use workflow from* na `main`: ta lista wybiera definicję workflow, a starsze tagi niosą starsze definicje.

```bash
gh workflow run deploy-apps-script.yml --ref main -f deploy_ref=v2.9.1
```

clasp jest przypiętą zależnością deweloperską (`package-lock.json`), więc uruchomienia lokalne i oba workflow używają tej samej wersji; Dependabot proponuje aktualizacje.

## Drift check

*Apps Script drift check* działa w każdy poniedziałek (i na żądanie). Pobiera żywy projekt i porównuje go z `main` przez `scripts/quality/apps-script-compare.js` (końcowe znaki nowej linii normalizowane po obu stronach: Apps Script zawsze zwraca plik z końcową nową linią, więc zacommitowane źródło bez niej nie jest driftem, a reguła ESLint `eol-last` trzyma takie pliki poza repozytorium; `Version.gs` ignorowany, porównywane tylko `*.gs` i `appsscript.json`). Jeśli ktoś edytował kod bezpośrednio w edytorze Apps Script, przebieg pada i dołącza patch z różnicami, żeby zmianę dało się wnieść z powrotem do repozytorium.

## Wydania

Notatki wydań żyją na [stronie Releases](https://github.com/mechgw/wordpress-automation/releases) i przygotowuje je automatycznie **Release Drafter**. Nie ma pliku `CHANGELOG.md`; opublikowane wydania są changelogiem.

- PR-y są etykietowane na podstawie tytułu, gdy to możliwe.
- Merge PR-a do `main` odświeża draft wydania.
- `feat`/`new` dają podbicie minor; wszystko inne patch.

Publikacja draftu ze strony Releases jest tym, co uruchamia wdrożenie (zob. wyżej). Bazą początkową jest `v2.8.0`; kolejne wersje trzymają się Semantic Versioning.

## Licencja

MIT.
