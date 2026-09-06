# Taksonomia etykiet GitHub

`labels.json` to deklaratywne źródło prawdy o etykietach zarządzanych przez to repozytorium. Model powtarza wzorzec z `system.produkcja`, ale zachowuje tylko rodziny, które są tu przydatne.

Action **Sync GitHub labels** uzgadnia nazwy, kolory i opisy po wejściu manifestu do `main`; można go też uruchomić ręcznie. Celowo nie jest destrukcyjny: etykiety spoza manifestu zostają w spokoju. Jawne jednorazowe usunięcia żyją w `migrations.delete`.

## Zasady klasyfikacji

| Rodzina | Zasada | Znaczenie |
| --- | --- | --- |
| Priorytet `P0`–`P4` | dokładnie 1 na otwarte issue | Biznesowa/operacyjna kolejność pracy. |
| Ryzyko `T1`–`T3` | dokładnie 1, gdy praca może zmienić zachowanie produkcji | Koszt/ryzyko pomyłki w zmianie, nie nakład implementacji. |
| `area:*` | 1 lub więcej | Gdzie praca należy. |
| Stan | 0 lub więcej | `blocked`, `needs-triage`, `monitoring`. |
| Typ zmiany | 0 lub więcej | Zgodny z Release Drafterem / Conventional Commits. |
| `policy:*` | 0 lub więcej | Przekrojowy niezmiennik albo polityka, której praca dotyczy. |

Priorytet i ryzyko są niezależne. Drobny, ale pilny defekt produkcyjny może być `P0` + `T1`; duży refaktor wrażliwy na bezpieczeństwo może być `P2` + `T3`.

Priorytet żyje w etykiecie, nie w tytule issue. Po migracji nie prefiksuj tytułów `[P0]`, `[P1]` itd.; duplikowanie wartości w tytule tworzyłoby dwa źródła prawdy, które się rozjadą.

## Semantyka kolorów

Kolory są celowo spójne z ustaloną taksonomią w `system.produkcja`:

- kolory ciepłe — pilność (`P0` → `P2`);
- szary — niski priorytet / monitoring;
- chłodny niebieski/indygo — poziomy ryzyka;
- prawie czarny — zablokowane;
- zielony — każda etykieta `area:*`;
- fioletowy — każda etykieta `policy:*`.

Kolor to tylko wskazówka wizualna. Znaczenie zawsze niesie nazwa i opis etykiety.

## Obszary

Początkowy zamknięty zbiór:

- `area:wordpress`
- `area:seo`
- `area:analytics`
- `area:gsc`
- `area:ga4`
- `area:forminator`
- `area:apps-script`
- `area:github`
- `area:tests`
- `area:security`

Nowy obszar dodawaj tylko wtedy, gdy istniejący uczyniłby filtrowanie mylącym. Nie twórz etykiet ad hoc w interfejsie GitHuba; zmień `labels.json` w zrecenzowanym PR-ze.

## Typowe przykłady

Defekt układu tras WordPressa, który blokuje obecnie poprawne renderowanie produkcji:

`P0` · `T2` · `bug` · `area:wordpress` · `area:seo`

Zadanie pomiaru SEO po wdrożeniu, czekające na wystarczającą ilość danych:

`P1` · `T1` · `monitoring` · `area:seo` · `area:analytics` · `area:gsc`

Usprawnienie CI albo zarządzania repozytorium:

`P2` · `T1` · `chore` · `area:github` · `area:tests`

## Zmiana taksonomii

1. Edytuj `.github/labels.json` na gałęzi.
2. Uruchom `npm test`; `test/labels.test.js` sprawdza kontrakt manifestu.
3. Otwórz PR i przejdź normalną bramkę review.
4. Po merge'u **Sync GitHub labels** nakłada zrecenzowany stan na repozytorium.

Nie włączaj niejawnego usuwania. Usunięcie etykiety to migracja i musi być nazwane jawnie, żeby ślad audytowy tłumaczył, dlaczego zniknęła.
