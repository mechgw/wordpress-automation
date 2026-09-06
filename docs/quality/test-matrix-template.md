# Szablon matrycy testów

Wypełnij **przed** implementacją nietrywialnej zmiany albo zadania czysto testowego i wklej wynik do
issue lub PR-a (sekcja *Macierz testów*). Przy zmianie trywialnej ogranicz się do tabeli
scenariuszy i ryzyka rezydualnego; matryca może być krótka, nie może jej brakować.

Warstwy to trzy z [testing-standard.md](testing-standard.md): **Unit (VM)**, **Test ręczny w
arkuszu**, **Bramka runtime**.

## 1. Kontekst

- **Krytyczność:** Krytyczna / Wysoka / Średnia / Niska
- **Złota ścieżka?** tak, gdy zmiana dotyka któregokolwiek z: zapisów do WordPressa (ścieżki
  `WP_ALLOW_WRITES`), konfiguracji key events GA4, obsługi poświadczeń lub Script Properties,
  workflow deployu lub driftu, danych zapisywanych do arkuszy zasilających raportowanie.
- **Dlaczego ta zmiana, kogo dotyczy, ile kosztuje zły wynik?**

## 2. Zakres

Co jest testowane, co jest jawnie poza zakresem.

## 3. Inwentarz scenariuszy

| ID  | Scenariusz biznesowy                                  | Krytyczność | Warstwa (Unit / Sheet / Runtime) | Strategia błędu (fail-fast / fallback) |
| --- | ----------------------------------------------------- | ----------- | -------------------------------- | -------------------------------------- |
| T1  | np. brak `WP_REST_NAMESPACE` blokuje wywołania bridge | Wysoka      | Unit                             | fail-fast                              |
| T2  | np. namespace z ukośnikiem jest odrzucany             | Średnia     | Unit                             | fail-fast                              |

Wskazówki, stosuj, gdy pasują:

- **Zmiana konfiguracji / Script Properties:** co najmniej jeden scenariusz *brak* i jeden
  *zniekształcona wartość*.
- **Wywołanie zewnętrzne (WordPress, GA4, GSC):** sprawdź kształt żądania (URL, metoda, payload,
  nagłówki) oraz odpowiedź udaną i nie-2xx / nie-JSON.
- **Zapis do arkusza:** sprawdź zakres i zapisane wartości oraz zachowanie, gdy arkusza brak.
- **Logika dat:** granica miesiąca/roku i nieprawidłowe wejście.
- **Poprawka błędu:** wejście, które wywołało błąd, plus jeden sąsiedni przypadek brzegowy.
- **Zmiana deployu / workflow:** scenariusz runtime (dry run, drift check, rollback) i plan
  rollbacku.

## 4. Obrona w głąb

| Warstwa         | Co już chroni ten obszar | Wymagane w tej zmianie | Dodatkowe zabezpieczenie | Ryzyko rezydualne, jeśli odłożone |
| --------------- | ------------------------ | ---------------------- | ------------------------ | --------------------------------- |
| Unit (VM)       |                          |                        |                          |                                   |
| Test w arkuszu  |                          |                        |                          |                                   |
| Bramka runtime  |                          |                        |                          |                                   |
| Dokumentacja    |                          |                        |                          |                                   |

## 5. Inwentarz asercji

Pojęcia do udowodnienia per scenariusz, nie lista wywołań `assert`. Klasy asercji używane tutaj:

- **Kontrakt zwrotu** (wartość, kształt, normalizacja)
- **Kontrakt błędu** (rzucony `Error`, komunikat nazywa właściwość/pole, `httpCode`)
- **Efekt żądania** (wywołanie `UrlFetchApp`: URL, metoda, nagłówki, payload)
- **Efekt w arkuszu** (zapisany zakres, wartości, wywołanie formatowania)
- **Efekt właściwości** (odczyt/zapis Script Property)
- **Efekt runtime** (trigger utworzony/usunięty, wersja ostemplowana)
- **Strażnik granicy** (zapisy odrzucone przy wyłączonym `WP_ALLOW_WRITES`, nieznane pole
  odrzucone)

- **T1**: oczekuje `Brak Script Property: WP_REST_NAMESPACE`, gdy właściwości brak
  [Kontrakt błędu]
- **T2**: oczekuje, że błąd zacytuje nieprawidłową wartość i dozwolony zestaw znaków [Kontrakt błędu]

## 6. Wykonanie

Link do checklisty w issue albo lista testów tutaj z `[x]`, gdy istnieją.

## 7. Ryzyko rezydualne i ograniczenie zakresu

| Scenariusz | Dlaczego odłożone | Waga | Zaakceptował | Issue z follow-upem |
| ---------- | ----------------- | ---- | ------------ | ------------------- |
|            |                   |      |              |                     |

Każde zmniejszenie matrycy po review unieważnia review; przeprowadź je ponownie.
