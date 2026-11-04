import { useRef, useCallback, useMemo, useState, useEffect } from 'react';
import { highlightCode } from '../highlight.js';
import DOMPurify from 'dompurify';
import { getAcceptString } from '../fileUploader.js';
import styles from './EditorPanel.module.css';

// ── Smart editor helpers ─────────────────────────────────────────────────────
const OPEN_TO_CLOSE = { '(': ')', '{': '}', '[': ']', '"': '"', "'": "'" };
const CLOSE_CHARS   = new Set([')', '}', ']', '"', "'"]);
const OPEN_CHARS    = new Set(['(', '{', '[', '"', "'"]);

/**
 * Returns the indentation (leading spaces/tabs) of the line containing `pos`.
 */
function getLineIndent(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const match = text.slice(lineStart).match(/^[ \t]*/);
  return match ? match[0] : '';
}

export default function EditorPanel({
  code, onChange, onRun, onKill, onClear,
  isRunning = false,
  runStatus = 'idle',  // 'idle' | 'compiling' | 'running'
  isMobile  = false,
  // Multi-tab props
  tabs        = [],
  activeTabId = null,
  onTabSwitch,
  onTabAdd,
  onTabClose,
  onTabRename,
  onFileUpload,
  selectedLanguage = 'c',
}) {
  const textareaRef    = useRef(null);
  const preRef         = useRef(null);
  const gutterRef      = useRef(null);
  const renameInputRef = useRef(null);
  // Tracks whether the browser's IME (Android Gboard, etc.) is composing a
  // character. During composition e.key is often 'Unidentified', so we must
  // skip all smart-edit logic and let the IME handle keystrokes natively.
  const isComposingRef = useRef(false);

  // ── Undo / Redo history stack ─────────────────────────────────────────
  // Each entry: { code, start, end }
  const historyRef      = useRef([{ code, start: 0, end: 0 }]);
  const historyIdxRef   = useRef(0);
  const debounceTimer   = useRef(null);
  // Stores the latest typed state before the debounce timer fires
  const pendingEntryRef = useRef(null);

  // Push a snapshot to the undo stack (called after every programmatic edit)
  const pushHistory = useCallback((newCode, selStart, selEnd) => {
    // Truncate any redo entries ahead of current index
    historyRef.current = historyRef.current.slice(0, historyIdxRef.current + 1);
    historyRef.current.push({ code: newCode, start: selStart ?? 0, end: selEnd ?? 0 });
    historyIdxRef.current = historyRef.current.length - 1;
  }, []);

  // Flush any pending debounced entry into the history immediately
  const flushPending = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (pendingEntryRef.current) {
      const { code: c, start: s, end: en } = pendingEntryRef.current;
      pushHistory(c, s, en);
      pendingEntryRef.current = null;
    }
  }, [pushHistory]);

  // Keep the very first snapshot in sync when code is reset externally (tab switch)
  useEffect(() => {
    const cur = historyRef.current[historyIdxRef.current];
    if (cur && cur.code === code) return; // no-op if already matches
    // External reset (e.g. tab switch, AI convert) — clear history for new content
    clearTimeout(debounceTimer.current);
    pendingEntryRef.current = null;
    historyRef.current  = [{ code, start: 0, end: 0 }];
    historyIdxRef.current = 0;
  }, [activeTabId]); // reset when the active tab changes

  // ── Tab rename state ──────────────────────────────────────────────────
  const [editingTabId, setEditingTabId] = useState(null);
  const [editingName,  setEditingName]  = useState('');

  // ── Add-tab dropdown state ────────────────────────────────────────────
  const [showAddMenu, setShowAddMenu] = useState(false);
  const addMenuRef   = useRef(null);
  const addBtnRef    = useRef(null);
  const fileInputRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showAddMenu) return;
    const handleClick = (e) => {
      if (
        addMenuRef.current && !addMenuRef.current.contains(e.target) &&
        addBtnRef.current  && !addBtnRef.current.contains(e.target)
      ) {
        setShowAddMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAddMenu]);

  // Calculate dropdown position from the + button's bounding rect
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const openAddMenu = useCallback(() => {
    setShowAddMenu(prev => {
      if (!prev && addBtnRef.current) {
        const rect = addBtnRef.current.getBoundingClientRect();
        setMenuPos({ top: rect.bottom + 6, left: rect.left });
      }
      return !prev;
    });
  }, []);

  // Handle file selection from the hidden <input>
  const handleFileChange = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file && onFileUpload) {
      onFileUpload(file);
    }
    // Reset input so re-uploading the same file works
    e.target.value = '';
    setShowAddMenu(false);
  }, [onFileUpload]);

  const startRename = useCallback((id, name, e) => {
    e?.stopPropagation();
    setEditingTabId(id);
    setEditingName(name);
  }, []);

  const confirmRename = useCallback(() => {
    if (editingTabId !== null) {
      onTabRename?.(editingTabId, editingName);
      setEditingTabId(null);
    }
  }, [editingTabId, editingName, onTabRename]);

  const cancelRename = useCallback(() => setEditingTabId(null), []);

  // Memoize the highlighted HTML so it only recomputes when code or language changes
  const highlighted = useMemo(() => highlightCode(code, selectedLanguage), [code, selectedLanguage]);

  // Sync scroll between gutter, highlight layer, and textarea
  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop  = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = ta.scrollTop;
    }
  }, []);

  // ── Smart keyboard handler ──────────────────────────────────────────────────
  const handleKeyDown = useCallback((e) => {
    const ta    = textareaRef.current;
    const start = ta.selectionStart;
    const end   = ta.selectionEnd;
    const key   = e.key;

    // ── IME / Android virtual-keyboard guard ─────────────────────────────────
    // Android Gboard (and other IMEs) fire keydown with key='Unidentified' or
    // key='Process' during multi-step character composition. Our smart-edit
    // logic must not intercept these events — doing so (especially calling
    // e.preventDefault()) corrupts the IME state and duplicates / drops chars.
    // Ctrl/Meta shortcuts always pass through so Ctrl+Z etc. still work.
    if (!e.ctrlKey && !e.metaKey) {
      if (isComposingRef.current || key === 'Unidentified' || key === 'Process') return;
    }

    // ── Ctrl+Z → Undo ────────────────────────────────────────────────────────
    if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      // Commit any pending typed content into history first
      flushPending();
      if (historyIdxRef.current > 0) {
        historyIdxRef.current -= 1;
        const entry = historyRef.current[historyIdxRef.current];
        onChange(entry.code);
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.selectionStart = entry.start;
            textareaRef.current.selectionEnd   = entry.end;
          }
        });
      }
      return;
    }

    // ── Ctrl+Y / Ctrl+Shift+Z → Redo ─────────────────────────────────────────
    if ((e.ctrlKey || e.metaKey) && (key === 'y' || (key === 'z' && e.shiftKey))) {
      e.preventDefault();
      // Commit any pending typed content into history first
      flushPending();
      if (historyIdxRef.current < historyRef.current.length - 1) {
        historyIdxRef.current += 1;
        const entry = historyRef.current[historyIdxRef.current];
        onChange(entry.code);
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.selectionStart = entry.start;
            textareaRef.current.selectionEnd   = entry.end;
          }
        });
      }
      return;
    }

    // ── Ctrl+Enter → Run ─────────────────────────────────────────────────────
    if ((e.ctrlKey || e.metaKey) && key === 'Enter') {
      e.preventDefault();
      if (!isRunning) onRun();
      return;
    }

    // ── Tab → 4 spaces (or un-indent selected block) ─────────────────────────
    if (key === 'Tab') {
      e.preventDefault();
      const INDENT = '    ';

      if (start === end) {
        // No selection — insert 4 spaces
        const next = code.substring(0, start) + INDENT + code.substring(end);
        pushHistory(next, start + 4, start + 4);
        onChange(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 4;
        });
      } else {
        // Selection — indent/un-indent all selected lines
        const lineStart = code.lastIndexOf('\n', start - 1) + 1;
        const lineEnd   = code.indexOf('\n', end - 1);
        const block     = code.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        let   newBlock;
        let   cursorDelta;

        if (e.shiftKey) {
          // Un-indent: remove up to 4 leading spaces per line
          newBlock    = block.replace(/^    /gm, '');
          cursorDelta = -(block.length - newBlock.length);
        } else {
          // Indent: add 4 spaces to every line
          newBlock    = block.replace(/^/gm, INDENT);
          cursorDelta = newBlock.length - block.length;
        }
        const next = code.slice(0, lineStart) + newBlock + code.slice(lineEnd === -1 ? code.length : lineEnd);
        pushHistory(next, lineStart, lineStart + newBlock.length);
        onChange(next);
        requestAnimationFrame(() => {
          ta.selectionStart = lineStart;
          ta.selectionEnd   = lineStart + newBlock.length;
        });
      }
      return;
    }

    // ── Enter — smart indent / bracket expansion ──────────────────────────────
    if (key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      const before = code.substring(0, start);
      const after  = code.substring(end);
      const indent = getLineIndent(code, start);
      const charBefore = before[before.length - 1];
      const charAfter  = after[0];

      // Bracket pair expansion: {| } → {\n    |\n}
      if (charBefore === '{' && charAfter === '}') {
        e.preventDefault();
        const inner = '\n' + indent + '    ';
        const outer = '\n' + indent;
        const next  = before + inner + outer + after;
        const pos   = start + inner.length;
        pushHistory(next, pos, pos);
        onChange(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = pos;
        });
        return;
      }

      // ── Python: auto-indent after colon (:) ─────────────────────────────────
      // Lines ending with ':' (def, if, for, while, else, elif, class, try,
      // except, with, finally) require an extra indent level in Python.
      // Only applies when the current language is Python — C/Java are unaffected.
      if (selectedLanguage === 'python' && charBefore === ':') {
        e.preventDefault();
        const insert = '\n' + indent + '    ';
        const next   = before + insert + after;
        const pos    = start + insert.length;
        pushHistory(next, pos, pos);
        onChange(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = pos;
        });
        return;
      }

      // Normal Enter — preserve current line indentation
      e.preventDefault();
      const insert = '\n' + indent;
      const next   = before + insert + after;
      const pos    = start + insert.length;
      pushHistory(next, pos, pos);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = pos;
      });
      return;
    }

    // ── Backspace — smart pair deletion ──────────────────────────────────────
    if (key === 'Backspace' && start === end) {
      const charBefore = code[start - 1];
      const charAfter  = code[start];
      if (charBefore && OPEN_TO_CLOSE[charBefore] === charAfter) {
        e.preventDefault();
        const next = code.substring(0, start - 1) + code.substring(start + 1);
        const pos  = start - 1;
        pushHistory(next, pos, pos);
        onChange(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = pos;
        });
        return;
      }
      // Delete <> pair on #include lines
      if (charBefore === '<' && charAfter === '>') {
        const ls = code.lastIndexOf('\n', start - 2) + 1;
        if (/^\s*#\s*include\s*$/.test(code.slice(ls, start - 1))) {
          e.preventDefault();
          const next = code.substring(0, start - 1) + code.substring(start + 1);
          const pos  = start - 1;
          pushHistory(next, pos, pos);
          onChange(next);
          requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = pos; });
          return;
        }
      }
    }

    // ── #include< → auto-insert matching > ─────────────────────────────────
    if (key === '<' && start === end) {
      const ls = code.lastIndexOf('\n', start - 1) + 1;
      if (/^\s*#\s*include\s*$/.test(code.slice(ls, start))) {
        e.preventDefault();
        const next = code.substring(0, start) + '<>' + code.substring(start);
        const pos  = start + 1;
        pushHistory(next, pos, pos);
        onChange(next);
        requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = pos; });
        return;
      }
    }

    // ── Skip over > typed inside an #include<…> pair ──────────────────────
    if (key === '>' && start === end && code[start] === '>') {
      const ls = code.lastIndexOf('\n', start - 1) + 1;
      if (code.slice(ls, start).includes('#include')) {
        e.preventDefault();
        requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 1; });
        return;
      }
    }

    // ── Skip over closing bracket/quote ──────────────────────────────────────
    if (CLOSE_CHARS.has(key) && start === end) {
      const charAfter = code[start];
      if (charAfter === key) {
        e.preventDefault();
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 1;
        });
        return;
      }
    }

    // ── Auto-close brackets & quotes ─────────────────────────────────────────
    if (OPEN_CHARS.has(key) && start === end) {
      const close     = OPEN_TO_CLOSE[key];
      const charAfter = code[start];

      // For quotes: don't auto-close if we're already inside a string
      // (simple heuristic: if same quote char is immediately before cursor)
      if ((key === '"' || key === "'") && code[start - 1] === key) {
        return; // let default behavior happen
      }

      // Don't auto-close if next char is alphanumeric (likely typing a word)
      if (charAfter && /\w/.test(charAfter)) return;

      e.preventDefault();
      const next = code.substring(0, start) + key + close + code.substring(end);
      const pos  = start + 1;
      pushHistory(next, pos, pos);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = pos;
      });
      return;
    }

    // ── Home key — go to first non-whitespace char (or column 0 if already there) ──
    if (key === 'Home' && !e.ctrlKey) {
      e.preventDefault();
      const lineStart  = code.lastIndexOf('\n', start - 1) + 1;
      const lineText   = code.slice(lineStart);
      const firstNonWs = lineText.search(/\S/);
      const firstPos   = firstNonWs === -1 ? lineStart : lineStart + firstNonWs;

      // Toggle: if already at first non-ws, go to column 0
      const targetPos  = start === firstPos ? lineStart : firstPos;
      requestAnimationFrame(() => {
        if (e.shiftKey) {
          ta.selectionStart = targetPos;
          ta.selectionEnd   = end;
        } else {
          ta.selectionStart = ta.selectionEnd = targetPos;
        }
      });
      return;
    }
  }, [code, onChange, onRun, isRunning]);

  const lineCount = code.split('\n').length;

  // ── Download active tab as .c file ──────────────────────────────────────────
  const handleDownload = useCallback(() => {
    const filename = tabs.find(t => t.id === activeTabId)?.name || 'main.c';
    const blob = new Blob([code], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [code, tabs, activeTabId]);

  return (
    <div className={styles.panel}>

      {/* ── Tab bar ────────────────────────────────────────────────────── */}
      <div className={styles.tabBar}>
        {/* Scrollable tab list */}
        <div className={styles.tabList}>
          {tabs.map(tab => {
            const isActive  = tab.id === activeTabId;
            const isEditing = editingTabId === tab.id;
            return (
              <div
                key={tab.id}
                className={`${styles.fileTab} ${isActive ? styles.fileTabActive : styles.fileTabInactive}`}
                onClick={() => !isEditing && onTabSwitch?.(tab.id)}
                title={isEditing ? undefined : tab.name}
              >
                <span className={`${styles.fileDot} ${isActive ? '' : styles.fileDotInactive}`} />

                {isEditing ? (
                  <input
                    ref={renameInputRef}
                    className={styles.tabRenameInput}
                    value={editingName}
                    onChange={e => setEditingName(e.target.value)}
                    onBlur={confirmRename}
                    onKeyDown={e => {
                      e.stopPropagation();
                      if (e.key === 'Enter')  confirmRename();
                      if (e.key === 'Escape') cancelRename();
                    }}
                    autoFocus
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className={styles.fileName}
                    onDoubleClick={e => startRename(tab.id, tab.name, e)}
                  >
                    {tab.name}
                  </span>
                )}

                {tabs.length > 1 && (
                  <button
                    className={styles.tabClose}
                    onClick={e => { e.stopPropagation(); onTabClose?.(tab.id); }}
                    title="Close"
                    tabIndex={-1}
                    aria-label={`Close ${tab.name}`}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}

          {/* Add tab dropdown button */}
          <div style={{ alignSelf: 'center', marginLeft: '6px' }}>
            <button
              ref={addBtnRef}
              className={styles.tabAdd}
              onClick={openAddMenu}
              title="New tab or upload file"
              tabIndex={-1}
              aria-label="Add new tab or upload file"
            >
              +
            </button>
          </div>

          {/* Hidden file input for uploads */}
          <input
            ref={fileInputRef}
            type="file"
            accept={getAcceptString()}
            onChange={handleFileChange}
            style={{ display: 'none' }}
            aria-hidden="true"
          />
        </div>

        {/* Dropdown menu rendered OUTSIDE the tabList to avoid overflow clipping */}
        {showAddMenu && (
          <div
            ref={addMenuRef}
            className={styles.addMenu}
            style={{ position: 'fixed', top: menuPos.top, left: menuPos.left }}
          >
            <button
              className={styles.addMenuItem}
              onClick={() => {
                fileInputRef.current?.click();
                setShowAddMenu(false);
              }}
            >
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3 17h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                <path d="M10 13V3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                <path d="M6 7l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Upload File
            </button>
            <button
              className={styles.addMenuItem}
              onClick={() => {
                onTabAdd?.();
                setShowAddMenu(false);
              }}
            >
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M10 8v4M8 10h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              New Tab
            </button>
          </div>
        )}

        {/* Right badge */}
        <div className={styles.tabRight}>
          <span className={styles.langDot} />
          <span className={styles.tabMeta}>
            {selectedLanguage === 'python' ? 'Python' : selectedLanguage === 'java' ? 'Java' : 'C Language'}
          </span>
        </div>
      </div>

      {/* ── Editor body ──────────────────────────────────────────────────── */}
      <div className={styles.editorBody}>

        {/* Line numbers gutter — rendered as a single text block to match
             the textarea's continuous text rendering and prevent sub-pixel
             rounding drift that occurs with individual div elements */}
        <div className={styles.gutter} ref={gutterRef} aria-hidden="true">
          <pre className={styles.lineNumbers}>
            {Array.from({ length: lineCount }, (_, idx) => idx + 1).join('\n')}
          </pre>
        </div>

        {/* Code overlay: pre (highlight layer) + textarea (input layer) */}
        <div className={styles.codeWrapper}>
          {/*
            SECURITY: `highlighted` is the output of highlightC() (src/highlight.js).
            highlightC() HTML-escapes ALL user input via esc() (&, <, >, ", ', /)
            before wrapping tokens in <span> tags with hard-coded class names.
            No raw user or AI-generated content is ever injected as HTML.
          */}
          <pre
            ref={preRef}
            className={styles.highlight}
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(highlighted + '\n') }}
          />
          <textarea
            ref={textareaRef}
            id="code-editor"
            className={styles.textarea}
            value={code}
            onChange={(e) => {
              const newCode = e.target.value;
              const sel     = e.target.selectionStart;
              // Store the latest typed state so flushPending() can commit it
              pendingEntryRef.current = { code: newCode, start: sel, end: sel };
              // Debounce history pushes for regular typing (group within 300 ms)
              clearTimeout(debounceTimer.current);
              debounceTimer.current = setTimeout(() => {
                pushHistory(newCode, sel, sel);
                pendingEntryRef.current = null;
                debounceTimer.current   = null;
              }, 300);
              onChange(newCode);
            }}
            onScroll={syncScroll}
            onKeyDown={handleKeyDown}
            // IME composition tracking — see isComposingRef and handleKeyDown guard
            onCompositionStart={() => { isComposingRef.current = true;  }}
            onCompositionEnd={()   => { isComposingRef.current = false; }}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="C code editor"
          />
        </div>
      </div>

      {/* ── Bottom run bar ────────────────────────────────────────────────── */}
      <div className={styles.runBar}>

        {/* Download button */}
        <button
          id="download-btn"
          className={styles.downloadBtn}
          onClick={handleDownload}
          disabled={isRunning}
          title={`Download ${tabs.find(t => t.id === activeTabId)?.name || 'main.c'}`}
          aria-label="Download source file"
        >
          <svg
            width="14" height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path d="M8 1v9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            <path d="M4 7l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2 14h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
          DOWNLOAD
        </button>

        <button
          id="clear-btn"
          className={styles.clearBtn}
          onClick={onClear}
          disabled={isRunning}
        >
          CLEAR
        </button>

        {/* Show STOP when running, RUN when idle */}
        {runStatus === 'running' ? (
          <button
            id="stop-btn"
            className={`${styles.runBtn} ${styles.stopBtn}`}
            onClick={onKill}
            aria-label="Stop running program"
          >
            <span className={styles.stopIcon}>■</span> STOP
          </button>
        ) : (
          <button
            id="run-btn"
            className={`${styles.runBtn} ${isRunning ? styles.runBtnRunning : ''}`}
            onClick={onRun}
            disabled={isRunning}
            aria-label={isRunning ? 'Compiling…' : 'Run program (Ctrl+Enter)'}
            title="Run (Ctrl+Enter)"
          >
            {runStatus === 'compiling'
              ? <><span className={styles.spinner} aria-hidden="true" /> COMPILING…</>
              : <><span className={styles.runIcon}>&#9654;</span> RUN</>}
          </button>
        )}
      </div>

    </div>
  );
}
