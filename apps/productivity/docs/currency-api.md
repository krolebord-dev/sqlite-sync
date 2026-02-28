# Frankfurter Currency API

Frankfurter is a free, open-source currency data API that tracks reference exchange rates published by the [European Central Bank](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html).

- No API keys required
- No usage caps or rate limits
- Works client-side (browser, mobile apps)
- Free for commercial use
- [Self-hostable](https://hub.docker.com/r/lineofflight/frankfurter) via Docker
- [GitHub](https://github.com/lineofflight/frankfurter)

**Base URL:** `https://api.frankfurter.dev`

## Endpoints

### Latest Rates

Fetch the most recent working day's rates. Updated daily around **16:00 CET**.

```
GET /v1/latest
```

| Parameter | Type   | Default | Description                              |
|-----------|--------|---------|------------------------------------------|
| `base`    | string | `EUR`   | Base currency code                       |
| `symbols` | string | all     | Comma-separated list of target currencies |

**Examples:**

```bash
# Default (EUR base, all currencies)
curl -s https://api.frankfurter.dev/v1/latest

# USD as base currency
curl -s https://api.frankfurter.dev/v1/latest?base=USD

# Only CHF and GBP
curl -s https://api.frankfurter.dev/v1/latest?symbols=CHF,GBP
```

**Response:**

```json
{
  "base": "EUR",
  "date": "2024-11-25",
  "rates": {
    "AUD": 1.6111,
    "BGN": 1.9558,
    "BRL": 6.0941,
    "CAD": 1.4648
  }
}
```

### Historical Rates

Retrieve rates for a specific date (format: `YYYY-MM-DD`). Data available from **1999-01-04** onward.

```
GET /v1/{date}
```

| Parameter | Type   | Default | Description                              |
|-----------|--------|---------|------------------------------------------|
| `base`    | string | `EUR`   | Base currency code                       |
| `symbols` | string | all     | Comma-separated list of target currencies |

**Examples:**

```bash
# Rates on a specific date
curl -s https://api.frankfurter.dev/v1/1999-01-04

# With base and symbol filters
curl -s "https://api.frankfurter.dev/v1/1999-01-04?base=USD&symbols=EUR"
```

**Response:**

```json
{
  "base": "USD",
  "date": "1999-01-04",
  "rates": {
    "EUR": 0.84825
  }
}
```

> **Note:** Dates are stored in UTC. If you use a different time zone, you may be querying a different calendar date than intended. Data for today is not stable and will update if new rates are published.

### Time Series

Fetch rates over a date range using the `..` separator.

```
GET /v1/{start_date}..{end_date}
GET /v1/{start_date}..
```

| Parameter | Type   | Default | Description                              |
|-----------|--------|---------|------------------------------------------|
| `base`    | string | `EUR`   | Base currency code                       |
| `symbols` | string | all     | Comma-separated list of target currencies |

**Examples:**

```bash
# Full year 2000
curl -s https://api.frankfurter.dev/v1/2000-01-01..2000-12-31

# From a date to present (open-ended)
curl -s https://api.frankfurter.dev/v1/2024-01-01..

# Filtered to a single currency
curl -s "https://api.frankfurter.dev/v1/2024-01-01..?symbols=USD"
```

**Response:**

```json
{
  "base": "EUR",
  "start_date": "2023-12-29",
  "end_date": "2024-11-25",
  "rates": {
    "2023-12-29": {
      "USD": 1.105
    },
    "2024-01-02": {
      "USD": 1.0956
    },
    "2024-01-03": {
      "USD": 1.0919
    }
  }
}
```

> **Tip:** Filter currencies with `symbols` to reduce response size and improve performance on large date ranges.

### Currencies

List all supported currency codes and their full names.

```
GET /v1/currencies
```

**Response:**

```json
{
  "AUD": "Australian Dollar",
  "BGN": "Bulgarian Lev",
  "BRL": "Brazilian Real",
  "CAD": "Canadian Dollar",
  "CHF": "Swiss Franc",
  "CNY": "Chinese Yuan",
  "CZK": "Czech Koruna",
  "DKK": "Danish Krone",
  "EUR": "Euro",
  "GBP": "British Pound",
  "..."
}
```

## Currency Conversion

There is no dedicated conversion endpoint. Fetch the exchange rate and calculate in your code:

```javascript
async function convert(from, to, amount) {
  const resp = await fetch(
    `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`
  );
  const data = await resp.json();
  const converted = (amount * data.rates[to]).toFixed(2);
  return `${amount} ${from} = ${converted} ${to}`;
}

await convert("EUR", "USD", 10);
// => "10 EUR = 10.50 USD"
```

## Self-Hosting

```bash
docker run -d -p 80:8080 lineofflight/frankfurter
```

## FAQ

| Question | Answer |
|----------|--------|
| Free for commercial use? | Yes |
| Rate limits? | None. For high-volume, consider querying ECB data directly or self-hosting. |
| Long-term availability? | Running for over a decade with no plans to shut down. Self-host for critical apps. |
| Privacy policy? | The API collects no personal data. The public instance runs behind Cloudflare which collects basic analytics. Self-hosting avoids this. |
| Missing currency? | [Open a GitHub issue](https://github.com/lineofflight/frankfurter/issues) with a suggested non-commercial data source. |
