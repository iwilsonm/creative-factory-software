import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import { getProject, getDocsByProject, getLatestDoc, updateProject, getSetting, setSetting } from '../convexClient.js';
import { convexClient, api } from '../convexClient.js';
import {
  generateAllDocs,
  regenerateDoc,
  generateFromManualResearch,
  findAndCorrectDocs,
  STEPS,
  prompt1_AnalyzeSalesPage,
  prompt2_ResearchMethodology,
  prompt3_GenerateResearchPrompt
} from '../services/docGenerator.js';

const router = Router();
router.use(requireAuth);

// List all docs for a project
router.get('/:projectId/docs', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const docs = await getDocsByProject(req.params.projectId);

  // Group by doc_type, return only latest version of each
  const latest = {};
  for (const doc of docs) {
    if (!latest[doc.doc_type] || doc.version > latest[doc.doc_type].version) {
      latest[doc.doc_type] = doc;
    }
  }

  res.json({
    docs: Object.values(latest),
    steps: STEPS.map(s => ({ id: s.id, label: s.label, savedAs: s.savedAs, mode: s.mode }))
  });
});

// Get pre-populated research prompts for manual research flow
router.get('/:projectId/research-prompts', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const prompts = [
    {
      step: 1,
      title: 'Step 1: Analyze Your Sales Page',
      instruction: 'Start a new conversation in ChatGPT or Claude. Copy and paste this entire prompt. It sends your sales page content for initial analysis.',
      prompt: prompt1_AnalyzeSalesPage(
        project.product_description,
        project.sales_page_content || 'No sales page content provided.'
      )
    },
    {
      step: 2,
      title: 'Step 2: Teach the Research Methodology',
      instruction: 'After getting the response from Step 1, send this second prompt in the SAME conversation. This teaches the AI the 4-layer research framework.',
      prompt: prompt2_ResearchMethodology()
    },
    {
      step: 3,
      title: 'Step 3: Generate Your Research Prompt',
      instruction: 'After getting the response from Step 2, send this final prompt in the SAME conversation. The AI will produce a detailed, specific research prompt for your product. Copy that output and use it to conduct deep research — either paste it into a new ChatGPT Deep Research session, or research the topics manually.',
      prompt: prompt3_GenerateResearchPrompt(project.name)
    }
  ];

  res.json({ prompts });
});

// Upload existing foundational documents directly (bypass all generation)
router.post('/:projectId/upload-docs', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { docs } = req.body;
  if (!docs || typeof docs !== 'object') {
    return res.status(400).json({ error: 'docs object is required' });
  }

  const validTypes = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];
  const saved = [];

  for (const [docType, content] of Object.entries(docs)) {
    if (!validTypes.includes(docType)) continue;
    if (!content || content.trim().length === 0) continue;

    // Get the next version number
    const existing = await getLatestDoc(req.params.projectId, docType);
    const version = existing ? existing.version + 1 : 1;
    const id = uuidv4();

    await convexClient.mutation(api.foundationalDocs.create, {
      externalId: id,
      project_id: req.params.projectId,
      doc_type: docType,
      content: content.trim(),
      version,
      source: 'uploaded',
    });

    saved.push({ id, doc_type: docType, version });
  }

  if (saved.length === 0) {
    return res.status(400).json({ error: 'No documents with content were provided' });
  }

  // Update project status if we have all 4 docs now
  const allDocs = await getDocsByProject(req.params.projectId);
  const types = new Set(allDocs.map(d => d.doc_type));
  if (validTypes.every(t => types.has(t))) {
    await updateProject(req.params.projectId, { status: 'docs_ready' });
  } else {
    await updateProject(req.params.projectId, { status: 'setup' });
  }

  res.json({ saved, count: saved.length });
});

