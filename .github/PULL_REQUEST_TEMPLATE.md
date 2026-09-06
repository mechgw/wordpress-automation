<!--
Tytuł: Conventional Commits (feat: / fix: / docs: / chore: / ci: / test: / refactor:), temat małą literą.
Pola, które nie dotyczą zmiany → „N/A (powód)”. Nie zostawiaj placeholderów.
Standardy: docs/quality/testing-standard.md, docs/quality/test-matrix-template.md
Check `pr-template` sprawdza: kompletny wiersz matrycy, każdą pozycję macierzy dowodów
(odhaczona, „N/A (powód)” albo jawnie odłożona: „po wdrożeniu” / „follow-up” / #issue),
uzasadnienie deficytu pokrycia i link Fixes/Refs.
-->

## Kontekst

- **Dlaczego:** jedno zdanie o wartości tej zmiany.
- **Problem:** co dziś jest źle albo czego brakuje.
- **Rozwiązanie:** co się zmieniło i jak to rozwiązuje problem.
- **Szczegóły (opcjonalnie):** ryzyka, przypadki brzegowe, decyzje.

## Macierz testów

<!-- Z docs/quality/test-matrix-template.md. Zmiana trywialna: tabela scenariuszy + ryzyko rezydualne. -->

| ID  | Scenariusz | Krytyczność | Warstwa (Unit / Sheet / Runtime) | Test |
| --- | ---------- | ----------- | -------------------------------- | ---- |
| T1  |            |             |                                  |      |

**Ryzyko rezydualne / odłożone:** brak, albo lista z powodem i issue z follow-upem.

## Macierz dowodów

<!-- Odhacz z krótkim potwierdzeniem albo N/A z powodem. -->

- [ ] **Unit (VM):** testy dodane/zaktualizowane w `test/`, `npm test` zielone
- [ ] **Pokrycie:** zmienione linie `*.gs` pokryte w 100 % (`npm run quality:gate -- --changed=base:origin/main`), progi per plik spełnione
- [ ] **Test ręczny w arkuszu:** która pozycja menu została uruchomiona i z jakim wynikiem, albo N/A
- [ ] **Runtime:** drift check / dry run deployu / plan rollbacku przy zmianach workflow lub deployu, albo N/A
- [ ] **Bezpieczeństwo:** poświadczenia, Script Properties, higiena publicznego repo (brak tożsamości witryny w kodzie), albo N/A

**Uzasadnienie deficytu pokrycia:** brak, albo wpisy dodane do `.quality/changed-lines-ignore.json` i dlaczego.

## Recenzje botów

- [ ] Copilot zakończył; komentarze przeczytane, przyjęte wdrożone, odrzucone odpowiedziane w wątku
- [ ] Komentarz `/reviewed` opublikowany (zielony check `review-ack`)

## Linki

Fixes: #`<nr>` albo Refs: #`<nr>`

## Przed merge

- [ ] Tytuł zgodny z konwencją
- [ ] `validate`, `secret-scan`, `pr-title`, `review-ack` zielone
- [ ] Follow-upy wypisane wyżej albo `brak`
