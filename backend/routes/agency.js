import { Router } from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import {
  getActiveChatThreadForAgent,
  createAgencyChatThread,
  archiveChatThread,
  getChatMessages,
  createChatMessage,
  getLatestDoc,
} from '../convexClient.js';
import { getAnthropicClient } from '../services/quoteMiner.js';
import { createSSEStream } from '../utils/sseHelper.js';
import { withRetry } from '../services/retry.js';
import { logAnthropicCost } from '../services/costTracker.js';
import { getToolDefinitions, executeTool, getToolCatalog } from '../services/agencyTools.js';

const router = Router();

// Load agent data at startup
const __dirname = dirname(fileURLToPath(import.meta.url));
const agentDataPath = join(__dirname, '..', 'data', 'agents.json');
let agentData = { divisions: [], agents: [] };
try {
  agentData = JSON.parse(readFileSync(agentDataPath, 'utf-8'));
  console.log(`[Agency] Loaded ${agentData.agents.length} agents across ${agentData.divisions.length} divisions`);
} catch (err) {
  console.error('[Agency] Failed to load agents.json:', err.message);
}

function getAgent(agentId) {
  return agentData.agents.find(a => a.id === agentId);
}

/**
 * GET /api/agency/agents
 * Returns agent catalog (without systemPrompt for bandwidth).
 */
router.get('/agents', (req, res) => {
  const catalog = agentData.agents.map(({ id, name, description, color, emoji, vibe, division }) => ({
    id, name, description, color, emoji, vibe, division,
  }));
  res.json({ divisions: agentData.divisions, agents: catalog });
});

/**
 * GET /api/agency/tools
 * Returns available tools for the tool toggle UI.
 */
router.get('/tools', (req, res) => {
  res.json({ tools: getToolCatalog() });
});

/**
 * GET /api/projects/:projectId/agency/chat/thread?agentId=X
 * Returns the active thread + messages for a specific agent.
 */
