import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';

const DOC_TYPE_LABELS = {
  research: 'Research',
  avatar: 'Avatar',
  offer_brief: 'Offer Brief',
  necessary_beliefs: 'Necessary Beliefs',
};

export default function CopywriterChat({ projectId, projectName }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [isInitializing, setIsInitializing] = useState(false);
  const [threadId, setThreadId] = useState(null);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState(null);
  const [loadedDocs, setLoadedDocs] = useState({}); // { research: true, avatar: true, ... }
  const [docsExpanded, setDocsExpanded] = useState(false);
  const [docContents, setDocContents] = useState({}); // { research: "...", avatar: "...", ... }
  const [viewingDoc, setViewingDoc] = useState(null); // which doc type is being viewed

  const streamingTextRef = useRef('');
  const abortRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Load existing thread + doc statuses on mount / project change
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // Load thread and docs in parallel
        const [threadData, docsData] = await Promise.all([
          api.getChatThread(projectId),
          api.getDocs(projectId),
        ]);
        if (cancelled) return;

        // Thread
        if (threadData.thread) {
          setThreadId(threadData.thread.id);
          const visible = (threadData.messages || []).filter(m => !m.is_context_message);
          setMessages(visible.map(m => ({ id: m.id, role: m.role, content: m.content })));
        } else {
          setThreadId(null);
          setMessages([]);
        }

        // Doc statuses — check which of the 4 types exist
        const docs = docsData.docs || docsData || [];
        const docMap = {};
        const contentMap = {};
        for (const doc of docs) {
          const type = doc.doc_type;
          if (DOC_TYPE_LABELS[type]) {
            docMap[type] = true;
            contentMap[type] = doc.content || '';
          }
        }
        setLoadedDocs(docMap);
        setDocContents(contentMap);
      } catch (err) {
        console.error('[Chat] Failed to load thread/docs:', err);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [projectId]);

  // Auto-scroll on new messages or streaming text
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen && !isStreaming) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Cleanup abort on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current();
        abortRef.current = null;
      }
    };
  }, []);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isStreaming) return;

    setError(null);
    setInputValue('');
    setIsStreaming(true);
    setStreamingText('');
    streamingTextRef.current = '';

    // Optimistic: add user message
    const userMsg = { id: 'temp-user-' + Date.now(), role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);

    // Check if this is a new thread (no existing thread)
    if (!threadId) {
      setIsInitializing(true);
    }

    try {
      const { abort, done } = api.sendChatMessage(projectId, text, (event) => {
        if (event.type === 'status') {
          setStatusText(event.text);
        } else if (event.type === 'token') {
          streamingTextRef.current += event.text;
          setStreamingText(streamingTextRef.current);
          setStatusText('');
          setIsInitializing(false);
        } else if (event.type === 'done') {
          if (event.threadId) setThreadId(event.threadId);
        } else if (event.type === 'error') {
          setError(event.text);
        }
      });

      abortRef.current = abort;
      await done;

      // Move streaming text to messages array
      if (streamingTextRef.current) {
        setMessages(prev => [
          ...prev,
          { id: 'assistant-' + Date.now(), role: 'assistant', content: streamingTextRef.current },
        ]);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Failed to send message');
      }
    } finally {
      setIsStreaming(false);
      setStreamingText('');
      streamingTextRef.current = '';
      setStatusText('');
      setIsInitializing(false);
      abortRef.current = null;
    }
  }, [inputValue, isStreaming, projectId, threadId]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClear = async () => {
    if (isStreaming) return;
    try {
      await api.clearChat(projectId);
      setMessages([]);
      setThreadId(null);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to clear chat');
    }
  };

  // ─── Minimized floating button ─────────────────────────────────────────

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-lg hover:shadow-xl hover:scale-105 transition-all duration-200 flex items-center justify-center group"
        title="Chat with Copywriter AI"
      >
        {/* Chat bubble icon */}
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        {messages.length > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center shadow-sm">
            {messages.filter(m => m.role === 'assistant').length}
          </span>
        )}
      </button>
    );
  }

  // ─── Expanded chat panel ───────────────────────────────────────────────

  return (
    <div className="fixed bottom-6 right-6 z-50 w-[400px] h-[520px] bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-gray-200/60 flex flex-col overflow-hidden fade-in">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-t-2xl">
        <div className="flex items-center justify-between px-4 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <div className="min-w-0">
              <span className="text-[13px] font-semibold block truncate">{projectName || 'Project'} Chat</span>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {messages.length > 0 && (
              <button
                onClick={handleClear}
                disabled={isStreaming}
                className="text-white/70 hover:text-white p-1 rounded transition-colors disabled:opacity-40"
                title="Clear conversation"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            )}
            <button
              onClick={() => setIsOpen(false)}
              className="text-white/70 hover:text-white p-1 rounded transition-colors"
              title="Minimize"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>

        {/* Doc status strip */}
        <div className="px-4 pb-2.5">
          <button
            onClick={() => setDocsExpanded(prev => !prev)}
            className="flex items-center gap-1.5 text-[10px] text-white/80 hover:text-white transition-colors w-full"
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span className="font-medium">
              {Object.keys(loadedDocs).length === 4
                ? 'All 4 docs loaded'
                : `${Object.keys(loadedDocs).length}/4 docs loaded`}
            </span>
            <svg className={`w-3 h-3 transition-transform ${docsExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {docsExpanded && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {Object.entries(DOC_TYPE_LABELS).map(([type, label]) => {
                const exists = loadedDocs[type];
                return (
                  <button
                    key={type}
                    onClick={() => exists && setViewingDoc(viewingDoc === type ? null : type)}
                    className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium transition-all ${
                      exists
                        ? 'bg-white/25 text-white cursor-pointer hover:bg-white/35'
                        : 'bg-white/10 text-white/40 cursor-default'
                    }`}
                    title={exists ? `Click to view ${label}` : `${label} not generated yet`}
                  >
                    {exists ? '\u2713' : '\u2717'} {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Doc viewer overlay */}
      {viewingDoc && docContents[viewingDoc] && (
        <div className="border-b border-gray-200/60 bg-gray-50/80 max-h-[200px] overflow-y-auto scrollbar-thin">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100/80 sticky top-0 bg-gray-50/95 backdrop-blur-sm">
            <span className="text-[11px] font-semibold text-gray-700">{DOC_TYPE_LABELS[viewingDoc]}</span>
            <button
              onClick={() => setViewingDoc(null)}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="px-3 py-2">
            <p className="text-[11px] text-gray-600 leading-relaxed whitespace-pre-wrap">
              {docContents[viewingDoc].length > 3000
                ? docContents[viewingDoc].slice(0, 3000) + '\n\n... (truncated — view full doc in Foundational Docs tab)'
                : docContents[viewingDoc]}
            </p>
          </div>
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scrollbar-thin">
        {messages.length === 0 && !isStreaming && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <p className="text-[13px] font-medium text-gray-700 mb-1">{projectName || 'Project'} Copywriter</p>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              {Object.keys(loadedDocs).length > 0
                ? `${Object.keys(loadedDocs).length} foundational doc${Object.keys(loadedDocs).length !== 1 ? 's' : ''} loaded for ${projectName || 'this project'}. Send a message to start chatting.`
                : `No foundational docs found. Generate docs first for best results.`}
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] px-3 py-2 rounded-2xl text-[13px] leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-blue-500 text-white rounded-br-md'
                  : 'bg-gray-100/80 text-gray-800 rounded-bl-md'
              }`}
            >
              <div className="whitespace-pre-wrap break-words">{msg.content}</div>
            </div>
          </div>
        ))}

        {/* Streaming response */}
        {isStreaming && streamingText && (
          <div className="flex justify-start">
            <div className="max-w-[85%] px-3 py-2 rounded-2xl rounded-bl-md bg-gray-100/80 text-gray-800 text-[13px] leading-relaxed">
              <div className="whitespace-pre-wrap break-words">{streamingText}</div>
            </div>
          </div>
        )}

        {/* Typing / initializing indicator */}
        {isStreaming && !streamingText && (
          <div className="flex justify-start">
            <div className="px-3 py-2 rounded-2xl rounded-bl-md bg-gray-100/80">
              {isInitializing || statusText ? (
                <p className="text-[11px] text-blue-500 font-medium flex items-center gap-1.5">
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {statusText || 'Initializing...'}
                </p>
              ) : (
                <div className="flex gap-1 items-center py-1">
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="flex justify-center">
            <div className="px-3 py-1.5 rounded-lg bg-red-50 border border-red-200/60 text-[11px] text-red-600">
              {error}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="px-4 py-3 border-t border-gray-100/80">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? 'Waiting for response...' : 'Type a message...'}
            disabled={isStreaming}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-200/80 bg-gray-50/50 px-3 py-2 text-[13px] text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-300 disabled:opacity-50 transition-all max-h-[100px] overflow-y-auto"
            style={{ minHeight: '38px' }}
            onInput={(e) => {
              // Auto-resize textarea
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
            }}
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !inputValue.trim()}
            className="w-9 h-9 rounded-xl bg-blue-500 hover:bg-blue-600 disabled:bg-gray-200 disabled:text-gray-400 text-white flex items-center justify-center transition-all flex-shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-7 7m7-7l7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
