#!/bin/bash
# ============================================================
# DACIA FIXER - Setup
# Part of the Dacia Recursive Agents team
# ============================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DACIA FIXER Setup — Recursive Agent #1"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

chmod +x "${SCRIPT_DIR}/fixer.sh"
chmod +x "${SCRIPT_DIR}/agents/"*.sh
chmod +x "${SCRIPT_DIR}/tests/"*.sh 2>/dev/null || true

echo "Checking dependencies..."
for cmd in curl jq bc git; do
  command -v "$cmd" &>/dev/null && echo "  ✓ $cmd" || echo "  ✗ $cmd (install: sudo apt install $cmd)"
done

echo ""
source "${SCRIPT_DIR}/config/fixer.conf"

[[ -z "$ANTHROPIC_API_KEY" ]] && echo "⚠ ANTHROPIC_API_KEY not set" || echo "✓ ANTHROPIC_API_KEY"
[[ -z "$GEMINI_API_KEY" ]]    && echo "⚠ GEMINI_API_KEY not set"    || echo "✓ GEMINI_API_KEY"

echo ""
echo "Cron setup (every 5 min):"
echo "  */5 * * * * ANTHROPIC_API_KEY='...' GEMINI_API_KEY='...' ${SCRIPT_DIR}/fixer.sh >> ${SCRIPT_DIR}/logs/cron.log 2>&1"
echo ""
echo "Or daemon mode:"
echo "  nohup ${SCRIPT_DIR}/fixer.sh --daemon &"
echo ""
echo "Commands:"
echo "  ./fixer.sh                 # Run once"
echo "  ./fixer.sh --daemon        # Continuous"
echo "  ./fixer.sh --status        # Today's stats"
echo "  ./fixer.sh --resurrect     # Resurrect failed batches only"
echo ""
echo "━━━ Setup complete ━━━"
