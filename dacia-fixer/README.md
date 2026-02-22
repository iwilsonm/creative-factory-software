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
                       ├─ Fixed → ↓
                       └─ Failed after 3 tries → alert for manual intervention

Layer 3: RESURRECT     Query Convex for batch_jobs with status=failed
                       Reset to pending → scheduler picks them up next poll
                       Batches ALWAYS eventually complete ✓
```

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
| AUTO_COMMIT | false | Git commit successful fixes |

## Logs

- Activity: `logs/fixer_YYYY-MM-DD.log`
- Spend tracking: `logs/spend_YYYY-MM-DD.txt`
- Cron output: `logs/cron.log`
