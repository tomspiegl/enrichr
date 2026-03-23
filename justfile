# Spotter — company enrichment pipeline

set dotenv-load

# Default model for lookups (override with SPOTTER_MODEL env var)
model := env("SPOTTER_MODEL", "anthropic/claude-sonnet-4-20250514")

# Install all dependencies
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== Checking brew ==="
    command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
    echo "=== Installing system deps ==="
    brew install just node 2>/dev/null || brew upgrade just node 2>/dev/null || true
    echo "=== Installing npm deps ==="
    cd pi-company-lookup && npm install
    echo "=== Done ==="
    echo "Run: pi /login (if not already logged in)"
    echo "Then: just lookup \"Company Name, City\""

# Look up a single company
# e.g. just lookup "Acme GmbH, Wien"
# e.g. just lookup --format csv "Acme GmbH, Wien"
# e.g. SPOTTER_MODEL=openai/gpt-4o just lookup "Acme GmbH"
lookup +query:
    npx tsx company-lookup/lookup.ts --model "{{model}}" {{query}}

# Look up and save to .work/lookups/
lookup-save +query:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p .work/lookups
    slug=$(echo "{{query}}" | sed 's/--format [a-z]*//' | cut -d',' -f1 | xargs | tr ' ' '_' | tr '/' '-')
    just lookup {{query}} > ".work/lookups/${slug}.json"
    echo "saved .work/lookups/${slug}.json" >&2

# Retry orgs missing website_url in output file
# e.g. just lookup-retry .work/data_out/orgs.csv
lookup-retry +args:
    npx tsx company-lookup/retry.ts --model "{{model}}" {{args}}

# Batch lookup: input file → output file (5 parallel by default)
# e.g. just lookup-batch --in orgs.csv --out enriched.csv
# e.g. just lookup-batch --format json --in orgs.csv --out enriched.json
# e.g. just lookup-batch --concurrency 10 --in orgs.csv --out enriched.csv
lookup-batch +args:
    npx tsx company-lookup/batch.ts --model "{{model}}" {{args}}
