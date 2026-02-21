import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';

const DOC_TYPE_LABELS = {
  research: 'Research',
  avatar: 'Avatar',
  offer_brief: 'Offer Brief',
  necessary_beliefs: 'Necessary Beliefs',
};

// Image types Claude vision API supports natively (sent as base64)
const VISION_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
// All image types we accept (others shown as attachment markers)
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.tif', '.ico', '.heic', '.heif', '.avif'];
// PDF can be sent natively to Claude as a document block
const PDF_EXTENSION = '.pdf';
const DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.epub', '.mobi', '.txt', '.html', '.htm', '.md', '.csv', '.json', '.xml', '.rtf', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.tsx', '.ts', '.js', '.jsx', '.py', '.java', '.rb', '.go', '.rs', '.c', '.cpp', '.h', '.css', '.scss', '.less', '.sql', '.sh', '.bat', '.ps1', '.r', '.swift', '.kt', '.xls', '.xlsx'];
const ALL_ACCEPTED_EXTENSIONS = [...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS];

function isImageFile(filename) {
  return IMAGE_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
}

function isVisionImage(filename) {
  return VISION_IMAGE_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
}

function isPdfFile(filename) {
  return filename.toLowerCase().endsWith(PDF_EXTENSION);
}

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
  const [attachedFiles, setAttachedFiles] = useState([]); // [{ id, file, name, extracting, text, error, charCount }]
  const [isDragging, setIsDragging] = useState(false);

  const streamingTextRef = useRef('');
  const abortRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const dragCounterRef = useRef(0);

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

  const processFiles = useCallback(async (files) => {
    if (!files || files.length === 0) return;

    for (const file of files) {
      const id = Date.now() + '-' + Math.random().toString(36).slice(2);
      const isImage = isImageFile(file.name);
      const isPdf = isPdfFile(file.name);

      if (isImage) {
        // Images: read as data URL for preview + vision API
        const entry = { id, file, name: file.name, extracting: true, text: null, error: null, charCount: null, isImage: true, isPdf: false, dataUrl: null };
        setAttachedFiles(prev => [...prev, entry]);

        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Failed to read image'));
            reader.readAsDataURL(file);
          });
          setAttachedFiles(prev => prev.map(f =>
            f.id === id ? { ...f, extracting: false, dataUrl, text: `[Image: ${file.name}]`, charCount: 0 } : f
          ));
        } catch (err) {
          setAttachedFiles(prev => prev.map(f =>
            f.id === id ? { ...f, extracting: false, error: err.message || 'Failed to read image' } : f
          ));
        }
      } else if (isPdf) {
        // PDFs: read as base64 for native Claude document support + extract text as fallback
        const entry = { id, file, name: file.name, extracting: true, text: null, error: null, charCount: null, isImage: false, isPdf: true, dataUrl: null };
        setAttachedFiles(prev => [...prev, entry]);

        try {
          // Read PDF as base64 data URL for Claude document API
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Failed to read PDF'));
            reader.readAsDataURL(file);
          });

          // Also extract text for the stored message
          let extractedText = '';
          let charCount = 0;
          try {
            const result = await api.extractText(file);
            extractedText = result.text;
            charCount = result.charCount;
          } catch {
            // Text extraction failed, PDF will still be sent as document block
            extractedText = `[PDF: ${file.name}]`;
          }

          setAttachedFiles(prev => prev.map(f =>
            f.id === id ? { ...f, extracting: false, dataUrl, text: extractedText, charCount } : f
          ));
        } catch (err) {
          setAttachedFiles(prev => prev.map(f =>
            f.id === id ? { ...f, extracting: false, error: err.message || 'Failed to read PDF' } : f
          ));
        }
      } else {
        // Documents: extract text via backend
        const entry = { id, file, name: file.name, extracting: true, text: null, error: null, charCount: null, isImage: false, isPdf: false, dataUrl: null };
        setAttachedFiles(prev => [...prev, entry]);

        try {
          const result = await api.extractText(file);
          setAttachedFiles(prev => prev.map(f =>
            f.id === id ? { ...f, extracting: false, text: result.text, charCount: result.charCount } : f
          ));
        } catch (err) {
          setAttachedFiles(prev => prev.map(f =>
            f.id === id ? { ...f, extracting: false, error: err.message || 'Extraction failed' } : f
          ));
        }
      }
    }
  }, []);

  const handleFileSelect = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    processFiles(files);
  }, [processFiles]);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer?.types?.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);

    const files = Array.from(e.dataTransfer?.files || []);
    // Filter to accepted file types (documents + images)
    const validFiles = files.filter(f => ALL_ACCEPTED_EXTENSIONS.some(ext => f.name.toLowerCase().endsWith(ext)));
    if (validFiles.length > 0) {
      processFiles(validFiles);
    }
  }, [processFiles]);

  const removeAttachedFile = useCallback((id) => {
    setAttachedFiles(prev => prev.filter(f => f.id !== id));
  }, []);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    const stillExtracting = attachedFiles.some(f => f.extracting);
    if ((!text && attachedFiles.length === 0) || isStreaming || stillExtracting) return;

    setError(null);
    setInputValue('');
    setIsStreaming(true);
    setStreamingText('');
    streamingTextRef.current = '';

    // Build message with attached file content prepended
    const successfulFiles = attachedFiles.filter(f => (f.text || f.isImage || f.isPdf) && !f.error);
    const textOnlyFiles = successfulFiles.filter(f => !f.isImage && !f.isPdf);
    const pdfFilesWithText = successfulFiles.filter(f => f.isPdf && f.text && !f.dataUrl);
    const imageFiles = successfulFiles.filter(f => f.isImage);
    const pdfFilesNative = successfulFiles.filter(f => f.isPdf && f.dataUrl);

    // Text-extracted documents (non-image, non-native-PDF) get prepended as text
    const allTextDocs = [...textOnlyFiles, ...pdfFilesWithText];
    let fullMessage = text;
    if (allTextDocs.length > 0) {
      const fileBlocks = allTextDocs.map(f =>
        `[Attached: ${f.name}]\n\n${f.text}`
      ).join('\n\n---\n\n');
      fullMessage = text ? fileBlocks + '\n\n---\n\n' + text : fileBlocks;
    }

    // Build attachments array for Claude API (images as vision, PDFs as document blocks)
    const images = [
      ...imageFiles.filter(f => f.dataUrl).map(f => ({ name: f.name, dataUrl: f.dataUrl })),
      ...pdfFilesNative.map(f => ({ name: f.name, dataUrl: f.dataUrl, isPdf: true })),
    ];

    // Optimistic: show file chips + text in the UI (not the full extracted content)
    const displayContent = successfulFiles.length > 0
      ? `${successfulFiles.map(f => `[${f.name}]`).join(' ')}${text ? '\n' + text : ''}`
      : text;
    const userMsg = { id: 'temp-user-' + Date.now(), role: 'user', content: displayContent };
    setMessages(prev => [...prev, userMsg]);
    setAttachedFiles([]);

    // Check if this is a new thread (no existing thread)
    if (!threadId) {
      setIsInitializing(true);
    }

    try {
      const { abort, done } = api.sendChatMessage(projectId, fullMessage, (event) => {
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
      }, images.length > 0 ? { images } : undefined);

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
  }, [inputValue, isStreaming, projectId, threadId, attachedFiles]);

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
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-gradient-to-br from-navy to-navy-light text-white shadow-lg hover:shadow-xl hover:scale-105 transition-all duration-200 flex items-center justify-center group"
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
    <div
      className="fixed bottom-6 right-6 z-50 w-[400px] h-[520px] bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-gray-200/60 flex flex-col overflow-hidden fade-in"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag & drop overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-navy/90 backdrop-blur-sm rounded-2xl flex flex-col items-center justify-center pointer-events-none">
          <div className="w-16 h-16 rounded-2xl border-2 border-dashed border-white/50 flex items-center justify-center mb-3">
            <svg className="w-8 h-8 text-white/80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 16V4m0 0l-4 4m4-4l4 4M4 14v4a2 2 0 002 2h12a2 2 0 002-2v-4" />
            </svg>
          </div>
          <p className="text-white font-semibold text-[14px]">Drop files here</p>
          <p className="text-white/60 text-[11px] mt-1">Images, PDFs, documents, code, and more</p>
        </div>
      )}

      {/* Header */}
      <div className="bg-gradient-to-r from-navy to-navy-light text-white rounded-t-2xl">
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
        <div className="border-b border-black/5 bg-offwhite max-h-[200px] overflow-y-auto scrollbar-thin">
          <div className="flex items-center justify-between px-3 py-2 border-b border-black/5 sticky top-0 bg-offwhite/95 backdrop-blur-sm">
            <span className="text-[11px] font-semibold text-textdark">{DOC_TYPE_LABELS[viewingDoc]}</span>
            <button
              onClick={() => setViewingDoc(null)}
              className="text-textlight hover:text-textmid transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="px-3 py-2">
            <p className="text-[11px] text-textmid leading-relaxed whitespace-pre-wrap">
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
            <div className="w-12 h-12 rounded-full bg-navy/10 flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-navy/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <p className="text-[13px] font-medium text-textdark mb-1">{projectName || 'Project'} Copywriter</p>
            <p className="text-[11px] text-textlight leading-relaxed">
              {Object.keys(loadedDocs).length > 0
                ? `${Object.keys(loadedDocs).length} foundational doc${Object.keys(loadedDocs).length !== 1 ? 's' : ''} loaded for ${projectName || 'this project'}. Send a message to start chatting.`
                : `No foundational docs found. Generate docs first for best results.`}
            </p>
          </div>
        )}

        {messages.map((msg) => {
          // Parse file attachment indicators from user messages
          let displayContent = msg.content;
          let fileAttachments = [];
          if (msg.role === 'user') {
            const attachRegex = /\[([^\]]+\.\w+)\]/g;
            let match;
            while ((match = attachRegex.exec(msg.content)) !== null) {
              fileAttachments.push(match[1]);
            }
            displayContent = msg.content.replace(/\[([^\]]+\.\w+)\]\s*/g, '').trim();
          }

          return (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] px-3 py-2 rounded-2xl text-[13px] leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-navy text-white rounded-br-md'
                    : 'bg-black/5 text-textdark rounded-bl-md'
                }`}
              >
                {fileAttachments.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {fileAttachments.map((name, i) => (
                      <span key={i} className="inline-flex items-center gap-1 text-[10px] bg-white/20 px-1.5 py-0.5 rounded-md">
                        {isImageFile(name) ? (
                          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                        ) : (
                          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                        )}
                        {name}
                      </span>
                    ))}
                  </div>
                )}
                <div className="whitespace-pre-wrap break-words">{displayContent || (fileAttachments.length > 0 ? '' : msg.content)}</div>
              </div>
            </div>
          );
        })}

        {/* Streaming response */}
        {isStreaming && streamingText && (
          <div className="flex justify-start">
            <div className="max-w-[85%] px-3 py-2 rounded-2xl rounded-bl-md bg-black/5 text-textdark text-[13px] leading-relaxed">
              <div className="whitespace-pre-wrap break-words">{streamingText}</div>
            </div>
          </div>
        )}

        {/* Typing / initializing indicator */}
        {isStreaming && !streamingText && (
          <div className="flex justify-start">
            <div className="px-3 py-2 rounded-2xl rounded-bl-md bg-black/5">
              {isInitializing || statusText ? (
                <p className="text-[11px] text-navy font-medium flex items-center gap-1.5">
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {statusText || 'Initializing...'}
                </p>
              ) : (
                <div className="flex gap-1 items-center py-1">
                  <span className="w-2 h-2 bg-textlight rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-textlight rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-textlight rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
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
      <div className="px-4 py-3 border-t border-black/5">
        {/* Attached file chips */}
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachedFiles.map(f => (
              <span
                key={f.id}
                className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border ${
                  f.error ? 'bg-red-50 border-red-200 text-red-600'
                  : f.extracting ? 'bg-gold/5 border-gold/30 text-gold'
                  : 'bg-navy/5 border-navy/15 text-navy'
                }`}
              >
                {f.isImage && f.dataUrl ? (
                  <img src={f.dataUrl} alt={f.name} className="w-5 h-5 rounded object-cover flex-shrink-0" />
                ) : f.isImage ? (
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                )}
                <span className="truncate max-w-[120px]">{f.name}</span>
                {f.extracting && (
                  <svg className="w-3 h-3 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {!f.isImage && f.charCount > 0 && !f.extracting && (
                  <span className="text-[9px] text-textlight">{(f.charCount / 1000).toFixed(0)}k</span>
                )}
                {f.error && (
                  <span className="text-[9px]" title={f.error}>failed</span>
                )}
                <button
                  onClick={() => removeAttachedFile(f.id)}
                  className="text-current opacity-50 hover:opacity-100 ml-0.5"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* Attach file button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming}
            className="w-9 h-9 rounded-xl border border-black/10 hover:border-gold hover:bg-gold/5 text-textlight hover:text-gold disabled:opacity-40 flex items-center justify-center transition-all flex-shrink-0"
            title="Attach files (images, PDFs, documents, code)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.epub,.mobi,.txt,.html,.htm,.md,.csv,.json,.xml,.rtf,.log,.yaml,.yml,.toml,.ini,.cfg,.conf,.properties,.tsx,.ts,.js,.jsx,.py,.java,.rb,.go,.rs,.c,.cpp,.h,.css,.scss,.less,.sql,.sh,.bat,.ps1,.r,.swift,.kt,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp,.svg,.bmp,.tiff,.tif,.ico,.heic,.heif,.avif"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? 'Waiting for response...' : 'Type a message...'}
            disabled={isStreaming}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-black/10 bg-offwhite px-3 py-2 text-[13px] text-textdark placeholder:text-textlight focus:outline-none focus:ring-2 focus:ring-gold/20 focus:border-gold disabled:opacity-50 transition-all max-h-[100px] overflow-y-auto"
            style={{ minHeight: '38px' }}
            onInput={(e) => {
              // Auto-resize textarea
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
            }}
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || (!inputValue.trim() && attachedFiles.length === 0) || attachedFiles.some(f => f.extracting)}
            className="w-9 h-9 rounded-xl bg-navy hover:bg-navy-light disabled:bg-gray-200 disabled:text-textlight text-white flex items-center justify-center transition-all flex-shrink-0"
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
