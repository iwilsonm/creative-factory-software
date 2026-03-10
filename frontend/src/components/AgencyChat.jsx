import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import AgentSidebar from './AgentSidebar';

// ─── Tool toggle dropdown ────────────────────────────────────────────────────

function ToolToggle({ tools, enabledTools, onToggle }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const readTools = tools.filter(t => t.category === 'read');
  const createTools = tools.filter(t => t.category === 'create');
  const enabledCount = enabledTools.length;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded-md border transition-colors ${
          enabledCount > 0
            ? 'bg-teal/5 border-teal/20 text-teal'
            : 'bg-black/[0.03] border-black/5 text-textmid hover:bg-black/5'
        }`}
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        Tools{enabledCount > 0 && ` (${enabledCount})`}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-white border border-black/10 rounded-lg shadow-lg z-50 py-2">
          <div className="px-3 py-1 text-[10px] font-semibold text-textmid uppercase tracking-wider">Read Data</div>
          {readTools.map(tool => (
            <label key={tool.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-black/[0.02] cursor-pointer">
              <input
                type="checkbox"
                checked={enabledTools.includes(tool.id)}
                onChange={() => onToggle(tool.id)}
                className="w-3.5 h-3.5 rounded border-black/20 text-navy focus:ring-navy/20"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-textdark">{tool.label}</div>
                <div className="text-[9px] text-textlight truncate">{tool.description}</div>
              </div>
            </label>
          ))}
          {createTools.length > 0 && (
            <>
              <div className="px-3 py-1 mt-1 text-[10px] font-semibold text-textmid uppercase tracking-wider border-t border-black/5 pt-2">Create</div>
              {createTools.map(tool => (
                <label key={tool.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-black/[0.02] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enabledTools.includes(tool.id)}
                    onChange={() => onToggle(tool.id)}
                    className="w-3.5 h-3.5 rounded border-black/20 text-navy focus:ring-navy/20"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-textdark">{tool.label}</div>
                    <div className="text-[9px] text-textlight truncate">{tool.description}</div>
                  </div>
                </label>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tool call inline display ────────────────────────────────────────────────

function ToolCallBlock({ name, input, result, isLoading }) {
  const [expanded, setExpanded] = useState(false);
  const toolLabel = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Check if result contains an image
  const hasImage = result && (result.image_data || result.image);

  return (
    <div className="my-2 border border-black/5 rounded-lg overflow-hidden bg-black/[0.01]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-textmid hover:bg-black/[0.02] transition-colors"
      >
        {isLoading ? (
          <svg className="w-3 h-3 animate-spin text-navy" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <span className="text-[10px]">🔧</span>
        )}
        <span className="font-medium">{toolLabel}</span>
        {!isLoading && result && (
          <svg className={`w-3 h-3 ml-auto transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {expanded && result && (
        <div className="px-3 pb-2 border-t border-black/5">
          {hasImage && (
            <img
              src={result.image_data || result.image}
              alt={result.prompt_used || 'Generated image'}
              className="mt-2 max-w-full max-h-64 rounded-md border border-black/5"
            />
          )}
          <pre className="mt-1 text-[10px] text-textmid overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
            {JSON.stringify(hasImage ? { ...result, image_data: '[image]', image: undefined } : result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function AgencyChat({ projectId }) {
  const toast = useToast();

  // Agent catalog
  const [agents, setAgents] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Tools
  const [availableTools, setAvailableTools] = useState([]);
  const [toolPrefs, setToolPrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem('agency_tool_prefs') || '{}'); } catch { return {}; }
  });

  // Chat state
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [statusText, setStatusText] = useState('');
  const [threadId, setThreadId] = useState(null);
  const [toolCalls, setToolCalls] = useState([]); // in-flight tool calls
  const [error, setError] = useState(null);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const abortRef = useRef(null);
  const streamingTextRef = useRef('');

  // Load agent catalog + tools on mount
  useEffect(() => {
    api.getAgencyAgents().then(data => {
      setAgents(data.agents || []);
      setDivisions(data.divisions || []);
    }).catch(err => {
      console.error('Failed to load agents:', err);
      toast.error('Failed to load agent catalog');
    });

    api.getAgencyTools().then(data => {
      setAvailableTools(data.tools || []);
    }).catch(() => {});
  }, []);

  // Load thread when agent changes
  useEffect(() => {
    if (!selectedAgent) return;
    setMessages([]);
    setStreamingText('');
    setStatusText('');
    setError(null);
    setToolCalls([]);
    streamingTextRef.current = '';

    // Abort any in-flight stream
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
    setIsStreaming(false);

    api.getAgencyChatThread(projectId, selectedAgent.id).then(data => {
      if (data.thread) {
        setThreadId(data.thread.id);
        setMessages(data.messages.filter(m => !m.is_context_message));
      } else {
        setThreadId(null);
        setMessages([]);
      }
    }).catch(err => {
      console.error('Failed to load thread:', err);
    });
  }, [selectedAgent, projectId]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, toolCalls]);

  // Tool toggle
  const enabledTools = selectedAgent ? (toolPrefs[selectedAgent.id] || []) : [];

  const toggleTool = useCallback((toolId) => {
    if (!selectedAgent) return;
    setToolPrefs(prev => {
      const agentTools = prev[selectedAgent.id] || [];
      const next = agentTools.includes(toolId)
        ? agentTools.filter(t => t !== toolId)
        : [...agentTools, toolId];
      const updated = { ...prev, [selectedAgent.id]: next };
      localStorage.setItem('agency_tool_prefs', JSON.stringify(updated));
      return updated;
    });
  }, [selectedAgent]);

  // Send message
  const handleSend = useCallback(() => {
    if (!selectedAgent || !inputValue.trim() || isStreaming) return;

    const userMessage = inputValue.trim();
    setInputValue('');
    setError(null);
    setToolCalls([]);
    setMessages(prev => [...prev, { role: 'user', content: userMessage, id: 'temp-' + Date.now() }]);
    setIsStreaming(true);
    setStreamingText('');
    streamingTextRef.current = '';
    setStatusText(`${selectedAgent.name} is thinking...`);

    // Resize textarea back
    if (textareaRef.current) textareaRef.current.style.height = '38px';

    const { abort, done } = api.sendAgencyChatMessage(
      projectId,
      selectedAgent.id,
      userMessage,
      (event) => {
        if (event.type === 'status') {
          setStatusText(event.text || '');
        } else if (event.type === 'token') {
          streamingTextRef.current += event.text;
          setStreamingText(streamingTextRef.current);
          setStatusText('');
        } else if (event.type === 'tool_call') {
          setToolCalls(prev => [...prev, { name: event.name, input: event.input, result: null, isLoading: true }]);
          setStatusText(`Using ${event.name.replace(/_/g, ' ')}...`);
        } else if (event.type === 'tool_result') {
          setToolCalls(prev => prev.map(tc =>
            tc.name === event.name && tc.isLoading
              ? { ...tc, result: event.result, isLoading: false }
              : tc
          ));
          setStatusText(`${selectedAgent.name} is analyzing results...`);
        } else if (event.type === 'done') {
          if (event.threadId) setThreadId(event.threadId);
          const fullText = streamingTextRef.current;
          if (fullText) {
            setMessages(prev => [...prev, { role: 'assistant', content: fullText, id: 'resp-' + Date.now() }]);
          }
          setStreamingText('');
          streamingTextRef.current = '';
          setIsStreaming(false);
          setStatusText('');
        } else if (event.type === 'error') {
          setError(event.text || 'An error occurred');
          setIsStreaming(false);
          setStreamingText('');
          streamingTextRef.current = '';
          setStatusText('');
        }
      },
      { enabledTools }
    );

    abortRef.current = abort;
    done.catch(() => {});
  }, [selectedAgent, inputValue, isStreaming, projectId, enabledTools]);

  // Clear thread
  const handleClear = useCallback(async () => {
    if (!selectedAgent) return;
    try {
      await api.clearAgencyChat(projectId, selectedAgent.id);
      setMessages([]);
      setThreadId(null);
      setToolCalls([]);
      setError(null);
    } catch (err) {
      toast.error('Failed to clear conversation');
    }
  }, [selectedAgent, projectId]);

  // Key handler
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  const handleInput = (e) => {
    setInputValue(e.target.value);
    e.target.style.height = '38px';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  };

  return (
    <div className="flex h-[calc(100vh-180px)] bg-white rounded-xl border border-black/5 overflow-hidden">
      {/* Sidebar */}
      <AgentSidebar
        agents={agents}
        divisions={divisions}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      {/* Chat panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedAgent ? (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-black/5 bg-white">
              <div className="flex items-center gap-2 min-w-0">
                {selectedAgent.emoji && <span className="text-base">{selectedAgent.emoji}</span>}
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-textdark truncate">{selectedAgent.name}</h3>
                  {selectedAgent.vibe && (
                    <p className="text-[10px] text-textlight truncate">{selectedAgent.vibe}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <ToolToggle
                  tools={availableTools}
                  enabledTools={enabledTools}
                  onToggle={toggleTool}
                />
                <button
                  onClick={handleClear}
                  disabled={isStreaming || messages.length === 0}
                  className="px-2 py-1 text-[10px] text-textmid bg-black/[0.03] border border-black/5 rounded-md hover:bg-black/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {messages.length === 0 && !isStreaming && (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  {selectedAgent.emoji && <span className="text-4xl mb-3">{selectedAgent.emoji}</span>}
                  <p className="text-sm font-medium text-textdark">{selectedAgent.name}</p>
                  <p className="text-xs text-textmid mt-1 max-w-md">{selectedAgent.description}</p>
                  <p className="text-[10px] text-textlight mt-3">Send a message to start the conversation.</p>
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={msg.id || i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-xl px-3.5 py-2.5 ${
                    msg.role === 'user'
                      ? 'bg-gradient-to-br from-navy to-navy-light text-white'
                      : 'bg-black/[0.03] text-textdark'
                  }`}>
                    <div className="text-xs leading-relaxed whitespace-pre-wrap break-words">{msg.content}</div>
                  </div>
                </div>
              ))}

              {/* Tool calls (shown during streaming) */}
              {toolCalls.map((tc, i) => (
                <ToolCallBlock key={i} name={tc.name} input={tc.input} result={tc.result} isLoading={tc.isLoading} />
              ))}

              {/* Streaming response */}
              {isStreaming && (streamingText || statusText) && (
                <div className="flex justify-start">
                  <div className="max-w-[80%] rounded-xl px-3.5 py-2.5 bg-black/[0.03] text-textdark">
                    {streamingText ? (
                      <div className="text-xs leading-relaxed whitespace-pre-wrap break-words">{streamingText}</div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="flex gap-1">
                          <span className="w-1.5 h-1.5 bg-navy/40 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-1.5 h-1.5 bg-navy/40 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-1.5 h-1.5 bg-navy/40 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                        {statusText && <span className="text-[10px] text-textlight">{statusText}</span>}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
                  {error}
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="border-t border-black/5 px-4 py-3 bg-white">
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={inputValue}
                  onChange={handleInput}
                  onKeyDown={handleKeyDown}
                  placeholder={`Message ${selectedAgent.name}...`}
                  disabled={isStreaming}
                  className="flex-1 resize-none px-3 py-2 text-xs bg-black/[0.02] border border-black/5 rounded-lg focus:outline-none focus:ring-1 focus:ring-navy/20 focus:border-navy/20 placeholder-textlight disabled:opacity-50"
                  style={{ height: '38px', maxHeight: '120px' }}
                  rows={1}
                />
                <button
                  onClick={handleSend}
                  disabled={!inputValue.trim() || isStreaming}
                  className="flex-shrink-0 w-8 h-[38px] flex items-center justify-center bg-navy text-white rounded-lg hover:bg-navy-light disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-7 7m7-7l7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </>
        ) : (
          /* No agent selected */
          <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
            <div className="text-4xl mb-4">🏢</div>
            <h3 className="text-lg font-semibold text-textdark">AI Agency</h3>
            <p className="text-xs text-textmid mt-2 max-w-md">
              Select an agent from the sidebar to start a conversation. Each agent has specialized expertise and a unique personality.
              Enable tools to give agents access to your project data.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 justify-center">
              {divisions.slice(0, 6).map(div => (
                <span key={div.id} className="px-2 py-1 text-[10px] bg-navy/5 text-navy rounded-full">
                  {div.label} ({div.agentCount})
                </span>
              ))}
              {divisions.length > 6 && (
                <span className="px-2 py-1 text-[10px] bg-black/5 text-textmid rounded-full">
                  +{divisions.length - 6} more
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
