/**
 * Funkcja o sygnaturze `formatujDate_` z pamięcią kluczowaną `getTime()` (#229).
 * Kolumna A `GSC RAW` ma kilkadziesiąt różnych chwil na ponad 22 tys. komórek,
 * a `Utilities.formatDate` bywa wolne (do 160 s na przebieg), więc każda chwila
 * jest formatowana raz. Pamięć żyje w domknięciu jednego użycia: nic nie przeżywa
 * wywołania. `Date` z `getTime()` równym NaN idzie prosto do `formatujDate_`.
 */
function cachedFormatDate_() {
  const memo = {};
  return date => {
    const key = date.getTime();
    if (isNaN(key)) return formatujDate_(date);
    if (!(key in memo)) memo[key] = formatujDate_(date);
    return memo[key];
  };
}
