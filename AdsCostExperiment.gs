/**
 * Eksperyment #46 (krok 1 po audycie): czy GA4 Data API wystarczy do kosztów
 * Google Ads, zanim powstanie integracja z Google Ads API (developer token,
 * scope adwords).
 *
 * Menu GA4 / Ads → „Eksperyment: koszty Ads z GA4 Data API”:
 *   1. properties.checkCompatibility dla raportu
 *      date + googleAdsCampaignId/Name + googleAdsAdGroupId/Name + googleAdsKeyword
 *      z metrykami advertiserAdCost / advertiserAdClicks / advertiserAdImpressions;
 *   2. gdy słowo kluczowe jest niezgodne, drugi test bez niego (poziom grupy reklam);
 *   3. dla pierwszej zgodnej kombinacji krótki runReport (ostatnie 7 dni
 *      z opóźnieniem z konfiguracji, do 20 wierszy), żeby zobaczyć realne dane;
 *   4. wynik do arkusza ADS EKSPERYMENT i do okna, z rekomendacją kroku 2.
 *
 * Tylko odczyt. Nie dotyka GA4 ADS RAW ani rejestru importów.
 */

const ADS_EXPERIMENT_SHEET = 'ADS EKSPERYMENT';
const ADS_EXPERIMENT_HEADER = ['Czas', 'Wariant', 'Pole', 'Rodzaj', 'Zgodność', 'Uwagi'];
const ADS_EXPERIMENT_METRICS = ['advertiserAdCost', 'advertiserAdClicks', 'advertiserAdImpressions'];
const ADS_EXPERIMENT_VARIANTS = [
  { name: 'słowo kluczowe', dimensions: ['date', 'googleAdsCampaignId', 'googleAdsCampaignName', 'googleAdsAdGroupId', 'googleAdsAdGroupName', 'googleAdsKeyword'] },
  { name: 'grupa reklam', dimensions: ['date', 'googleAdsCampaignId', 'googleAdsCampaignName', 'googleAdsAdGroupId', 'googleAdsAdGroupName'] },
  { name: 'kampania', dimensions: ['date', 'googleAdsCampaignId', 'googleAdsCampaignName'] }
];
const ADS_EXPERIMENT_SAMPLE_DAYS = 7;
const ADS_EXPERIMENT_SAMPLE_LIMIT = 20;

function ga4PropertyUrl_(propertyId, method) {
  return 'https://analyticsdata.googleapis.com/v1beta/properties/' + encodeURIComponent(String(propertyId)) + ':' + method;
}

/** Zgodność jednej kombinacji: lista pól z werdyktem API i flaga „wszystko zgodne”. */
function checkAdsVariant_(propertyId, variant) {
  const response = ga4ApiRequest_(ga4PropertyUrl_(propertyId, 'checkCompatibility'), 'post', {
    dimensions: variant.dimensions.map(name => ({ name })),
    metrics: ADS_EXPERIMENT_METRICS.map(name => ({ name }))
  });
  // API opisuje zgodność CAŁEGO schematu GA4 względem podanych pól, nie tylko
  // pól z żądania; liczą się wyłącznie wymiary i metryki, o które pytamy.
  const fields = [];
  (response.dimensionCompatibilities || []).forEach(d => {
    const name = (d.dimensionMetadata && d.dimensionMetadata.apiName) || '';
    if (variant.dimensions.indexOf(name) < 0) return;
    fields.push({ name, kind: 'wymiar', compatibility: String(d.compatibility || 'UNKNOWN') });
  });
  (response.metricCompatibilities || []).forEach(m => {
    const name = (m.metricMetadata && m.metricMetadata.apiName) || '';
    if (ADS_EXPERIMENT_METRICS.indexOf(name) < 0) return;
    fields.push({ name, kind: 'metryka', compatibility: String(m.compatibility || 'UNKNOWN') });
  });
  const missing = variant.dimensions.concat(ADS_EXPERIMENT_METRICS).filter(name => !fields.some(f => f.name === name));
  missing.forEach(name => fields.push({ name, kind: ADS_EXPERIMENT_METRICS.indexOf(name) >= 0 ? 'metryka' : 'wymiar', compatibility: 'BRAK W ODPOWIEDZI' }));
  return { variant: variant.name, fields, compatible: fields.length > 0 && fields.every(f => f.compatibility === 'COMPATIBLE') };
}

