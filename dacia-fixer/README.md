# Dacia Fixer

**Recursive Agent #1** in the Dacia Recursive Agents team.

Automated test, self-healing, and batch resurrection system for Dacia Automation. Runs your test suite every 5 minutes. When something breaks, AI agents diagnose and fix the code, then resurrect any failed batches so they execute successfully.

## Dacia Recursive Agents

| # | Agent | Role | Status |
|---|-------|------|--------|
| 1 | **Dacia Fixer** | Auto-test, self-heal code, resurrect failed batches | ✅ Active |
| 2 | *TBD* | — | 🔲 Planned |
| 3 | *TBD* | — | 🔲 Planned |

New agents are added to this table as they're built. Each agent operates independently on its own cron schedule with its own budget cap.

---

## Three-Layer Protection

```
Layer 1: TEST          Every 5 min, run batch test suite
                       ├─ Pass → check for orphaned failed batches → resurrect if any
                       └─ Fail ↓

Layer 2: FIX           Gemini diagnoses → Claude Sonnet fixes → re-test
                       ├─ Fixed → log to Fix Ledger → ↓
                       └─ Failed after 3 tries → alert for manual intervention

Layer 3: RESURRECT     Query Convex for batch_jobs with status=failed
                       Reset to pending → scheduler picks them up next poll
                       Batches ALWAYS eventually complete ✓
```

## Self-Improvement: Fix Ledger

The Fixer gets better over time through its **Fix Ledger** (`fix_ledger.md`) — a persistent record of every bug it fixes and how it fixed it.

### How It Works

Every successful fix is logged with the date, suite, files changed, and diagnosis summary. Both the diagnosis and fix agents receive the ledger as context on every run.

**Month 1:** Fixer encounters a bug in `batchProcessor.js` where `convexBatchToRow` returns undefined when `scheduled` is null. It diagnoses from scratch, reasons through the code, applies a nullish coalescing fix. Logs it.

**Month 2:** Same file breaks again — different function but similar null-handling issue. The diagnosis agent sees the ledger entry, recognizes the pattern immediately, and diagnoses in seconds instead of reasoning from scratch. The fix agent sees the proven approach and applies the same defensive pattern.

**Month 3:** `batchProcessor.js` breaks a third time. The pattern detection triggers (threshold: 3). The fix agent is told this is RECURRING and applies a **deeper fix** — not just patching the symptom but adding comprehensive input validation, null guards, and defensive error boundaries across the file. The file stops breaking.

### What the Ledger Gives You

| Benefit | How |
|---------|-----|
| Faster diagnosis | Agent recognizes known patterns instantly |
| Better fixes | Proven solutions applied instead of reasoning from scratch |
| Recurring pattern detection | Same file breaking 3+ times triggers deeper fix |
| Institutional memory | New bugs are diagnosed in context of all past bugs |
| Trend visibility | `--status` shows most frequently fixed files |

### Pattern Detection

When the same file appears in the ledger 3+ times (configurable via `PATTERN_ALERT_THRESHOLD`):
- A notification is sent alerting you to the recurring issue
- The diagnosis agent flags it as systemic
- The fix agent is instructed to apply a permanent fix, not a patch
- The goal: that file never breaks again

### Zero Extra Cost

The ledger is a markdown file. Reading it adds ~2K tokens to the diagnosis and fix prompts — negligible cost increase. The improvement is essentially free.

## Git Branch Isolation

All fixer commits go to a dedicated branch: `fixer/auto-fixes`. Your main branch stays clean.

```
main                          ← your code, Claude Code's code
  │
  └─ fixer/auto-fixes         ← only Dacia Fixer commits
       ├─ fix: batchProcessor.js null handling
       ├─ fix: headlineGenerator timeout retry
       └─ fix: convexBatchToRow scheduled mapping
```

**How it works:**
1. Fix is applied to the working directory (so the running server stays healthy)
2. Fix is committed to `fixer/auto-fixes` branch (not main)
3. Main branch has zero fixer commits
4. You review and merge when ready

