import { z } from "zod";
import { baseCurrencySchema, fetchCurrentRatesAgainstBase } from "../../lib/currency/current-rates";
import { defineJob } from "./jobs-base";

export const fetchCurrencyRatesJob = defineJob({ type: "fetch-currency-rates" })
  .input(z.object({ baseCurrency: baseCurrencySchema }))
  .handler(async ({ input, context }) => {
    const { base, rates } = await fetchCurrentRatesAgainstBase({
      base: input.baseCurrency,
    });

    const date = new Date().toISOString().slice(0, 10);
    const id = `${date}-${base}`;

    context.syncDb.enqueueEvent(
      context.syncDb.createEvent({
        type: "item-created",
        dataset: "_currency_rate",
        item_id: id,
        payload: {
          id,
          date,
          baseCurrency: base,
          AUD: rates.AUD ?? null,
          BRL: rates.BRL ?? null,
          CAD: rates.CAD ?? null,
          CHF: rates.CHF ?? null,
          CNY: rates.CNY ?? null,
          CZK: rates.CZK ?? null,
          DKK: rates.DKK ?? null,
          EUR: rates.EUR ?? null,
          GBP: rates.GBP ?? null,
          HKD: rates.HKD ?? null,
          HUF: rates.HUF ?? null,
          IDR: rates.IDR ?? null,
          ILS: rates.ILS ?? null,
          INR: rates.INR ?? null,
          ISK: rates.ISK ?? null,
          JPY: rates.JPY ?? null,
          KRW: rates.KRW ?? null,
          MXN: rates.MXN ?? null,
          MYR: rates.MYR ?? null,
          NOK: rates.NOK ?? null,
          NZD: rates.NZD ?? null,
          PHP: rates.PHP ?? null,
          PLN: rates.PLN ?? null,
          RON: rates.RON ?? null,
          SEK: rates.SEK ?? null,
          SGD: rates.SGD ?? null,
          THB: rates.THB ?? null,
          TRY: rates.TRY ?? null,
          UAH: rates.UAH ?? null,
          USD: rates.USD ?? null,
          ZAR: rates.ZAR ?? null,
        },
      }),
    );
  });
