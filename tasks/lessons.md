# Lessons

Patterns captured after user corrections. Read at session start. Every entry describes a real mistake, what should have happened instead, and the rule that prevents a repeat.

---

## 2026-04-24 — Plan mode is not a one-shot

**What happened:** Ian approved a plan in plan mode for one set of changes (tabs, Copywriter strip, OpenAI GPT Image 2). After executing and exiting plan mode, he made two follow-on requests in subsequent turns:
1. Add "Copy LLM Prompt" to Creative Director + remove Generate-LPs box
2. Remove the Meta Ads UI that was still rendering

Both were non-trivial (the Meta strip alone was 932 lines across 8 files). I executed both without re-entering plan mode.

**Why it was wrong:** CLAUDE.md says "Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)." Dacia standards go further: `Plan → PEF → Approval → Build`, every time, no shortcuts. Skipping the plan stage meant:
- I misjudged the Meta Ads strip as "remove one UI card" when it was actually a multi-file dependency sweep
- No PEF pass on either change → no SWOT / red-team surfaced edge cases
- Ian had no chance to redirect scope before I spent compute

**The rule, explicit:**
1. Plan mode is per-task, not per-session. An approved plan only covers the task it was approved for.
2. When a new user message arrives with a non-trivial ask (3+ steps, multi-file, or architectural), the default is: enter plan mode, write the plan, PEF it, call ExitPlanMode for approval. Do this BEFORE any grep, read, edit, or bash beyond read-only exploration.
3. "The user is frustrated, I should just fix it fast" is the moment I'm MOST likely to skip planning and make the situation worse. In that moment: slow down, plan harder.
4. Scope misjudgment is a plan-mode trigger on its own. If during execution I discover "this is bigger than I thought," stop, re-plan. (CLAUDE.md §1: "If something goes sideways, STOP and re-plan immediately.")

**Red flags that should re-trigger plan mode:**
- "Strip X entirely" — strips are almost always bigger than they look
- "Remove Y, it's dead code" — dependency chains surface on contact
- "Add feature Z" where Z touches more than one file or layer
- Any message that references multiple disconnected changes ("also do A and B")

---

## 2026-04-24 — Strips need a full dependency sweep, not just the obvious file

**What happened:** The "Meta Ads" feature was supposedly stripped in an earlier pass (backend routes + services deleted, Convex tables dropped). But the per-project Meta Ads UI card was still rendering in Project Settings because only the backend was removed. The frontend still had:
- 11 Meta state variables in ProjectDetail
- 7 Meta handlers calling no-op API stubs
- 243 lines of Meta UI chrome
- OAuth callback query-param handling
- Plus the AdTracker linking button, Campaign Browser modal, and Meta Performance panel

The API stubs (`getMetaStatus: async () => ({ connected: false })` etc.) kept the UI from crashing, which meant the dead UI stayed invisible to the build and to me.

**Why it was wrong:** A strip is not done until every one of these is zero:
1. Backend routes + services
2. Convex schema + functions
3. Frontend API methods (no stubs — delete the methods entirely)
4. Frontend state, handlers, and JSX that referenced the feature
5. Scripts, docs, and test files that referenced deleted modules

Leaving step 3 as "no-op stubs" is a trap: it hides the step-4 debt. The user sees the dead UI, thinks the strip was never done, and (correctly) gets frustrated.

**The rule, explicit:**
- When stripping a feature, do ALL layers in one pass. No "stubs to keep the UI from crashing, TODO cleanup." That comment was literally in api.js for the Meta stubs.
- Preflight grep the feature name across `backend/`, `frontend/src/`, `convex/` BEFORE declaring a strip plan done. If the grep returns anything other than historical docs, the strip is incomplete.
- If the grep is noisy (common words like "meta"), grep for specific identifiers (`linkMetaAd`, `metaConnected`, `getMetaStatus`) — at least one will be unique enough.
- The preflight-grep step belongs in the plan (Phase 0). I wrote a Phase 0 preflight for the Quote Mining strip and it caught everything. I did not write a Phase 0 for the Meta strip and missed the entire frontend.
