# enrichr — company & person enrichment pipeline for Pipedrive CRM

set dotenv-load

model := env("ENRICHR_MODEL", "anthropic/claude-sonnet-4-20250514")

# ─── Setup ────────────────────────────────────────────────────────

setup:
    cd company-lookup && npm install
    cd person-lookup && npm install
    npm install

# ─── Company Lookup ───────────────────────────────────────────────

company-lookup +query:
    npx tsx company-lookup/lookup.ts --model "{{model}}" {{query}}

company-batch +args:
    npx tsx company-lookup/batch.ts --model "{{model}}" {{args}}

company-retry +args:
    npx tsx company-lookup/retry.ts --model "{{model}}" {{args}}

# ─── Person Lookup ────────────────────────────────────────────────

person-lookup +query:
    npx tsx person-lookup/lookup.ts --model "{{model}}" {{query}}

person-batch +args:
    npx tsx person-lookup/batch.ts --model "{{model}}" {{args}}

# ─── Viewer ───────────────────────────────────────────────────────

viewer-build +args='':
    npx tsx viewer/build.ts {{args}}

viewer-serve:
    #!/usr/bin/env bash
    python3 -m http.server 8090 &
    PID=$!; sleep 1; open http://localhost:8090/viewer.html
    echo "http://localhost:8090/viewer.html (Ctrl+C to stop)"
    wait $PID
