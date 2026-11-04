import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { compilationHistoryStore, MAX_ENTRIES } from '../compilationHistory.js';
import { LANGUAGE_META } from '../constants.js';
import { highlightCode } from '../highlight.js';
import DOMPurify from 'dompurify';
import styles from './CompilationHistoryPanel.module.css';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  });
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Strip ANSI / VT100 escape sequences (fixes garbage like Ø[?9001h in stored output)
function stripAnsi(str) {
  if (!str) return str;
  return str
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '') // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')          // OSC sequences
    .replace(/\x1b[^\[\]]/g, '')                                 // other ESC sequences
    .replace(/\x1b/g, '');                                       // stray ESC chars
}

// Keep output to a sane preview length
const MAX_PREVIEW_CHARS = 600;

// ── C syntax highlighter (regex-based, no lib) ───────────────────────────────

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Use RegExp constructors to avoid oxc/Vite JSX parse issues with complex regex literals
const C_KEYWORDS = new RegExp(
  '\\b(auto|break|case|const|continue|default|do|else|enum|extern|for|goto|if|inline|register|restrict|return|sizeof|static|struct|switch|typedef|union|volatile|while)\\b',
  'g'
);
const C_TYPES = new RegExp(
  '\\b(char|double|float|int|long|short|signed|unsigned|void)\\b',
  'g'
);
const C_PREPROC = new RegExp(
  '(^\\s*#(?:include|define|undef|ifdef|ifndef|endif|elif|pragma|error|warning)[^\\n]*)',
  'gm'
);
// After escapeHtml, double-quotes become &quot; so match that
const C_STRING = new RegExp(
  '(&quot;(?:[^&]|&(?!quot;))*&quot;)',
  'g'
);
const C_NUMBER = new RegExp(
  '\\b(0x[0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+\\-]?\\d+)?[uUlLfF]*)\\b',
  'g'
);
// Block comments (/* */) only — line comments handled separately line-by-line
const C_BLOCK_COMMENT = new RegExp(
  '(/\\*(?:[^*]|\\*(?!/))*\\*/)',
  'g'
);
const C_LINE_COMMENT = new RegExp(
  '(//[^\\n]*)',
  'g'
);
const C_FUNC = new RegExp(
  '\\b([a-zA-Z_][a-zA-Z0-9_]*)(?=\\s*\\()',
  'g'
);

function highlightC(rawLine) {
  let s = escapeHtml(rawLine);
  // 1. Block comments first (rare in a single line but handle it)
  s = s.replace(C_BLOCK_COMMENT, m => `<span class="hl-comment">${m}</span>`);
  // 2. Line comments — everything after // is comment, stop other replacements
  const lcIdx = s.indexOf('//');
  let commentSuffix = '';
  if (lcIdx !== -1) {
    commentSuffix = `<span class="hl-comment">${s.slice(lcIdx)}</span>`;
    s = s.slice(0, lcIdx);
  }
  // 3. Strings
  s = s.replace(C_STRING,   m => `<span class="hl-string">${m}</span>`);
  // 4. Preprocessor directives
  s = s.replace(C_PREPROC,  m => `<span class="hl-preproc">${m}</span>`);
  // 5. Types (before keywords so "unsigned int" both get styled)
  s = s.replace(C_TYPES,    m => `<span class="hl-type">${m}</span>`);
  // 6. Keywords
  s = s.replace(C_KEYWORDS, m => `<span class="hl-keyword">${m}</span>`);
  // 7. Numbers
  s = s.replace(C_NUMBER,   m => `<span class="hl-number">${m}</span>`);
  // 8. Function names
  s = s.replace(C_FUNC,     (_, fn) => `<span class="hl-func">${fn}</span>`);
  return s + commentSuffix;
}

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ entry }) {
  if (entry.killed) {
    return (
      <span className={styles.badgeTLE}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="5.5" stroke="#d97706" strokeWidth="1"/>
          <path d="M6 3v3.5l2 1.5" stroke="#d97706" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Infinite Loop
      </span>
    );
  }
  if (entry.status === 'success') {
    return (
      <span className={styles.badgeSuccess}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="5.5" stroke="#059669" strokeWidth="1"/>
          <path d="M3.5 6l2 2 3-3" stroke="#059669" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Success
      </span>
    );
  }
  return (
    <span className={styles.badgeError}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <circle cx="6" cy="6" r="5.5" stroke="#ef4444" strokeWidth="1"/>
        <path d="M4 4l4 4M8 4l-4 4" stroke="#ef4444" strokeWidth="1.4" strokeLinecap="round"/>
      </svg>
      Error
    </span>
  );
}

