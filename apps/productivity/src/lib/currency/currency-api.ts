import { z } from "zod";

const FRANKFURTER_API_BASE_URL = "https://api.frankfurter.dev/v1";

const currencyCodes = [
  "AUD",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "ISK",
  "JPY",
  "KRW",
  "MXN",
  "MYR",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "RON",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "USD",
  "ZAR",
] as const;

export const currencyCodeSchema = z.enum(currencyCodes);
const isoDateSchema = z.iso.date();

const latestResponseSchema = z.object({
  amount: z.number(),
  base: currencyCodeSchema,
  date: isoDateSchema,
  rates: z.partialRecord(currencyCodeSchema, z.number()),
});

const historicalResponseSchema = latestResponseSchema;

const timeSeriesResponseSchema = z.object({
  amount: z.number(),
  base: currencyCodeSchema,
  start_date: isoDateSchema,
  end_date: isoDateSchema,
  rates: z.record(isoDateSchema, z.partialRecord(currencyCodeSchema, z.number())),
});

const currenciesResponseSchema = z.record(currencyCodeSchema, z.string());

const latestRequestSchema = z.object({
  endpoint: z.literal("latest"),
  base: currencyCodeSchema.optional(),
  symbols: z.array(currencyCodeSchema).min(1).optional(),
});

const historicalRequestSchema = z.object({
  endpoint: z.literal("historical"),
  date: isoDateSchema,
  base: currencyCodeSchema.optional(),
  symbols: z.array(currencyCodeSchema).min(1).optional(),
});

const timeSeriesRequestSchema = z.object({
  endpoint: z.literal("timeSeries"),
  startDate: isoDateSchema,
  endDate: isoDateSchema.optional(),
  base: currencyCodeSchema.optional(),
  symbols: z.array(currencyCodeSchema).min(1).optional(),
});

const currenciesRequestSchema = z.object({
  endpoint: z.literal("currencies"),
});

const frankfurterRequestSchema = z.discriminatedUnion("endpoint", [
  latestRequestSchema,
  historicalRequestSchema,
  timeSeriesRequestSchema,
  currenciesRequestSchema,
]);

export type LatestRequest = z.infer<typeof latestRequestSchema>;
export type HistoricalRequest = z.infer<typeof historicalRequestSchema>;
export type TimeSeriesRequest = z.infer<typeof timeSeriesRequestSchema>;
export type CurrenciesRequest = z.infer<typeof currenciesRequestSchema>;
export type FrankfurterRequest = z.infer<typeof frankfurterRequestSchema>;
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

export type LatestResponse = z.infer<typeof latestResponseSchema>;
export type HistoricalResponse = z.infer<typeof historicalResponseSchema>;
export type TimeSeriesResponse = z.infer<typeof timeSeriesResponseSchema>;
export type CurrenciesResponse = z.infer<typeof currenciesResponseSchema>;

export async function fetchFrankfurter(params: LatestRequest): Promise<LatestResponse>;
export async function fetchFrankfurter(params: HistoricalRequest): Promise<HistoricalResponse>;
export async function fetchFrankfurter(params: TimeSeriesRequest): Promise<TimeSeriesResponse>;
export async function fetchFrankfurter(params: CurrenciesRequest): Promise<CurrenciesResponse>;
export async function fetchFrankfurter(
  params: FrankfurterRequest,
): Promise<LatestResponse | HistoricalResponse | TimeSeriesResponse | CurrenciesResponse> {
  const parsedParams = frankfurterRequestSchema.parse(params);
  const url = new URL(FRANKFURTER_API_BASE_URL);

  switch (parsedParams.endpoint) {
    case "latest":
      url.pathname = `${url.pathname}/latest`;
      break;
    case "historical":
      url.pathname = `${url.pathname}/${parsedParams.date}`;
      break;
    case "timeSeries":
      url.pathname = `${url.pathname}/${parsedParams.startDate}..${parsedParams.endDate ?? ""}`;
      break;
    case "currencies":
      url.pathname = `${url.pathname}/currencies`;
      break;
  }

  if ("base" in parsedParams && parsedParams.base) {
    url.searchParams.set("base", parsedParams.base);
  }

  if ("symbols" in parsedParams && parsedParams.symbols) {
    url.searchParams.set("symbols", parsedParams.symbols.join(","));
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Frankfurter API request failed (${response.status} ${response.statusText}).`);
  }

  const json = await response.json();

  switch (parsedParams.endpoint) {
    case "latest":
      return latestResponseSchema.parse(json);
    case "historical":
      return historicalResponseSchema.parse(json);
    case "timeSeries":
      return timeSeriesResponseSchema.parse(json);
    case "currencies":
      return currenciesResponseSchema.parse(json);
  }
}