router.get('/:projectId/agency/chat/thread', async (req, res) => {
  try {
    const { agentId } = req.query;
    if (!agentId) return res.status(400).json({ error: 'agentId query param is required' });

    const thread = await getActiveChatThreadForAgent(req.params.projectId, agentId);
    if (!thread) {
      return res.json({ thread: null, messages: [] });
    }
    const messages = await getChatMessages(thread.externalId);
    res.json({
      thread: { id: thread.externalId, project_id: thread.project_id, agent_id: agentId },
      messages: messages.map(m => ({
        id: m.externalId,
        role: m.role,
        content: m.content,
        is_context_message: m.is_context_message || false,
        created_at: m.created_at,
      })),
    });
  } catch (err) {
    console.error('[Agency] Error loading thread:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projects/:projectId/agency/chat/send
 * SSE streaming — sends a message to a specific agent, with optional tool use.
 */
router.post('/:projectId/agency/chat/send', async (req, res) => {
  const { agentId, message, images, enabledTools } = req.body;
  const projectId = req.params.projectId;

  if (!agentId) return res.status(400).json({ error: 'agentId is required' });
  if ((!message || !message.trim()) && (!images || images.length === 0)) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const agent = getAgent(agentId);
  if (!agent) return res.status(400).json({ error: `Unknown agent: ${agentId}` });

  const sse = createSSEStream(req, res);

  try {
    const client = await getAnthropicClient();

    // 1. Get or create agent-specific thread
    let thread = await getActiveChatThreadForAgent(projectId, agentId);
    let isNewThread = false;

    if (!thread) {
      isNewThread = true;
      const threadId = uuidv4();
      await createAgencyChatThread({
        id: threadId,
        project_id: projectId,
        agent_id: agentId,
        title: agent.name,
      });
      thread = { externalId: threadId, project_id: projectId };

      sse.sendEvent({ type: 'status', text: `Initializing ${agent.name} — loading project context...` });

      // Load foundational docs
      const docTypes = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];
      const latestDocs = await Promise.all(docTypes.map(dt => getLatestDoc(projectId, dt)));
      const docs = {};
      docTypes.forEach((dt, index) => {
        docs[dt] = latestDocs[index]?.content || `[No ${dt.replace('_', ' ')} document found]`;
      });

      const contextContent = `I'm working on a project and need your specialized help. Here are the foundational research documents for context:

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

      await createChatMessage({
        id: uuidv4(),
        thread_id: thread.externalId,
        project_id: projectId,
        role: 'user',
        content: contextContent,
        is_context_message: true,
      });

      // Get initial acknowledgment
      sse.sendEvent({ type: 'status', text: `${agent.name} is reviewing your project docs...` });
      const ackResponse = await withRetry(
        () => client.messages.create({
          model: 'claude-sonnet-4-6-20250514',
          max_tokens: 1024,
          system: agent.systemPrompt,
          messages: [{ role: 'user', content: contextContent }],
        }),
        { label: `[Agency Ack: ${agent.id}]` }
      );

      if (ackResponse.usage) {
        logAnthropicCost({
          model: 'claude-sonnet-4-6', operation: 'agency_chat_init',
          inputTokens: ackResponse.usage.input_tokens || 0,
          outputTokens: ackResponse.usage.output_tokens || 0,
          projectId,
        }).catch(() => {});
      }

      const ackText = ackResponse.content[0]?.text || `I've reviewed the project documents. How can I help?`;
      await createChatMessage({
        id: uuidv4(),
        thread_id: thread.externalId,
        project_id: projectId,
        role: 'assistant',
        content: ackText,
        is_context_message: true,
      });
    }

    // 2. Save the user's message
    const messageText = message?.trim() || '';
    const imageNames = (images || []).map(img => img.name).filter(Boolean);
    const storedMessage = imageNames.length > 0
      ? (messageText ? `${imageNames.map(n => `[${n}]`).join(' ')}\n${messageText}` : imageNames.map(n => `[${n}]`).join(' '))
      : messageText;

    await createChatMessage({
      id: uuidv4(),
      thread_id: thread.externalId,
      project_id: projectId,
      role: 'user',
      content: storedMessage,
    });

    // 3. Load all messages for conversation history
    const allMessages = await getChatMessages(thread.externalId);
    const anthropicMessages = allMessages.map(m => ({ role: m.role, content: m.content }));

    // 4. Handle image attachments on the last user message
    if (images && images.length > 0) {
      const lastMsg = anthropicMessages[anthropicMessages.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        const contentBlocks = [];
        for (const img of images) {
          if (img.dataUrl) {
            if (img.isPdf) {
              const pdfMatch = img.dataUrl.match(/^data:application\/pdf;base64,(.+)$/);
              if (pdfMatch) {
                contentBlocks.push({
                  type: 'document',
                  source: { type: 'base64', media_type: 'application/pdf', data: pdfMatch[1] },
                });
              }
            } else {
              const match = img.dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
              if (match) {
                const supportedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
                if (supportedTypes.includes(match[1])) {
                  contentBlocks.push({
                    type: 'image',
                    source: { type: 'base64', media_type: match[1], data: match[2] },
                  });
                }
              }
            }
          }
        }
        if (messageText) {
          contentBlocks.push({ type: 'text', text: messageText });
        } else if (contentBlocks.length > 0) {
          contentBlocks.push({ type: 'text', text: `Please analyze ${contentBlocks.length === 1 ? 'this image' : 'these images'}.` });
        }
        if (contentBlocks.length > 0) {
          lastMsg.content = contentBlocks;
        }
      }
    }

    // 5. Build tool definitions if any are enabled
    const tools = getToolDefinitions(enabledTools || []);

    // 6. Stream Claude's response (with tool use loop)
    sse.sendEvent({ type: 'status', text: `${agent.name} is thinking...` });

    let fullResponse = '';
    let loopMessages = [...anthropicMessages];
    let maxToolLoops = 5; // Safety limit

    while (maxToolLoops > 0) {
      const requestParams = {
        model: 'claude-sonnet-4-6-20250514',
        max_tokens: 4096,
        system: agent.systemPrompt,
        messages: loopMessages,
      };
      if (tools.length > 0) {
        requestParams.tools = tools;
      }

      const stream = await client.messages.stream(requestParams);

      let currentResponse = '';
      let toolUseBlocks = [];
      let currentToolUse = null;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            currentToolUse = { id: event.content_block.id, name: event.content_block.name, inputJson: '' };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta') {
            const text = event.delta.text;
            currentResponse += text;
            fullResponse += text;
            sse.sendEvent({ type: 'token', text });
          } else if (event.delta?.type === 'input_json_delta' && currentToolUse) {
            currentToolUse.inputJson += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop' && currentToolUse) {
          toolUseBlocks.push(currentToolUse);
          currentToolUse = null;
        }
      }

      // Log cost
      try {
        const finalMsg = await stream.finalMessage();
        if (finalMsg?.usage) {
          logAnthropicCost({
            model: 'claude-sonnet-4-6', operation: 'agency_chat',
            inputTokens: finalMsg.usage.input_tokens || 0,
            outputTokens: finalMsg.usage.output_tokens || 0,
            projectId,
          }).catch(() => {});
        }
      } catch { /* already consumed */ }

      // If no tool calls, we're done
      if (toolUseBlocks.length === 0) {
        break;
      }

      // Execute tool calls and continue the loop
      // Build the assistant message with all content blocks (text + tool_use)
      const assistantContent = [];
      if (currentResponse) {
        assistantContent.push({ type: 'text', text: currentResponse });
      }
      for (const tb of toolUseBlocks) {
        let parsedInput = {};
        try { parsedInput = JSON.parse(tb.inputJson || '{}'); } catch { /* empty */ }
        assistantContent.push({
          type: 'tool_use',
          id: tb.id,
          name: tb.name,
          input: parsedInput,
        });
      }

      loopMessages.push({ role: 'assistant', content: assistantContent });

      // Execute each tool and build tool_result messages
      const toolResults = [];
      for (const tb of toolUseBlocks) {
        let parsedInput = {};
        try { parsedInput = JSON.parse(tb.inputJson || '{}'); } catch { /* empty */ }

        sse.sendEvent({ type: 'tool_call', name: tb.name, input: parsedInput });

        try {
          const result = await executeTool(tb.name, projectId, parsedInput);
          sse.sendEvent({ type: 'tool_result', name: tb.name, result });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tb.id,
            content: JSON.stringify(result),
          });
        } catch (toolErr) {
          const errResult = { error: toolErr.message };
          sse.sendEvent({ type: 'tool_result', name: tb.name, result: errResult });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tb.id,
            content: JSON.stringify(errResult),
            is_error: true,
          });
        }
      }

      loopMessages.push({ role: 'user', content: toolResults });
      currentResponse = '';
      maxToolLoops--;
    }

    // 7. Save the full response
    await createChatMessage({
      id: uuidv4(),
      thread_id: thread.externalId,
      project_id: projectId,
      role: 'assistant',
      content: fullResponse,
    });

    sse.sendEvent({ type: 'done', threadId: thread.externalId });
    sse.end();
  } catch (err) {
    console.error('[Agency] Error sending message:', err);
    sse.sendEvent({ type: 'error', text: err.message || 'Failed to get response' });
    sse.end();
  }
});

/**
 * POST /api/projects/:projectId/agency/chat/clear
 * Archives the agent-specific thread.
 */
router.post('/:projectId/agency/chat/clear', async (req, res) => {
  try {
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });

    const thread = await getActiveChatThreadForAgent(req.params.projectId, agentId);
    if (thread) {
      await archiveChatThread(thread.externalId);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Agency] Error clearing thread:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