// ── Infinite loop output display ──────────────────────────────────────────────

function InfiniteLoopOutput() {
  return (
    <div className={styles.tleOutput}>
      <div className={styles.tleHeader}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="6" stroke="#d97706" strokeWidth="1.3"/>
          <path d="M7 3.5v4l2.5 1.5" stroke="#d97706" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Program ran indefinitely (killed at 30s)
      </div>
      <div className={styles.tleDotsRow}>
        <span className={`${styles.tleDot} ${styles.tleDot1}`} />
        <span className={`${styles.tleDot} ${styles.tleDot2}`} />
        <span className={`${styles.tleDot} ${styles.tleDot3}`} />
      </div>
      <p className={styles.tleTip}>
        Common causes: missing loop increment, off-by-one in condition, or unintentional <code>while(1)</code>
      </p>
    </div>
  );
}

// ── Output display ────────────────────────────────────────────────────────────

function OutputSection({ entry, maximized }) {
  const [showAll, setShowAll] = useState(false);
  const stdout = stripAnsi(entry.stdout ?? entry.output ?? '');

  // Infinite loop — special display
  if (entry.killed) {
    return (
      <div className={styles.outputSection}>
        <div className={styles.outputLabelRow}>
          <span className={styles.outputLabel}>Output</span>
        </div>
        <InfiniteLoopOutput />
      </div>
    );
  }

  // Compile error — show GCC messages
  if (entry.errorType === 'compile-error') {
    const lines = stdout.split('\n').filter(Boolean);
    return (
      <div className={styles.outputSection}>
        <div className={styles.outputLabelRow}>
          <span className={styles.outputLabel}>Compiler Output</span>
          <span className={styles.outputLineCount}>{lines.length} lines</span>
        </div>
        <div className={styles.compileErrorBlock}>
          {lines.slice(0, maximized ? 999 : 12).map((line, i) => {
            let cls = styles.errLineNeutral;
            if (line.includes(': error:'))   cls = styles.errLineError;
            else if (line.includes(': warning:')) cls = styles.errLineWarning;
            else if (line.includes(': note:'))    cls = styles.errLineNote;
            return (
              <div key={i} className={`${styles.errLine} ${cls}`}>
                {line.includes(': error:') && <span className={styles.errPill}>error</span>}
                {line.includes(': warning:') && <span className={styles.warnPill}>warn</span>}
                {line}
              </div>
            );
          })}
          {!maximized && lines.length > 12 && (
            <button className={styles.showMoreBtn} onClick={() => setShowAll(v => !v)}>
              {showAll ? '▲ Show less' : `▼ ${lines.length - 12} more lines`}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Runtime output — stdout
  if (!stdout) {
    return (
      <div className={styles.outputSection}>
        <div className={styles.outputLabelRow}>
          <span className={styles.outputLabel}>Output</span>
        </div>
        <div className={styles.outputEmpty}>No output produced</div>
      </div>
    );
  }

  const isLong = stdout.length > MAX_PREVIEW_CHARS;
  const displayText = (!maximized && isLong && !showAll)
    ? stdout.slice(0, MAX_PREVIEW_CHARS)
    : stdout;

  return (
    <div className={styles.outputSection}>
      <div className={styles.outputLabelRow}>
        <span className={styles.outputLabel}>Output</span>
        {entry.status === 'success' && (
          <span className={styles.outputSuccessTag}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M2 5l2.5 2.5 4-4" stroke="#059669" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            exit 0
          </span>
        )}
        {entry.status === 'error' && entry.exitCode != null && (
          <span className={styles.outputErrorTag}>exit {entry.exitCode}</span>
        )}
      </div>
      <div className={`${styles.stdoutBlock} ${entry.status === 'error' ? styles.stdoutBlockError : ''}`}>
        {displayText.split('\n').map((line, i) => (
          <div key={i} className={styles.stdoutLine}>
            <span className={styles.stdoutText}>{line}</span>
          </div>
        ))}
        {!maximized && isLong && (
          <button className={styles.showMoreBtn} onClick={() => setShowAll(v => !v)}>
            {showAll ? '▲ Collapse' : `▼ Show full output (${stdout.split('\n').length} lines)`}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Maximize modal ────────────────────────────────────────────────────────────

function MaximizeModal({ entry, onClose, onLoadInEditor, onDelete }) {
  const [copied, setCopied] = useState(false);

  // ESC to close
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(entry.code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [entry.code]);

  const codeLines = entry.code.split('\n');

  return (
    <div className={styles.modalOverlay} onClick={onClose} role="dialog" aria-modal="true" aria-label="Compilation detail">
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        {/* Modal header */}
        <div className={styles.modalHeader}>
          <div className={styles.modalTitleRow}>
            <StatusBadge entry={entry} />
            <span className={styles.modalDate}>{formatDate(entry.timestamp)}</span>
            {entry.timeMs != null && (
              <span className={styles.modalTimeBadge}>⏱ {entry.timeMs} ms</span>
            )}
          </div>
          <div className={styles.modalActions}>
            <button className={styles.modalCopyBtn} onClick={handleCopy}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="5" y="5" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
                <path d="M3 11H2a1 1 0 01-1-1V2a1 1 0 011-1h8a1 1 0 011 1v1" stroke="currentColor" strokeWidth="1.4"/>
              </svg>
              {copied ? 'Copied!' : 'Copy Code'}
            </button>
            <button className={styles.modalLoadBtn} onClick={() => { onLoadInEditor(entry.code); onClose(); }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 2h5v2H4v8h8v-3h2v5H2V2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                <path d="M9 2h5v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M14 2L8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
              Load in Editor
            </button>
            <button
              className={styles.modalDeleteBtn}
              onClick={() => { onDelete(entry.id); onClose(); }}
              title="Delete this entry"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9h8l1-9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button className={styles.modalCloseBtn} onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        {/* Modal body: split — code left, output right */}
        <div className={styles.modalBody}>
          {/* Code pane */}
          <div className={styles.modalCodePane}>
            <div className={styles.modalPaneHeader}>
              <span className={styles.modalPaneTitle}>
                {entry.filename ? `Source Code (${entry.filename})` : 'Source Code'}
              </span>
              <span className={styles.modalLineCount}>{codeLines.length} lines</span>
            </div>
            <div className={styles.modalCodeScroll}>
              <div className={styles.modalCodeGutter}>
                {codeLines.map((_, i) => (
                  <div key={i} className={styles.modalGutterNum}>{i + 1}</div>
                ))}
              </div>
              <pre className={styles.modalCodePre}>{entry.code}</pre>
            </div>
          </div>

          {/* Divider */}
          <div className={styles.modalDivider} />

          {/* Output pane */}
          <div className={styles.modalOutputPane}>
            <div className={styles.modalPaneHeader}>
              <span className={styles.modalPaneTitle}>
                {entry.errorType === 'compile-error' ? 'Compiler Output' : 'Program Output'}
              </span>
            </div>
            <div className={styles.modalOutputScroll}>
              <OutputSection entry={entry} maximized={true} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Kebab menu ────────────────────────────────────────────────────────────────

function KebabMenu({ entryId, code, onDelete, onMaximize }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    setOpen(false);
  }, [code]);

  const handleDelete = useCallback(() => {
    onDelete(entryId);
    setOpen(false);
  }, [onDelete, entryId]);

  useEffect(() => {
    if (!open) return;
    const h = () => setOpen(false);
    window.addEventListener('click', h);
    return () => window.removeEventListener('click', h);
  }, [open]);

  return (
    <div className={styles.menuWrapper}>
      <button
        className={styles.kebabBtn}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        aria-label="More options"
        title="More options"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="3" r="1.2" fill="currentColor"/>
          <circle cx="8" cy="8" r="1.2" fill="currentColor"/>
          <circle cx="8" cy="13" r="1.2" fill="currentColor"/>
        </svg>
      </button>
      {open && (
        <div className={styles.menuDropdown} onClick={e => e.stopPropagation()}>
          <button className={styles.menuItem} onClick={() => { onMaximize(); setOpen(false); }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M1.5 8.5v5a1 1 0 001 1h5M14.5 7.5v-5a1 1 0 00-1-1h-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M10 6l4.5-4.5M14 5V1h-4M6 10l-4.5 4.5M2 11v4h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            View Details
          </button>
          <div className={styles.menuDivider} />
          <button className={styles.menuItem} onClick={handleCopy}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="5" y="5" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M3 11H2a1 1 0 01-1-1V2a1 1 0 011-1h8a1 1 0 011 1v1" stroke="currentColor" strokeWidth="1.4"/>
            </svg>
            {copied ? 'Copied!' : 'Copy Code'}
          </button>
          <div className={styles.menuDivider} />
          <button className={`${styles.menuItem} ${styles.menuItemDanger}`} onClick={handleDelete}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9h8l1-9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Delete
          </button>
        </div>
      )}

    </div>
  );
}

// ── Single History Card ───────────────────────────────────────────────────────

function HistoryCard({ entry, onLoadInEditor, onDelete }) {
  const [maximized, setMaximized] = useState(false);

  const borderClass = entry.killed
    ? styles.cardTLE
    : entry.status === 'success'
    ? styles.cardSuccess
    : styles.cardError;

  return (
    <>
      <div className={`${styles.card} ${borderClass}`}>
        {/* ── Card header ──────────────────────────────────── */}
        <div className={styles.cardHeader}>
          <StatusBadge entry={entry} />

          <div className={styles.cardHeaderRight}>
            {/* Date */}
            <span className={styles.cardDate}>
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <rect x="1" y="2" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.1"/>
                <path d="M4 1v2M8 1v2M1 5h10" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
              </svg>
              {formatDate(entry.timestamp)}
            </span>

            {/* Expand details button */}
            <button
              className={styles.expandBtn}
              onClick={() => setMaximized(true)}
              title="Expand Details"
              aria-label="Expand Details"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M1.5 8.5v5a1 1 0 001 1h5M14.5 7.5v-5a1 1 0 00-1-1h-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M10 6l4.5-4.5M14 5V1h-4M6 10l-4.5 4.5M2 11v4h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            {/* Kebab */}
            <KebabMenu
              entryId={entry.id}
              code={entry.code}
              onDelete={onDelete}
              onMaximize={() => setMaximized(true)}
            />
          </div>
        </div>

        {/* ── Code block — macOS editor style ─────────────── */}
        <div className={styles.codeBlock}>
          {/* Title bar */}
          <div className={styles.codeEditorBar}>
            <span className={`${styles.trafficDot} ${styles.trafficRed}`}/>
            <span className={`${styles.trafficDot} ${styles.trafficYellow}`}/>
            <span className={`${styles.trafficDot} ${styles.trafficGreen}`}/>
            <span className={styles.codeEditorFilename}>
              {entry.filename || (LANGUAGE_META[entry.language]?.defaultFile || (entry.language === 'java' ? 'Main.java' : entry.language === 'python' ? 'main.py' : 'main.c'))}
            </span>
          </div>
          {/* Code with line numbers */}
          <div className={styles.codeScrollArea}>
            <table className={styles.codeTable}>
              <tbody>
                {entry.code.split('\n').map((line, i) => (
                  <tr key={i} className={styles.codeLine}>
                    <td className={styles.codeLineNum}>{i + 1}</td>
                    <td
                      className={styles.codeLineContent}
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(highlightCode(line, entry.language) || '\u00a0') }}
                    />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Load in Editor button ────────────────────────── */}
        <div className={styles.loadBtnRow}>
          <button
            className={styles.loadBtn}
            onClick={() => onLoadInEditor(entry.code)}
            title="Load this code into the editor"
          >
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M3 3h6v2H5v10h10v-4h2v6H3V3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
              <path d="M11 3h6v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M17 3L10 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
            Load in Editor
          </button>
        </div>


        {/* ── Output section ───────────────────────────────── */}
        <OutputSection entry={entry} maximized={false} />

        {/* ── Footer ──────────────────────────────────────── */}
        <div className={styles.cardFooter}>
          <div className={styles.footerChips}>
            {entry.timeMs != null && (
              <span className={styles.chip}>⏱ {entry.timeMs} ms</span>
            )}
            {entry.exitCode != null && !entry.killed && (
              <span className={`${styles.chip} ${entry.exitCode === 0 ? styles.chipGreen : styles.chipRed}`}>
                exit {entry.exitCode}
              </span>
            )}
            {entry.errorType === 'compile-error' && (
              <span className={styles.chipOrange}>⚙ Compile Error</span>
            )}
            {entry.killed && (
              <span className={styles.chipAmber}>⏱ Time Limit</span>
            )}
          </div>
          <span className={styles.timeAgo}>{timeAgo(entry.timestamp)}</span>
        </div>
      </div>

      {/* ── Maximize modal ──────────────────────────────── */}
      {maximized && (
        <MaximizeModal
          entry={entry}
          onClose={() => setMaximized(false)}
          onLoadInEditor={onLoadInEditor}
          onDelete={onDelete}
        />
      )}
    </>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export default function CompilationHistoryPanel({ onClose, onLoadInEditor, selectedLanguage = 'c' }) {
  const [entries, setEntries]       = useState(() => compilationHistoryStore.getAll(selectedLanguage));
  const [closing, setClosing]       = useState(false);
  const [search, setSearch]         = useState('');
  const [filter, setFilter]         = useState('all');
  const [sort,   setSort]           = useState('newest');
  const [confirmClear, setConfirmClear] = useState(false);
  const confirmTimerRef = useRef(null);

  // Sync entries when selectedLanguage changes
  useEffect(() => {
    setEntries(compilationHistoryStore.getAll(selectedLanguage));
  }, [selectedLanguage]);

  useEffect(() => {
    const unsub = compilationHistoryStore.subscribe(() => {
      setEntries(compilationHistoryStore.getAll(selectedLanguage));
    });
    return unsub;
  }, [selectedLanguage]);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 270);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose]);

  const handleDelete = useCallback((id) => {
    compilationHistoryStore.delete(id, selectedLanguage);
  }, [selectedLanguage]);

  const handleClearAll = useCallback(() => {
    if (!confirmClear) {
      setConfirmClear(true);
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    compilationHistoryStore.clearAll(selectedLanguage);
    setConfirmClear(false);
  }, [confirmClear, selectedLanguage]);

  const handleLoadInEditor = useCallback((code) => {
    onLoadInEditor?.(code);
    handleClose();
  }, [onLoadInEditor, handleClose]);

  const filtered = useMemo(() => {
    let res = entries;
    if (filter === 'success') res = res.filter(e => e.status === 'success' && !e.killed);
    else if (filter === 'error') res = res.filter(e => e.status === 'error' || e.killed);
    if (search.trim()) {
      const q = search.toLowerCase();
      res = res.filter(e =>
        e.code.toLowerCase().includes(q) ||
        (e.stdout ?? e.output ?? '').toLowerCase().includes(q)
      );
    }
    if (sort === 'oldest') res = [...res].reverse();
    return res;
  }, [entries, filter, search, sort]);

  const successCount = entries.filter(e => e.status === 'success' && !e.killed).length;
  const errorCount   = entries.filter(e => e.status === 'error' || e.killed).length;

  return (
    <>
      <div className={styles.backdrop} onClick={handleClose} aria-hidden="true" />

      <aside
        className={`${styles.panel} ${closing ? styles.panelClosing : ''}`}
        role="dialog"
        aria-label="Compilation History"
        aria-modal="true"
      >
        {/* ── Header ─────────────────────────────────────── */}
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>
            <div className={styles.panelTitleIcon}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                <circle cx="10" cy="10" r="8.5" stroke="#10b981" strokeWidth="1.5"/>
                <path d="M10 5.5v5l3 2" stroke="#10b981" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="10" cy="10" r="1.2" fill="#10b981"/>
              </svg>
            </div>
            History
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#10b981', marginLeft: 6 }}>
              {LANGUAGE_META[selectedLanguage]?.label || selectedLanguage.toUpperCase()}
            </span>
          </div>
          <div className={styles.headerActions}>
            {entries.length > 0 && (
              <button
                className={`${styles.clearBtn} ${confirmClear ? styles.clearBtnConfirm : ''}`}
                onClick={handleClearAll}
                onBlur={() => { clearTimeout(confirmTimerRef.current); setConfirmClear(false); }}
                id="history-clear-btn"
              >
                {confirmClear ? '⚠ Confirm?' : 'Clear All'}
              </button>
            )}
            <button
              className={styles.closeBtn}
              onClick={handleClose}
              aria-label="Close"
              id="history-close-btn"
            >×</button>
          </div>
        </div>

        {/* ── Search + Filter + Sort ───────────────────────── */}
        <div className={styles.searchBar}>
          <div className={styles.searchInputWrapper}>
            <svg className={styles.searchIcon} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              className={styles.searchInput}
              type="text"
              placeholder="Search code or output..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search compilations"
            />
            {search && (
              <button className={styles.searchClear} onClick={() => setSearch('')} aria-label="Clear search">×</button>
            )}
          </div>

          <div className={styles.filterRow}>
            {[
              { key: 'all',     label: `All (${entries.length})` },
              { key: 'success', label: `✓ ${successCount}` },
              { key: 'error',   label: `✕ ${errorCount}` },
            ].map(f => (
              <button
                key={f.key}
                className={`${styles.filterPill} ${filter === f.key ? styles.filterPillActive : ''} ${f.key === 'success' ? styles.filterPillSuccess : f.key === 'error' ? styles.filterPillError : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
            <div className={styles.filterSpacer}/>
            {/* Sort dropdown */}
            <select
              className={styles.sortSelect}
              value={sort}
              onChange={e => setSort(e.target.value)}
              aria-label="Sort order"
            >
              <option value="newest">↓ Newest</option>
              <option value="oldest">↑ Oldest</option>
            </select>
          </div>
        </div>

        {/* ── Body ───────────────────────────────────────── */}
        <div className={styles.panelBody}>
          {entries.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
                  <circle cx="26" cy="26" r="22" fill="#f0fdf4" stroke="#a7f3d0" strokeWidth="1.5"/>
                  <circle cx="26" cy="26" r="16" fill="none" stroke="#10b981" strokeWidth="1.4"/>
                  <path d="M26 14v13l6 4" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <circle cx="26" cy="26" r="2" fill="#10b981"/>
                </svg>
              </div>
              <p className={styles.emptyTitle}>
                No {LANGUAGE_META[selectedLanguage]?.label || selectedLanguage} compilations yet
              </p>
              <p className={styles.emptySub}>
                Write your first {LANGUAGE_META[selectedLanguage]?.label || selectedLanguage} program and click ▶ Run.<br/>
                Each run will appear here.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className={styles.emptyState}>
              <p className={styles.emptyTitle}>No results</p>
              <p className={styles.emptySub}>Try a different search or filter.</p>
            </div>
          ) : (
            <div className={styles.cardList}>
              {filtered.map(entry => (
                <HistoryCard
                  key={entry.id}
                  entry={entry}
                  onLoadInEditor={handleLoadInEditor}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────── */}
        {entries.length > 0 && (
        <div className={styles.panelFooter}>
            <span className={styles.footerDot} style={{ background: '#10b981' }} />
            <span className={styles.footerText}>{successCount} passed</span>
            <span className={styles.footerSep}>·</span>
            <span className={styles.footerDot} style={{ background: '#ef4444' }} />
            <span className={styles.footerText}>{errorCount} failed</span>
            <span className={styles.footerSep}>·</span>
            <span className={styles.footerText}>{entries.length} / {MAX_ENTRIES} stored</span>
            {entries.length >= MAX_ENTRIES && (
              <>
                <span className={styles.footerSep}>·</span>
                <span className={styles.footerText} title="Older runs will be archived to PostgreSQL once the database is integrated" style={{ color: '#f59e0b', fontSize: '0.7rem' }}>
                  ⚠ Limit reached — older runs go to DB
                </span>
              </>
            )}
          </div>
        )}
      </aside>
    </>
  );
}