# enrichr — company & person enrichment pipeline for Pipedrive CRM

set dotenv-load

model := env("ENRICHR_MODEL", "anthropic/claude-sonnet-4-20250514")

# ─── Setup ────────────────────────────────────────────────────────

setup:
    cd company-lookup && npm install
    cd person-lookup && npm install
    cd linkedin-persons && npm install
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

# ─── LinkedIn Persons ────────────────────────────────────────

# Start Chrome with CDP for LinkedIn scraping.
# Uses a separate profile at ~/.enrichr-chrome.
# First time: log into LinkedIn. Session persists for future runs.
# Your normal Chrome can stay open — this is a separate instance.
chrome-linkedin:
    #!/usr/bin/env bash
    set -euo pipefail
    DIR="$HOME/.enrichr-chrome"
    mkdir -p "$DIR"
    echo "Starting Chrome with CDP on port 9222..."
    echo "Profile: $DIR"
    echo "First time? Log into LinkedIn. Session persists for future runs."
    echo ""
    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
      --remote-debugging-port=9222 \
      --user-data-dir="$DIR" \
      --no-first-run \
      --no-default-browser-check \
      "https://www.linkedin.com"

linkedin-lookup +args:
    npx tsx linkedin-persons/lookup.ts --model "{{model}}" {{args}}

linkedin-batch in out prompt concurrency='3' max_pages='5':
    npx tsx linkedin-persons/batch.ts --model "{{model}}" --in "{{in}}" --out "{{out}}" --prompt "{{prompt}}" --concurrency "{{concurrency}}" --max-pages "{{max_pages}}"

# ─── Viewer ───────────────────────────────────────────────────────

viewer-build +args='':
    npx tsx viewer/build.ts {{args}}

# ─── Claude Code ─────────────────────────────────────────────────

claude:
    claude

claude-yolo:
    claude --dangerously-skip-permissions

viewer-serve:
    #!/usr/bin/env bash
    python3 -m http.server 8090 &
    PID=$!; sleep 1; open http://localhost:8090/viewer.html
    echo "http://localhost:8090/viewer.html (Ctrl+C to stop)"
    wait $PID
