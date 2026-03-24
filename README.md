# Enrichr

Company data enrichment tool. Look up companies by name/address and get structured JSON or Excel-compatible CSV with website URLs, industry, contacts, and more.

Uses LLM knowledge (Claude, GPT, Gemini, etc.) + HTTP verification for URLs.

## Setup

```bash
just setup
```

Or manually:

```bash
brew install just node
cd pi-company-lookup && npm install
pi /login  # authenticate with your provider
```

## Recipes

```bash
just setup                                                        # install dependencies

just lookup "Acme GmbH, Wien"                                     # single → JSON
just lookup --format csv "Acme GmbH, Wien"                        # single → CSV

just lookup-batch --in orgs.csv --out enriched.csv                # batch → CSV (5 parallel)
just lookup-batch --format json --in orgs.csv --out enriched.json # batch → JSON
just lookup-batch --concurrency 10 --in orgs.csv --out out.csv    # 10 parallel

just lookup-retry .work/data_out/orgs.csv                         # retry missing fields
just lookup-retry --field phone --field email orgs.csv             # retry specific fields

```

Switch models:

```bash
SPOTTER_MODEL=openai/gpt-4o just lookup "Acme GmbH"
SPOTTER_MODEL=google/gemini-2.5-pro just lookup-batch --in orgs.csv --out out.csv
```

## Output

### JSON

```json
{
  "org_name": "Acme GmbH",
  "website_url": "www.acme.at",
  "address": "Musterstraße 1, 1010 Wien, Österreich",
  "country": "AT",
  "industry": "Software Development",
  "employee_count_range": "11-50",
  "legal_form": "GmbH",
  "uid": "ATU12345678",
  "registry_number": "524525t",
  "phone": "+4312345678",
  "email": "office@acme.at",
  "linkedin_url": "www.linkedin.com/company/acme-gmbh",
  "label": null,
  "description": "Austrian software company based in Wien.",
  "confidence": 0.85
}
```

### CSV (Excel-compatible)

- Semicolon-separated (`;`)
- UTF-8 BOM for correct umlauts in Excel
- CRLF line endings
- `="11-50"` notation to prevent Excel date auto-formatting

## Schema

Full schema at [`company-lookup/schema.json`](company-lookup/schema.json).

| Field | Type | Format |
|-------|------|--------|
| `org_name` | string | Official name from Firmenbuch incl. legal form |
| `website_url` | string \| null | `www.acme.at` (no https://) |
| `address` | string \| null | `Musterstraße 1, 1010 Wien, Österreich` |
| `country` | string \| null | ISO 3166-1 alpha-2 |
| `industry` | string \| null | Tätigkeitsfeld |
| `employee_count_range` | string \| null | `1-10`, `11-50`, `51-200`, `201-500`, etc. |
| `legal_form` | string \| null | GmbH, AG, KG, e.U., OG, KöR |
| `uid` | string \| null | `ATU12345678` (no spaces) |
| `registry_number` | string \| null | `524525t` (no FN prefix, lowercase letter) |
| `phone` | string \| null | `+4312345678` (no spaces, +43) |
| `email` | string \| null | All lowercase |
| `linkedin_url` | string \| null | `www.linkedin.com/company/...` (no https://) |
| `label` | string \| null | Customer, Warm Lead, Hot Lead, etc. |
| `description` | string \| null | 1-2 sentence description |
| `confidence` | number | 0.0 = guess, 1.0 = certain |

URLs are verified with HTTP HEAD — bad URLs are set to `null`.

## How It Works

1. Your query → pi SDK (handles OAuth/API key auth) → LLM API → raw JSON
2. Schema validation → URL verification (HTTP HEAD) → nullify bad URLs
3. Output as JSON or Excel-compatible CSV

Single lookup: 1 process, 1 API call. Batch: N parallel API calls with resume support.

## Project Structure

```
spotter/
├── justfile                              # all commands
└── company-lookup/
    ├── lookup.ts                         # single lookup
    ├── batch.ts                          # parallel batch with resume
    ├── retry.ts                          # retry missing fields
    ├── csv.ts                            # shared Excel-compatible CSV utils
    └── schema.json                       # output schema (source of truth)
```