// Generate synthesis docs from manually-uploaded research (SSE streaming)
router.post('/:projectId/generate-docs-manual', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { researchContent } = req.body;
  if (!researchContent || researchContent.trim().length === 0) {
    return res.status(400).json({ error: 'Research content is required' });
  }

  // Disable timeout (synthesis can take a few minutes)
  req.setTimeout(0);
  res.setTimeout(0);

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const keepalive = setInterval(() => {
    if (!closed) {
      res.write(': keepalive\n\n');
    }
  }, 30000);

  const sendEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  let closed = false;
  req.on('close', () => {
    closed = true;
    clearInterval(keepalive);
  });

  generateFromManualResearch(req.params.projectId, researchContent.trim(), (event) => {
    if (closed) return;
    sendEvent(event);
  }).then(() => {
    clearInterval(keepalive);
    if (!closed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }).catch((err) => {
    clearInterval(keepalive);
    if (!closed) {
      sendEvent({ type: 'error', message: err.message });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
});

// Generate all foundational docs (SSE streaming)
router.post('/:projectId/generate-docs', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Disable Express/Node timeout for this long-running request
  req.setTimeout(0);
  res.setTimeout(0);

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const keepalive = setInterval(() => {
    if (!closed) {
      res.write(': keepalive\n\n');
    }
  }, 30000);

  const sendEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  let closed = false;
  req.on('close', () => {
    closed = true;
    clearInterval(keepalive);
  });

  generateAllDocs(req.params.projectId, (event) => {
    if (closed) return;
    sendEvent(event);
  }).then(() => {
    clearInterval(keepalive);
    if (!closed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }).catch((err) => {
    clearInterval(keepalive);
    if (!closed) {
      sendEvent({ type: 'error', message: err.message });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
});

// Regenerate a single doc type (SSE streaming)
router.post('/:projectId/generate-doc/:type', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const validTypes = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];
  if (!validTypes.includes(req.params.type)) {
    return res.status(400).json({ error: `Invalid doc type. Must be one of: ${validTypes.join(', ')}` });
  }

  // Disable timeout for research regeneration
  req.setTimeout(0);
  res.setTimeout(0);

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const keepalive = setInterval(() => {
    if (!closed) {
      res.write(': keepalive\n\n');
    }
  }, 30000);

  const sendEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  let closed = false;
  req.on('close', () => {
    closed = true;
    clearInterval(keepalive);
  });

  regenerateDoc(req.params.projectId, req.params.type, (event) => {
    if (closed) return;
    sendEvent(event);
  }).then(() => {
    clearInterval(keepalive);
    if (!closed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }).catch((err) => {
    clearInterval(keepalive);
    if (!closed) {
      sendEvent({ type: 'error', message: err.message });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
});

// Update doc content (manual edit) — also logs to correction history
router.put('/:projectId/docs/:docId', async (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'Content is required' });

  try {
    // Fetch before-snapshot for changelog
    const beforeDoc = await convexClient.query(api.foundationalDocs.getByExternalId, { externalId: req.params.docId });
    if (!beforeDoc) return res.status(404).json({ error: 'Document not found' });
    const beforeContent = beforeDoc.content || '';

    await convexClient.mutation(api.foundationalDocs.update, {
      externalId: req.params.docId,
      content,
    });
    const doc = await convexClient.query(api.foundationalDocs.getByExternalId, { externalId: req.params.docId });

    // Log to correction history if content actually changed
    if (beforeContent !== content) {
      try {
        const DOC_LABELS = { research: 'Research Document', avatar: 'Avatar Sheet', offer_brief: 'Offer Brief', necessary_beliefs: 'Necessary Beliefs' };
        const historyKey = `correction_history_${req.params.projectId}`;
        const raw = await getSetting(historyKey);
        const history = raw ? JSON.parse(raw) : [];

        history.unshift({
          id: Date.now(),
          correction: `Manual edit to ${DOC_LABELS[doc.doc_type] || doc.doc_type}`,
          timestamp: new Date().toISOString(),
          manual: true,
          changes: [{
            doc_type: doc.doc_type,
            doc_id: doc.externalId,
            doc_label: DOC_LABELS[doc.doc_type] || doc.doc_type,
            old_text: beforeContent.length > 500 ? beforeContent.slice(0, 500) + '...' : beforeContent,
            new_text: content.length > 500 ? content.slice(0, 500) + '...' : content,
            before_content: beforeContent,
            after_content: content,
          }],
        });

        if (history.length > 50) history.length = 50;
        await setSetting(historyKey, JSON.stringify(history));
      } catch (histErr) {
        console.error('[ManualEdit] Failed to log to changelog:', histErr.message);
      }
    }

    res.json({
      id: doc.externalId,
      project_id: doc.project_id,
      doc_type: doc.doc_type,
      content: doc.content,
      version: doc.version,
      approved: doc.approved ? 1 : 0,
      source: doc.source,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    });
  } catch (err) {
    res.status(404).json({ error: 'Document not found' });
  }
});

// Approve a doc
router.put('/:projectId/docs/:docId/approve', async (req, res) => {
  try {
    const doc = await convexClient.query(api.foundationalDocs.getByExternalId, { externalId: req.params.docId });
    if (!doc || doc.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const newApproved = !doc.approved;
    await convexClient.mutation(api.foundationalDocs.update, {
      externalId: req.params.docId,
      approved: newApproved,
    });

    const updated = await convexClient.query(api.foundationalDocs.getByExternalId, { externalId: req.params.docId });
    res.json({
      id: updated.externalId,
      project_id: updated.project_id,
      doc_type: updated.doc_type,
      content: updated.content,
      version: updated.version,
      approved: updated.approved ? 1 : 0,
      source: updated.source,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    });
  } catch (err) {
    res.status(404).json({ error: 'Document not found' });
  }
});

// =============================================
// Copy Correction — find and fix inaccurate info
// =============================================

// Scan all docs for inaccurate claims and propose corrections
router.post('/:projectId/correct-docs', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { correction } = req.body;
  if (!correction || correction.trim().length === 0) {
    return res.status(400).json({ error: 'Correction instruction is required' });
  }

  console.log(`[CopyCorrection] Scanning docs for: "${correction.trim().slice(0, 80)}"`);
  const startTime = Date.now();
  try {
    const result = await findAndCorrectDocs(req.params.projectId, correction.trim());
    console.log(`[CopyCorrection] Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s — ${result.corrections?.length || 0} corrections found`);
    res.json(result);
  } catch (err) {
    console.error(`[CopyCorrection] Error after ${((Date.now() - startTime) / 1000).toFixed(1)}s:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to analyze documents' });
  }
});

// Apply proposed corrections to documents (with history tracking)
router.post('/:projectId/apply-corrections', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { corrections, correction_text } = req.body;
  if (!Array.isArray(corrections) || corrections.length === 0) {
    return res.status(400).json({ error: 'Corrections array is required' });
  }

  // 1. Fetch current doc content for before-snapshots
  const changes = [];
  const updated = [];
  for (const c of corrections) {
    if (!c.doc_id || !c.full_updated_content) continue;
    try {
      const currentDoc = await convexClient.query(api.foundationalDocs.getByExternalId, { externalId: c.doc_id });
      const beforeContent = currentDoc?.content || '';

      await convexClient.mutation(api.foundationalDocs.update, {
        externalId: c.doc_id,
        content: c.full_updated_content,
      });
      updated.push(c.doc_id);

      changes.push({
        doc_type: c.doc_type,
        doc_id: c.doc_id,
        doc_label: c.doc_label,
        old_text: c.old_text,
        new_text: c.new_text,
        before_content: beforeContent,
        after_content: c.full_updated_content,
      });
    } catch (err) {
      console.error(`[CopyCorrection] Failed to update doc ${c.doc_id}:`, err.message);
    }
  }

  // 2. Save to correction history
  if (changes.length > 0) {
    try {
      const historyKey = `correction_history_${req.params.projectId}`;
      const raw = await getSetting(historyKey);
      const history = raw ? JSON.parse(raw) : [];

      history.unshift({
        id: Date.now(),
        correction: correction_text || 'Unknown correction',
        timestamp: new Date().toISOString(),
        changes,
      });

      // Keep last 50
      if (history.length > 50) history.length = 50;
      await setSetting(historyKey, JSON.stringify(history));
    } catch (err) {
      console.error('[CopyCorrection] Failed to save history:', err.message);
    }
  }

  res.json({ success: true, updated_count: updated.length, updated_doc_ids: updated });
});

// Get correction history for a project
router.get('/:projectId/correction-history', async (req, res) => {
  try {
    const historyKey = `correction_history_${req.params.projectId}`;
    const raw = await getSetting(historyKey);
    const history = raw ? JSON.parse(raw) : [];
    res.json({ history });
  } catch {
    res.json({ history: [] });
  }
});

// Revert a correction (restore before-state of all docs in that correction)
router.post('/:projectId/revert-correction', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { correction_id } = req.body;
  if (!correction_id) return res.status(400).json({ error: 'correction_id is required' });

  try {
    const historyKey = `correction_history_${req.params.projectId}`;
    const raw = await getSetting(historyKey);
    const history = raw ? JSON.parse(raw) : [];

    const entry = history.find(h => h.id === correction_id);
    if (!entry) return res.status(404).json({ error: 'Correction not found in history' });

    // Restore each doc to its before_content
    const reverted = [];
    for (const change of entry.changes) {
      if (!change.doc_id || !change.before_content) continue;
      try {
        await convexClient.mutation(api.foundationalDocs.update, {
          externalId: change.doc_id,
          content: change.before_content,
        });
        reverted.push(change.doc_id);
      } catch (err) {
        console.error(`[CopyCorrection] Failed to revert doc ${change.doc_id}:`, err.message);
      }
    }

    // Remove this entry from history
    const updatedHistory = history.filter(h => h.id !== correction_id);
    await setSetting(historyKey, JSON.stringify(updatedHistory));

    res.json({ success: true, reverted_count: reverted.length });
  } catch (err) {
    console.error('[CopyCorrection] Revert error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to revert correction' });
  }
});

export default router;
