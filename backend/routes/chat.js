import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { v4 as uuidv4 } from 'uuid';
import {
  getActiveChatThread,
  createChatThread,
  archiveChatThread,
  getChatMessages,
  createChatMessage,
  getLatestDoc,
} from '../convexClient.js';
import { getAnthropicClient } from '../services/quoteMiner.js';

const router = Router();
router.use(requireAuth);

const SYSTEM_PROMPT = `You are an expert direct response copywriter. You have been given foundational research documents about a product including customer research, an avatar profile, an offer brief, and necessary beliefs. You internalize these documents completely and reference specific details from them when writing copy or discussing strategy. Be conversational but knowledgeable. Give specific, actionable responses.`;

const PRIMING_MESSAGE = `Hey, Claude, I want you to please analyze the four documents that I've attached to this message. I've done a significant amount of research of a product that I'm going to be selling, and it's your role as my direct response copywriter to understand this research, the avatar document, the offer brief, and the necessary beliefs document to an extremely high degree. So please familiarize yourself with these documents before we proceed with writing anything.`;

/**
 * GET /:projectId/chat/thread
 * Returns the active thread + all messages for the project.
 */
router.get('/:projectId/chat/thread', async (req, res) => {
  try {
    const thread = await getActiveChatThread(req.params.projectId);
    if (!thread) {
      return res.json({ thread: null, messages: [] });
    }
    const messages = await getChatMessages(thread.externalId);
    res.json({
      thread: { id: thread.externalId, project_id: thread.project_id, title: thread.title, status: thread.status },
      messages: messages.map(m => ({
        id: m.externalId,
        role: m.role,
        content: m.content,
        is_context_message: m.is_context_message || false,
        created_at: m.created_at,
      })),
    });
  } catch (err) {
    console.error('[Chat] Error loading thread:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /:projectId/chat/send
 * SSE streaming endpoint — sends a message and streams Claude's response.
 */
router.post('/:projectId/chat/send', async (req, res) => {
  const { message } = req.body;
  const projectId = req.params.projectId;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const client = await getAnthropicClient();

    // 1. Get or create thread
    let thread = await getActiveChatThread(projectId);
    let isNewThread = false;

    if (!thread) {
      isNewThread = true;
      const threadId = uuidv4();
      await createChatThread({ id: threadId, project_id: projectId, title: 'Chat' });
      thread = { externalId: threadId, project_id: projectId };

      sendEvent({ type: 'status', text: 'Initializing — loading foundational docs...' });

      // Load all 4 foundational docs
      const docTypes = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];
      const docs = {};
      for (const dt of docTypes) {
        const doc = await getLatestDoc(projectId, dt);
        docs[dt] = doc?.content || `[No ${dt.replace('_', ' ')} document found]`;
      }

      // Build context message with priming text + all docs
      const contextContent = `${PRIMING_MESSAGE}

---

## Research Document
${docs.research}

---

## Avatar Document
${docs.avatar}

---

## Offer Brief
${docs.offer_brief}

---

## Necessary Beliefs Document
${docs.necessary_beliefs}`;

      // Save the priming/context message (hidden in UI)
      await createChatMessage({
        id: uuidv4(),
        thread_id: thread.externalId,
        project_id: projectId,
        role: 'user',
        content: contextContent,
        is_context_message: true,
      });

      // Get Claude's initial acknowledgment
      sendEvent({ type: 'status', text: 'Getting initial acknowledgment...' });
      const ackResponse = await client.messages.create({
        model: 'claude-sonnet-4-6-20250514',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: contextContent }],
      });

      const ackText = ackResponse.content[0]?.text || 'I\'ve reviewed all four documents. Ready to help with your copywriting.';

      // Save Claude's acknowledgment (also hidden in UI)
      await createChatMessage({
        id: uuidv4(),
        thread_id: thread.externalId,
        project_id: projectId,
        role: 'assistant',
        content: ackText,
        is_context_message: true,
      });
    }

    // 2. Save the user's new message
    await createChatMessage({
      id: uuidv4(),
      thread_id: thread.externalId,
      project_id: projectId,
      role: 'user',
      content: message.trim(),
    });

    // 3. Load ALL messages from Convex to build conversation history
    const allMessages = await getChatMessages(thread.externalId);
    const anthropicMessages = allMessages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    // 4. Stream Claude's response
    sendEvent({ type: 'status', text: 'Thinking...' });

    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: anthropicMessages,
    });

    let fullResponse = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        fullResponse += text;
        sendEvent({ type: 'token', text });
      }
    }

    // 5. Save assistant's full response
    await createChatMessage({
      id: uuidv4(),
      thread_id: thread.externalId,
      project_id: projectId,
      role: 'assistant',
      content: fullResponse,
    });

    sendEvent({ type: 'done', threadId: thread.externalId });
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[Chat] Error sending message:', err);
    sendEvent({ type: 'error', text: err.message || 'Failed to get response from Claude' });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

/**
 * POST /:projectId/chat/clear
 * Archives the current active thread so the next send creates a fresh one.
 */
router.post('/:projectId/chat/clear', async (req, res) => {
  try {
    const thread = await getActiveChatThread(req.params.projectId);
    if (thread) {
      await archiveChatThread(thread.externalId);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Chat] Error clearing thread:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
