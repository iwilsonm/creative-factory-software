# Creative Factory — Changelog

## 2026-04-27 — Step 1 prompt: PDF-attach instruction + remove fallback string

**What changed**
- `backend/services/docGenerator.js`: `prompt1_AnalyzeSalesPage` now omits the trailing content block entirely when `salesPageContent` is empty/null instead of inserting placeholder text. Removed the `|| 'No sales page content provided.'` fallback at the 3 internal call sites (auto-gen step 1, re-run deep research, manual research synthesis).
- `backend/routes/documents.js`: `/research-prompts` Step 1 — removed the same fallback at the call site, rewrote the `instruction` text to tell the user to create a PDF of their PDP and attach it alongside the prompt, and added an optional `tip` field `{ text, linkLabel, linkUrl }` pointing to https://webtopdf.com/.
- `frontend/src/components/FoundationalDocs.jsx`: renders the optional `tip` as an italic line beneath the instruction with a clickable gold link. `e.stopPropagation()` prevents the link click from collapsing the expanded card.

**Why**
- Users picking "Generate with Prompts" with no `sales_page_content` saw a literal "No sales page content provided." inside the copyable Step 1 prompt — confusing and made the system look unfinished.
- The new flow is clearer: the user attaches a PDP PDF in their ChatGPT/Claude conversation alongside the prompt, which matches the prompt's existing wording ("I'm going to send you a PDF screenshot..."). The webtopdf.com tip gives them a concrete way to produce the PDF.

**What was tried that didn't work**
- N/A — single-pass change.