**Commands:**
```bash
# See what the fixer has fixed
git log main..fixer/auto-fixes --oneline

# See the actual changes
git diff main..fixer/auto-fixes

# Merge fixes into main when ready
git checkout main && git merge fixer/auto-fixes

# Push fixer branch to GitHub for backup
git push origin fixer/auto-fixes
```

**What happens on deploy:**
When you `git pull` on main, fixer's working directory changes get overwritten. But the fixes are safe on `fixer/auto-fixes`. If the same bug resurfaces, the fixer recognizes it from the ledger and fixes it instantly. Merge the branch to make fixes permanent.

## Cost Estimates

### Per-Event Costs

| Event | What Runs | Cost |
|-------|-----------|------|
| Tests pass (normal) | bash test + Convex query | **$0.00** |
| Tests pass + orphan batches found | bash test + Convex query + reset | **$0.00** |
| Tests fail, fix succeeds (1 try) | Gemini diagnosis + Claude fix + re-test + resurrect | **~$0.06** |
| Tests fail, fix succeeds (3 tries) | 3× (Gemini + Claude) + resurrect | **~$0.18** |
| Tests fail, fix fails (all 3 tries) | 3× (Gemini + Claude) | **~$0.18** |

### Monthly Projections

| Scenario | Failures/Day | Avg Retries | Daily Cost | Monthly Cost |
|----------|-------------|-------------|------------|--------------|
| Smooth sailing | 0-1 | 1 | $0.00–$0.06 | **$0–$2** |
| Normal operations | 1-2 | 1.5 | $0.06–$0.18 | **$2–$6** |
| Bumpy week | 3-4 | 2 | $0.36–$0.72 | **$11–$22** |
| Rough patch | 5+ | 3 | $0.90+ | **$27+** |
| Worst case (budget cap) | — | — | $1.33 | **$40** |

**Typical month: $5–$15.** Hard-capped at $40/month.

### What's Free

- Running the test suite (bash)
- Checking Convex for stuck/failed batches (HTTP query)
- Resurrecting failed batches (Convex mutation)
- All notifications

### What Costs Money (Only On Failure)

- Gemini Flash diagnosis: ~$0.006/call (~1¢)
- Claude Sonnet fix: ~$0.05/call (~5¢)

## Quick Start

```bash
bash install.sh                          # Check dependencies
vim config/fixer.conf                    # Configure paths & keys
./fixer.sh batch_creation               # Test run
./fixer.sh --status                     # Check stats
nohup ./fixer.sh --daemon &             # Go live
```

## Commands

```bash
./fixer.sh                       # Run all suites once
./fixer.sh batch_creation        # Run specific suite
./fixer.sh --daemon              # Run continuously (every 5 min)
./fixer.sh --status              # Today's stats
./fixer.sh --resurrect           # Only resurrect failed batches
```

## Adding Test Suites

In `config/fixer.conf`:

```bash
SUITES=(
  "batch_creation"
  "landing_pages"
)

landing_pages_test_cmd="npm test -- --grep 'landing page'"
landing_pages_context=(
  "backend/services/lpGenerator.js"
  "backend/services/lpPublisher.js"
  "backend/routes/landingPages.js"
)
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| CHECK_INTERVAL | 300 | Seconds between checks (300 = 5 min) |
| MAX_RETRIES | 3 | Fix attempts per failure |
| DAILY_BUDGET_CENTS | 133 | Hard cap ($1.33/day = $40/month) |
| RESURRECT_BATCHES | true | Auto-resurrect failed batches |
| MAX_RESURRECT_AGE_HOURS | 24 | Only resurrect batches failed within this window |
| AUTO_COMMIT | true | Commit fixes to fixer branch |
| FIXER_BRANCH | fixer/auto-fixes | Dedicated branch for fixer commits |
| AUTO_PUSH | false | Push fixer branch to remote after commit |
| MAX_LEDGER_ENTRIES | 50 | Keep last N fixes in the ledger for context |
| PATTERN_ALERT_THRESHOLD | 3 | Alert + deeper fix when same file breaks this many times |

## Logs

- Activity: `logs/fixer_YYYY-MM-DD.log`
- Spend tracking: `logs/spend_YYYY-MM-DD.txt`
- Fix Ledger: `fix_ledger.md` (persistent — do NOT delete)
- Cron output: `logs/cron.log`
