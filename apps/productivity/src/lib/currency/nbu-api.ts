import { z } from "zod";

const NBU_EXCHANGE_API_URL = "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange";

const nbuExchangeRateSchema = z.object({
  cc: z.string().regex(/^[A-Z]{3}$/),
  rate: z.number(),
});

const nbuExchangeRateListSchema = z.array(nbuExchangeRateSchema);

export type NbuExchangeRate = z.infer<typeof nbuExchangeRateSchema>;

export async function fetchNbuExchangeRates(): Promise<NbuExchangeRate[]> {
  const url = new URL(NBU_EXCHANGE_API_URL);
  url.searchParams.set("json", "");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`NBU API request failed (${response.status} ${response.statusText}).`);
  }

  const json = await response.json();
  return nbuExchangeRateListSchema.parse(json);
}
