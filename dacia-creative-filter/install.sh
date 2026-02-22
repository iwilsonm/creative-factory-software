#!/bin/bash
# ============================================================
# DACIA CREATIVE FILTER - Setup
# Part of the Dacia Recursive Agents team — Agent #2
# ============================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DACIA CREATIVE FILTER Setup — Recursive Agent #2"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

chmod +x "${SCRIPT_DIR}/filter.sh"
chmod +x "${SCRIPT_DIR}/agents/"*.sh

echo "Checking dependencies..."
for cmd in curl jq bc; do
  command -v "$cmd" &>/dev/null && echo "  ✓ $cmd" || echo "  ✗ $cmd (install: sudo apt install $cmd)"
done

echo ""
source "${SCRIPT_DIR}/config/filter.conf"

[[ -z "$ANTHROPIC_API_KEY" ]] && echo "⚠ ANTHROPIC_API_KEY not set" || echo "✓ ANTHROPIC_API_KEY"

echo ""
echo "Commands:"
echo "  ./filter.sh                 # Process new batches once"
echo "  ./filter.sh --daemon        # Run continuously (every 30 min)"
echo "  ./filter.sh --status        # Today's stats"
echo "  ./filter.sh --dry-run       # Score without deploying"
echo ""
echo "Cron setup (every 30 min):"
echo "  */30 * * * * ANTHROPIC_API_KEY='...' ${SCRIPT_DIR}/filter.sh >> ${SCRIPT_DIR}/logs/cron.log 2>&1"
echo ""
echo "━━━ Setup complete ━━━"
