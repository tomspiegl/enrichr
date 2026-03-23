# enrichr — company & person enrichment pipeline

set dotenv-load

# Default model for lookups (override with ENRICHR_MODEL env var)
model := env("ENRICHR_MODEL", "anthropic/claude-sonnet-4-20250514")

# Install all dependencies
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== Checking brew ==="
    command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
    echo "=== Installing system deps ==="
    brew install just node 2>/dev/null || brew upgrade just node 2>/dev/null || true
    echo "=== Installing npm deps ==="
    cd company-lookup && npm install
    cd ../person-lookup && npm install
    echo "=== Done ==="
    echo "Run: pi /login (if not already logged in)"
    echo "Then: just company-lookup \"Company Name, City\""
    echo "  or: just person-lookup \"www.example.at\""

# ─── Company Lookup ───────────────────────────────────────────────

# Look up a single company
# e.g. just company-lookup "Acme GmbH, Wien"
# e.g. just company-lookup --format csv "Acme GmbH, Wien"
company-lookup +query:
    npx tsx company-lookup/lookup.ts --model "{{model}}" {{query}}

# Look up and save to .work/lookups/
company-lookup-save +query:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p .work/lookups
    slug=$(echo "{{query}}" | sed 's/--format [a-z]*//' | cut -d',' -f1 | xargs | tr ' ' '_' | tr '/' '-')
    just company-lookup {{query}} > ".work/lookups/${slug}.json"
    echo "saved .work/lookups/${slug}.json" >&2

# Batch company lookup: input file → output file
# e.g. just company-batch --in orgs.csv --out enriched.csv
# e.g. just company-batch --concurrency 10 --in orgs.csv --out enriched.csv
company-batch +args:
    npx tsx company-lookup/batch.ts --model "{{model}}" {{args}}

# Retry orgs missing fields in output file
# e.g. just company-retry .work/data_out/orgs.csv
company-retry +args:
    npx tsx company-lookup/retry.ts --model "{{model}}" {{args}}

# ─── Person Lookup ────────────────────────────────────────────────

# Look up persons on a single website
# e.g. just person-lookup "www.ablo.at"
# e.g. just person-lookup --format csv "www.example.at"
person-lookup +query:
    npx tsx person-lookup/lookup.ts --model "{{model}}" {{query}}

# Look up persons and save to .work/lookups/
person-lookup-save +query:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p .work/lookups
    slug=$(echo "{{query}}" | sed 's/--format [a-z]*//' | sed 's|www\.||' | cut -d'/' -f1 | xargs | tr '.' '_' | tr '/' '-')
    just person-lookup {{query}} > ".work/lookups/persons_${slug}.json"
    echo "saved .work/lookups/persons_${slug}.json" >&2

# Batch person lookup: reads company-batch output (or any CSV with website_url column)
# e.g. just person-batch --in .work/data_out/orgs.csv --out .work/data_out/persons.csv
# e.g. just person-batch --concurrency 3 --in orgs.csv --out persons.csv
person-batch +args:
    npx tsx person-lookup/batch.ts --model "{{model}}" {{args}}

# ─── Viewer ───────────────────────────────────────────────────────

# Build self-contained HTML viewer with embedded data (single file, no server needed)
# e.g. just viewer-build
# e.g. just viewer-build --orgs custom/orgs.csv --persons custom/persons.csv
viewer-build +args='':
    npx tsx viewer/build.ts {{args}}
    @echo "Open .work/viewer.html in your browser — no server needed"

# Start the data viewer with a local server (for development)
viewer-serve:
    #!/usr/bin/env bash
    cd .work && python3 -m http.server 8090 &
    PID=$!
    sleep 1
    open http://localhost:8090/app.html
    echo "Viewer running at http://localhost:8090/app.html (PID: $PID)"
    echo "Press Ctrl+C to stop"
    wait $PID