/** Krótki raport dla zgodnej kombinacji: liczba wierszy, suma kosztu, próbka. */
function sampleAdsVariant_(propertyId, variant, cfg) {
  const end = addDays_(todayGa4_(), -cfg.dailyLagDays);
  const start = addDays_(end, -(ADS_EXPERIMENT_SAMPLE_DAYS - 1));
  const response = ga4ApiRequest_(ga4PropertyUrl_(propertyId, 'runReport'), 'post', {
    dateRanges: [{ startDate: dateKey_(start), endDate: dateKey_(end) }],
    dimensions: variant.dimensions.map(name => ({ name })),
    metrics: ADS_EXPERIMENT_METRICS.map(name => ({ name })),
    // TOTAL liczy koszt po wszystkich wierszach raportu, nie po stronie ograniczonej limitem.
    metricAggregations: ['TOTAL'],
    limit: ADS_EXPERIMENT_SAMPLE_LIMIT
  });
  const rows = response.rows || [];
  const totals = response.totals && response.totals[0];
  const totalCost = totals ? num_(metric_(totals, 0)) : null;
  const sampleCost = rows.reduce((sum, r) => sum + num_(metric_(r, 0)), 0);
  return {
    range: dateKey_(start) + ' – ' + dateKey_(end),
    rowCount: Number(response.rowCount) || rows.length,
    cost: Math.round((totalCost === null ? sampleCost : totalCost) * 100) / 100,
    costLabel: totalCost === null ? 'koszt w próbce (' + rows.length + ' wierszy, bez TOTAL z API)' : 'koszt łącznie (TOTAL z API)',
    sample: rows.slice(0, 5).map(r => variant.dimensions.map((_, i) => dim_(r, i)).concat(ADS_EXPERIMENT_METRICS.map((_, i) => num_(metric_(r, i)))))
  };
}

function runAdsCostExperiment_() {
  const cfg = requireGa4Config_();
  const now = formatImportTime_(new Date().toISOString());
  const sheet = ensureSheetWithHeader_(ADS_EXPERIMENT_SHEET, ADS_EXPERIMENT_HEADER);
  const rows = [];
  const results = [];
  let winner = null;

  for (let i = 0; i < ADS_EXPERIMENT_VARIANTS.length; i++) {
    const variant = ADS_EXPERIMENT_VARIANTS[i];
    let result;
    try {
      result = checkAdsVariant_(cfg.propertyId, variant);
    } catch (e) {
      result = { variant: variant.name, fields: [], compatible: false, error: String(e && e.message ? e.message : e) };
      rows.push([now, variant.name, '(zapytanie)', 'błąd API', 'BŁĄD', result.error.slice(0, 500)]);
    }
    result.fields.forEach(f => rows.push([now, variant.name, f.name, f.kind, f.compatibility, '']));
    results.push(result);
    if (result.compatible) {
      winner = result;
      try {
        winner.sample = sampleAdsVariant_(cfg.propertyId, variant, cfg);
        rows.push([now, variant.name, '(runReport)', 'próbka', 'OK',
          winner.sample.range + ' | wiersze: ' + winner.sample.rowCount + ' | ' + winner.sample.costLabel + ': ' + winner.sample.cost]);
        winner.sample.sample.forEach(s => rows.push([now, variant.name, '(wiersz)', 'próbka', '', s.join(' | ')]));
      } catch (e) {
        winner.sampleError = String(e && e.message ? e.message : e);
        rows.push([now, variant.name, '(runReport)', 'próbka', 'BŁĄD', winner.sampleError.slice(0, 500)]);
      }
      break;
    }
  }

  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ADS_EXPERIMENT_HEADER.length).setValues(rows);
  return { results, winner, propertyId: cfg.propertyId };
}

function adsExperimentSummaryText_(out) {
  const lines = ['Eksperyment #46: koszty Google Ads z GA4 Data API (właściwość ' + out.propertyId + ')', ''];
  out.results.forEach(r => {
    if (r.error) {
      lines.push('- ' + r.variant + ': BŁĄD API – ' + r.error.split('\n')[0].slice(0, 160));
      return;
    }
    const bad = r.fields.filter(f => f.compatibility !== 'COMPATIBLE').map(f => f.name + ' (' + f.compatibility + ')');
    lines.push('- ' + r.variant + ': ' + (r.compatible ? 'ZGODNE' : 'NIEZGODNE: ' + bad.join(', ')));
  });
  lines.push('');
  if (out.winner) {
    const s = out.winner.sample;
    if (s) {
      lines.push('Próbka (' + s.range + '): ' + s.rowCount + ' wierszy, ' + s.costLabel + ' ' + s.cost + '.');
      lines.push(s.rowCount > 0
        ? 'Rekomendacja: krok 2 na GA4 Data API, poziom „' + out.winner.variant + '”; Google Ads API i developer token nie są potrzebne.'
        : 'Kombinacja zgodna, ale bez danych w próbce: sprawdź, czy konto Ads jest połączone z GA4 i czy w tym okresie były wydatki.');
    } else {
      lines.push('Kombinacja zgodna, ale runReport zawiódł: ' + out.winner.sampleError);
    }
  } else {
    lines.push('Rekomendacja: żadna kombinacja nie jest zgodna w GA4 Data API; krok 2 wymaga Google Ads API do osobnego arkusza GOOGLE ADS RAW.');
  }
  lines.push('', 'Szczegóły w arkuszu „' + ADS_EXPERIMENT_SHEET + '”.');
  return lines.join('\n');
}

/** Menu GA4 / Ads → Eksperyment: koszty Ads z GA4 Data API. */
function eksperymentKosztyAds() {
  const out = runAdsCostExperiment_();
  SpreadsheetApp.getUi().alert(adsExperimentSummaryText_(out));
  return out;
}
