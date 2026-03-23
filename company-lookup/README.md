# @tomspiegl/pi-company-lookup

Pi extension for company data enrichment. Look up any company by name/address and get structured JSON with verified URLs.

## Install

```bash
# From git
pi install git:github.com/tomspiegl/enrichr

# Or local
pi install ./pi-company-lookup

# Or project-local
pi install -l ./pi-company-lookup
```

## Prerequisites

- [uv](https://docs.astral.sh/uv/) — Python package manager
- The `spotter` Python project (for `verify_result` and `json2csv` tools)

```bash
uv sync && uv pip install -e .
```

## Usage

### In pi interactive mode

```
/lookup Acme GmbH, Wien
```

Or just ask naturally:

```
Look up the company Acme GmbH from Wien
```

The LLM will call the `company_lookup` tool automatically.

### Output

Returns JSON matching `schema.json`:

```json
{
  "org_name": "Acme GmbH",
  "website_url": "https://www.acme.at",
  "address": "Musterstraße 1, 1010 Wien, Österreich",
  "country": "AT",
  "industry": "Manufacturing",
  "employee_count_range": "11-50",
  "legal_form": "GmbH",
  "registry_id": null,
  "phone": null,
  "email": null,
  "linkedin_url": null,
  "description": "Austrian company based in Wien.",
  "confidence": 0.7
}
```

URLs are verified via HTTP HEAD — bad URLs are automatically set to `null`.

## What's included

| Resource | Type | Description |
|----------|------|-------------|
| `extensions/company-lookup.ts` | Extension | `company_lookup` tool + `/lookup` command |
| `skills/company-lookup/` | Skill | Schema definition + skill description |
