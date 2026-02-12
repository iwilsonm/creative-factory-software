import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import { getProject, getDocsByProject, getLatestDoc, updateProject } from '../db.js';
import db from '../db.js';
import {
  generateAllDocs,
  regenerateDoc,
  generateFromManualResearch,
  STEPS,
  prompt1_AnalyzeSalesPage,
  prompt2_ResearchMethodology,
  prompt3_GenerateResearchPrompt
} from '../services/docGenerator.js';

const router = Router();
router.use(requireAuth);

// List all docs for a project
router.get('/:projectId/docs', (req, res) => {
  const project = getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const docs = getDocsByProject(req.params.projectId);

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
// Returns the 3 prompts the user should run manually in ChatGPT/Claude,
// pre-filled with their project's actual product data.
router.get('/:projectId/research-prompts', (req, res) => {
  const project = getProject(req.params.projectId);
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
// Accepts { docs: { research?: string, avatar?: string, offer_brief?: string, necessary_beliefs?: string } }
router.post('/:projectId/upload-docs', (req, res) => {
  const project = getProject(req.params.projectId);
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
    const existing = getLatestDoc(req.params.projectId, docType);
    const version = existing ? existing.version + 1 : 1;
    const id = uuidv4();

    db.prepare(`
      INSERT INTO foundational_docs (id, project_id, doc_type, content, version, source, updated_at)
      VALUES (?, ?, ?, ?, ?, 'uploaded', datetime('now'))
    `).run(id, req.params.projectId, docType, content.trim(), version);

    saved.push({ id, doc_type: docType, version });
  }

  if (saved.length === 0) {
    return res.status(400).json({ error: 'No documents with content were provided' });
  }

  // Update project status if we have all 4 docs now
  const allDocs = getDocsByProject(req.params.projectId);
  const types = new Set(allDocs.map(d => d.doc_type));
  if (validTypes.every(t => types.has(t))) {
    updateProject(req.params.projectId, { status: 'docs_ready' });
  } else {
    updateProject(req.params.projectId, { status: 'setup' });
  }

  res.json({ saved, count: saved.length });
});

// Generate synthesis docs from manually-uploaded research (SSE streaming)
// Saves the user's research, then runs only Steps 5-8 via GPT-4.1.
router.post('/:projectId/generate-docs-manual', (req, res) => {
  const project = getProject(req.params.projectId);
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
// NOTE: Deep research step can take 5-15+ minutes. We disable request timeout
// and send periodic keepalive comments to prevent proxy timeouts.
router.post('/:projectId/generate-docs', (req, res) => {
  const project = getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Disable Express/Node timeout for this long-running request
  req.setTimeout(0);
  res.setTimeout(0);

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // nginx: disable proxy buffering
  });

  // Send keepalive comments every 30 seconds to prevent proxy timeouts
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
router.post('/:projectId/generate-doc/:type', (req, res) => {
  const project = getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const validTypes = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];
  if (!validTypes.includes(req.params.type)) {
    return res.status(400).json({ error: `Invalid doc type. Must be one of: ${validTypes.join(', ')}` });
  }

  // Disable timeout for research regeneration (can take 15+ minutes)
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

// Update doc content (manual edit)
router.put('/:projectId/docs/:docId', (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'Content is required' });

  const doc = db.prepare('SELECT * FROM foundational_docs WHERE id = ? AND project_id = ?')
    .get(req.params.docId, req.params.projectId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  db.prepare("UPDATE foundational_docs SET content = ?, updated_at = datetime('now') WHERE id = ?").run(content, req.params.docId);

  const updated = db.prepare('SELECT * FROM foundational_docs WHERE id = ?').get(req.params.docId);
  res.json(updated);
});

// Approve a doc
router.put('/:projectId/docs/:docId/approve', (req, res) => {
  const doc = db.prepare('SELECT * FROM foundational_docs WHERE id = ? AND project_id = ?')
    .get(req.params.docId, req.params.projectId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const approved = doc.approved ? 0 : 1; // Toggle
  db.prepare('UPDATE foundational_docs SET approved = ? WHERE id = ?').run(approved, req.params.docId);

  const updated = db.prepare('SELECT * FROM foundational_docs WHERE id = ?').get(req.params.docId);
  res.json(updated);
});

export default router;
