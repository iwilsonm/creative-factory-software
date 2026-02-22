# Dacia Creative Filter

**Recursive Agent #2** in the Dacia Recursive Agents team.

Scores batch ad output using Claude Sonnet 4.6, groups winners into flex ads, and deploys them to Ready to Post. Your employee reviews and clicks to launch.

## Dacia Recursive Agents

| # | Agent | Role | Budget | Status |
|---|-------|------|--------|--------|
| 1 | **Dacia Fixer** | Auto-test, self-heal code, resurrect failed batches | $40/mo | ✅ Active |
| 2 | **Dacia Creative Filter** | Score ads, build flex ads, deploy to Ready to Post | $31/mo | ✅ Active |
| 3 | *TBD* | — | — | 🔲 Planned |

---

## How It Works

```
Batch completes (50 ads generated)
  │
  ├─ 1. SCORE (Sonnet 4.6 × 50 ads)
  │     Copy strength, Meta compliance, effectiveness, visual alignment
  │     Hard requirements: spelling, first-line hook, CTA, alignment
  │     Each ad scored 1-10 (auto-fail if hard reqs violated)
  │
  ├─ 2. FILTER
  │     ~28 pass (score ≥ 7 + all hard requirements)
  │     ~22 rejected + tagged "Filter Rejected"
  │
  ├─ 3. GROUP (Sonnet 4.6 × 1 call)
  │     Cluster 28 passing ads by angle/theme
  │     Pick 2 strongest clusters
  │     Select 10 best images per cluster
  │     Select 3-5 best headlines per cluster (variety required)
  │     Select 3-5 best primary texts per cluster (variety required)
  │     Each headline/text re-checked for spelling, hooks, CTAs
  │
  ├─ 4. REGENERATION LOOP (if needed)
  │     For each flex ad:
  │       ├─ Enough headlines (≥3)? → continue
  │       │   └─ No → Sonnet generates new ones → validates → retry up to 3x
  │       ├─ Enough primary texts (≥3)? → continue
  │       │   └─ No → Sonnet generates new ones → validates → retry up to 3x
  │       └─ All validated for spelling, hooks, CTAs, alignment
  │     Flex ads ALWAYS get completed — never skipped
  │
  ├─ 5. ASSEMBLE
  │     Create ad set: "[Brand] Filter - 2026-02-24"
  │     Build 2 flex ads:
  │       • 10 images each
  │       • 3-5 headlines each (Meta rotates/tests)
  │       • 3-5 primary texts each (Meta rotates/tests)
  │     Fill in CTA, display link, Facebook Page from project config
  │
  └─ 6. DEPLOY → Ready to Post
        Your employee sees 2 fully assembled flex ads
        Reviews → clicks Post → live on Meta
        Meta automatically tests headline × text × image combinations
```

## Cost Estimates

### Per-Batch Costs

| Step | Model | Calls | Cost |
|------|-------|-------|------|
| Score 50 ads | Sonnet 4.6 | 50 | ~$1.00 |
| Group into flex ads | Sonnet 4.6 | 1 | ~$0.04 |
| Regeneration (if needed) | Sonnet 4.6 | 0-12 | ~$0.00-$0.60 |
| Validation of regen'd copy | Sonnet 4.6 | 0-6 | ~$0.00-$0.06 |
| Everything else | Code | — | $0.00 |
| **Per batch (no regen)** | | | **~$1.04** |
| **Per batch (typical regen)** | | | **~$1.20** |
| **Per batch (heavy regen)** | | | **~$1.70** |

### Monthly Projections

| Batches/Day | Regen Frequency | Daily Cost | Monthly Cost |
|-------------|----------------|------------|--------------|
| 1 (no regen needed) | 0% | ~$1.04 | **~$31** |
| 1 (typical — some regen) | 50% | ~$1.12 | **~$34** |
| 1 (heavy — always regen) | 100% | ~$1.70 | **~$51** |
| 2 brands (typical regen) | 50% | ~$2.24 | **~$67** |

### Output Per Batch

| Metric | Count |
|--------|-------|
| Ads generated | ~50 |
| Ads passing filter | ~25-30 |
| Flex ads created | 2 |
| Images per flex ad | 10 |
| Headlines per flex ad | 3-5 (min 3 required) |
| Primary texts per flex ad | 3-5 (min 3 required) |
| Total ads deployed to Ready to Post | 20 images across 2 flex ads |
| Meta combinations tested per flex ad | up to 5 × 5 × 10 = 250 |

## Quick Start

```bash
bash install.sh
vim config/filter.conf                    # Configure
./filter.sh --dry-run                    # Test without deploying
./filter.sh                              # Process new batches
./filter.sh --status                     # Check stats
nohup ./filter.sh --daemon &             # Go live
```

## Commands

```bash
./filter.sh                      # Process unprocessed batches once
./filter.sh --daemon             # Run continuously (every 30 min)
./filter.sh --status             # Today's stats
./filter.sh --dry-run            # Score but don't deploy
```

## Per-Project Configuration Required

Each brand/project needs these fields set in project settings:

| Field | Example | Required |
|-------|---------|----------|
| `scout_default_campaign` | Campaign ID to file flex ads under | ✅ |
| `scout_cta` | "Shop Now" | ✅ |
| `scout_display_link` | "healnaturally.com" | ✅ |
| `scout_facebook_page` | Facebook Page ID | ✅ |
| `scout_score_threshold` | 7 (override global default) | Optional |
| `scout_enabled` | true/false | Optional (default: true) |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| SCORE_THRESHOLD | 7 | Minimum score (1-10) to pass |
| FLEX_AD_COUNT | 2 | Number of flex ads per batch |
| IMAGES_PER_FLEX | 10 | Images per flex ad |
| HEADLINES_TARGET | 5 | Target headlines per flex ad |
| HEADLINES_MIN | 3 | Minimum headlines to execute (skip flex ad if below) |
| PRIMARY_TEXTS_TARGET | 5 | Target primary texts per flex ad |
| PRIMARY_TEXTS_MIN | 3 | Minimum primary texts to execute (skip flex ad if below) |
| CHECK_INTERVAL | 1800 | Seconds between checks (1800 = 30 min) |
| DAILY_BUDGET_CENTS | 133 | Hard cap (~$40/mo with buffer) |
| AUTO_DEPLOY | true | Auto-deploy to Ready to Post |
| TAG_REJECTED | true | Tag failed ads as "Filter Rejected" |
| TAG_WINNERS | true | Tag passed ads as "Filter Approved" |

## Logs

- Activity: `logs/filter_YYYY-MM-DD.log`
- Spend tracking: `logs/spend_YYYY-MM-DD.txt`
- Cron output: `logs/cron.log`
