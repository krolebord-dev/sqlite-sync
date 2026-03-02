import { z } from "zod";
import { type CurrencyCode, currencyCodeSchema, fetchFrankfurter } from "./currency-api";
import { fetchNbuExchangeRates } from "./nbu-api";

export const baseCurrencySchema = z.union([currencyCodeSchema, z.literal("UAH")]);

const fetchCurrentRatesParamsSchema = z.object({
  base: baseCurrencySchema,
});

export type BaseCurrencyCode = z.infer<typeof baseCurrencySchema>;
export type FetchCurrentRatesParams = z.infer<typeof fetchCurrentRatesParamsSchema>;
export type CurrentRates = Partial<Record<BaseCurrencyCode, number>>;

export interface CurrentRatesResult {
  base: BaseCurrencyCode;
  rates: CurrentRates;
}

export async function fetchCurrentRatesAgainstBase(params: FetchCurrentRatesParams): Promise<CurrentRatesResult> {
  const parsedParams = fetchCurrentRatesParamsSchema.parse(params);

  if (parsedParams.base === "UAH") {
    const [frankfurterCurrencies, nbuRates] = await Promise.all([
      fetchFrankfurter({ endpoint: "currencies" }),
      fetchNbuExchangeRates(),
    ]);

    const requestedSymbols = Object.keys(frankfurterCurrencies) as CurrencyCode[];

    // NBU gives "UAH per 1 foreign unit"; invert to get "foreign per 1 UAH" (Frankfurter-like)
    const uahPerSymbol = new Map(nbuRates.map((entry) => [entry.cc, entry.rate]));
    const rates: CurrentRates = { UAH: 1 };

    for (const symbol of requestedSymbols) {
      const uahPer = uahPerSymbol.get(symbol);
      if (uahPer) {
        rates[symbol] = 1 / uahPer;
      }
    }

    return { base: "UAH", rates };
  }

  const [frankfurterLatest, nbuRates] = await Promise.all([
    fetchFrankfurter({
      endpoint: "latest",
      base: parsedParams.base,
    }),
    fetchNbuExchangeRates(),
  ]);

  const rates: CurrentRates = { ...frankfurterLatest.rates };
  // NBU gives "UAH per 1 base unit" — already Frankfurter-like
  const uahPerBase = nbuRates.find((r) => r.cc === parsedParams.base)?.rate;
  if (!uahPerBase) {
    throw new Error(`NBU rate for ${parsedParams.base} is unavailable.`);
  }
  rates.UAH = uahPerBase;

  return {
    base: parsedParams.base,
    rates,
  };
}
