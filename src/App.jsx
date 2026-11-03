import { useState, useRef, useCallback, useEffect, lazy, Suspense } from 'react';
import { Code2, TerminalSquare, Bug, Clock, BarChart2, BookOpen } from 'lucide-react';
import Header from './components/Header.jsx';
import EditorPanel from './components/EditorPanel.jsx';
import DragDivider from './components/DragDivider.jsx';
import RightPanel from './components/RightPanel.jsx';
import LanguageDetectorPopup from './components/LanguageDetectorPopup.jsx';
import BugTrackerPanel from './components/BugTrackerPanel.jsx';
import CompilationHistoryPanel from './components/CompilationHistoryPanel.jsx';
import AnalyticsPanel from './components/AnalyticsPanel.jsx';
// Tutor panels are loaded lazily — they embed large curriculum datasets (tutorData.js etc.)
// and are only needed when the user explicitly opens the AI Tutor panel.
const AiTutorPanel     = lazy(() => import('./components/AiTutorPanel.jsx'));
const PythonTutorPanel = lazy(() => import('./components/PythonTutorPanel.jsx'));
const JavaTutorPanel   = lazy(() => import('./components/JavaTutorPanel.jsx'));
import { TutorErrorBoundary } from './components/TutorErrorBoundary.jsx';
import AdminDashboard from './components/AdminDashboard.jsx';
import LeaderboardPanel from './components/LeaderboardPanel.jsx';
import { bugTrackerStore } from './bugTracker.js';
import { compilationHistoryStore } from './compilationHistory.js';
import {
  STARTER_CODE,
  STARTER_CODE_C,
  STARTER_CODE_PYTHON,
  STARTER_CODE_JAVA,
  LANG_TO_C_PROMPT,
  CONVERT_CODE_PROMPT,
  LANGUAGE_META
} from './constants.js';
import { detectLanguage } from './languageDetector.js';
import { callClaude, parseJSON } from './api.js';
import { readUploadedFile } from './fileUploader.js';
import { useAuth } from './useAuth.js';
import { analyticsStore } from './analytics.js';
import { sanitizeAiCode } from './aiCodeUtils.js';
import { supabase } from './supabaseClient.js';
import styles from './App.module.css';

// ── useIsMobile hook ─────────────────────────────────────────────────────────
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isMobile;
}


// ISSUE 7 FIX: Build the WebSocket URL using a short-lived ticket, NOT the raw JWT.
// Flow:
//   1. Exchange the Supabase JWT for a 30s ticket via POST /api/ws-ticket
//   2. Connect to WS using ?ticket=<uuid> — JWT never appears in URL or access logs
async function buildWsUrl() {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token || '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base  = `${proto}//${window.location.host}/ws/run`;

  try {
    // Exchange JWT for a 30-second single-use ticket
    const resp = await fetch('/api/ws-ticket', {
      method: 'POST',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
    if (resp.ok) {
      const { ticket } = await resp.json();
      return `${base}?ticket=${encodeURIComponent(ticket)}`;
    }
  } catch (err) {
    console.warn('[buildWsUrl] Could not get WS ticket:', err.message);
  }

  // Local development fallback
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return `${base}?ticket=dev-local`;
  }

  return `${base}?ticket=invalid`;
}

// Minimum confidence (0-100) required before we show the popup
const DETECT_CONFIDENCE_THRESHOLD = 28;

const DEFAULT_WORKSPACE_TABS = {
  c:      [{ id: 1, name: 'main.c', code: STARTER_CODE_C }],
  python: [{ id: 101, name: 'main.py', code: STARTER_CODE_PYTHON }],
  java:   [{ id: 201, name: 'Main.java', code: STARTER_CODE_JAVA }],
};

function getInitialWorkspaceTabs() {
  // Clear any previously persisted tabs so every refresh resets to default starter code
  try {
    localStorage.removeItem('sc_workspace_tabs');
    localStorage.removeItem('sc_active_tab_ids');
  } catch {}
  return {
    c:      [{ id: 1, name: 'main.c', code: STARTER_CODE_C }],
    python: [{ id: 101, name: 'main.py', code: STARTER_CODE_PYTHON }],
    java:   [{ id: 201, name: 'Main.java', code: STARTER_CODE_JAVA }],
  };
}

function getInitialActiveTabIds() {
  return { c: 1, python: 101, java: 201 };
}




export default function App() {
  const { user, loading, signInWithGoogle, signOut } = useAuth();

  // Redirect to login if user is not authenticated and loading is complete
  useEffect(() => {
    if (!loading && !user) {
      window.location.href = '/login.html';
    }
  }, [user, loading]);

  // Initialize analytics store with the logged-in user
  useEffect(() => {
    analyticsStore.init(user);
    bugTrackerStore.init(user);
  }, [user]);

  // Track time spent on the website when user is logged in (5-second heartbeats)
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      analyticsStore.addTimeSpent(5);
    }, 5000);

    return () => {
      clearInterval(interval);
      analyticsStore.syncTimeSpent();
    };
  }, [user]);



  // ── History panel state ──────────────────────────────────────────────────
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [historyCount, setHistoryCount] = useState(
    () => compilationHistoryStore.getAll().length
  );

  useEffect(() => {
    const unsub = compilationHistoryStore.subscribe((entries) => {
      setHistoryCount(entries.length);
    });
    return unsub;
  }, []);

  const handleHistoryToggle = useCallback(() => {
    setHistoryPanelOpen(prev => !prev);
  }, []);

  // ── Analytics state ──────────────────────────────────────────────────────
  const [analyticsPanelOpen, setAnalyticsPanelOpen] = useState(false);
  const handleAnalyticsToggle = useCallback(() => {
    setAnalyticsPanelOpen(prev => !prev);
  }, []);

  // ── Bug Tracker state ────────────────────────────────────────────────────
  const [bugPanelOpen, setBugPanelOpen] = useState(false);
  const [bugErrorCount, setBugErrorCount] = useState(
    () => bugTrackerStore.getStats().errors
  );

  // ── AI Tutor state ───────────────────────────────────────────────────────
  const [aiTutorOpen, setAiTutorOpen] = useState(false);
  const handleAiTutorToggle = useCallback(() => {
    setAiTutorOpen(prev => !prev);
  }, []);

  // ── Admin Dashboard state ──────────────────────────────────────
  const [adminDashboardOpen, setAdminDashboardOpen] = useState(false);
  const handleAdminToggle = useCallback(() => {
    setAdminDashboardOpen(prev => !prev);
  }, []);

  // ── Leaderboard state ──────────────────────────────────────────
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const handleLeaderboardToggle = useCallback(() => {
    setLeaderboardOpen(prev => !prev);
  }, []);

  // ── Mobile Account sheet ─────────────────────────────────────────
  const [mobileAccountSheetOpen, setMobileAccountSheetOpen] = useState(false);
  const onMobileAccountClick = useCallback(() => {
    setMobileAccountSheetOpen(true);
  }, []);

  // ── Is-admin check (server-side, no emails in frontend bundle) ──────────
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!user) { setIsAdmin(false); return; }
    supabase.auth.getSession().then(({ data: { session } }) => {
      const token = session?.access_token;
      if (!token) return;
      fetch('/api/admin/is-admin', {
        headers: { 'Authorization': `Bearer ${token}` },
      })
        .then(r => r.ok ? r.json() : { isAdmin: false })
        .then(data => setIsAdmin(!!data.isAdmin))
        .catch(() => setIsAdmin(false));
    });
  }, [user]);

  // Listen for bugtracker:record events dispatched by TerminalPane
  useEffect(() => {
    const onRecord = (e) => {
      bugTrackerStore.record(e.detail);
      setBugErrorCount(bugTrackerStore.getStats().errors);
    };
    window.addEventListener('bugtracker:record', onRecord);
    return () => window.removeEventListener('bugtracker:record', onRecord);
  }, []);

  // Keep badge count in sync when store is reset externally
  useEffect(() => {
    const unsub = bugTrackerStore.subscribe((stats) => {
      setBugErrorCount(stats.errors);
    });
    return unsub;
  }, []);

  const handleBugTrackerToggle = useCallback(() => {
    setBugPanelOpen(prev => !prev);
  }, []);

  // ── Selected Language state (C / Python / Java) ──────────────────────────
  const [selectedLanguage, setSelectedLanguage] = useState(() => {
    try {
      return localStorage.getItem('sc_active_language') || 'c';
    } catch {
      return 'c';
    }
  });

  // ── Multi-tab state (isolated per language) ───────────────────────────────
  const [workspaceTabs, setWorkspaceTabs] = useState(getInitialWorkspaceTabs);
  const [activeTabIds, setActiveTabIds] = useState(getInitialActiveTabIds);
  const [isUploading, setIsUploading] = useState(false);


  useEffect(() => {
    try {
      localStorage.setItem('sc_active_language', selectedLanguage);
    } catch {}
    bugTrackerStore.setActiveLanguage(selectedLanguage);
    compilationHistoryStore.setActiveLanguage(selectedLanguage);
    analyticsStore.setActiveLanguage(selectedLanguage);
    setHistoryCount(compilationHistoryStore.getAll(selectedLanguage).length);
    setBugErrorCount(bugTrackerStore.getStats(selectedLanguage).errors);
  }, [selectedLanguage]);

  // Derived: current language's tabs and active tab
  const tabs = workspaceTabs[selectedLanguage] || DEFAULT_WORKSPACE_TABS[selectedLanguage] || DEFAULT_WORKSPACE_TABS.c;
  const activeTabId = activeTabIds[selectedLanguage] ?? tabs[0]?.id ?? 1;

  const activeProgramTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];
  const code = activeProgramTab?.code ?? '';

  const setCode = useCallback((newCode) => {
    setWorkspaceTabs(prev => ({
      ...prev,
      [selectedLanguage]: (prev[selectedLanguage] || []).map(t =>
        t.id === activeTabId ? { ...t, code: newCode } : t
      ),
    }));
  }, [selectedLanguage, activeTabId]);

  const handleLanguageChange = useCallback((newLang) => {
    if (newLang === selectedLanguage) return;
    setSelectedLanguage(newLang);
    bugTrackerStore.setActiveLanguage(newLang);
    compilationHistoryStore.setActiveLanguage(newLang);
    analyticsStore.setActiveLanguage(newLang);
    dismissedCodeRef.current = null;
    setShowLangPopup(false);
  }, [selectedLanguage]);

  // Load code from history into the active editor tab (defined after setCode)
  const handleLoadFromHistory = useCallback((historyCode) => {
    setCode(historyCode);
  }, [setCode]);
  const [runStatus, setRunStatus] = useState('idle'); // 'idle' | 'compiling' | 'running'
  const [activeTab, setActiveTab] = useState('terminal');

  // ── Mobile state ─────────────────────────────────────────────────────────
  const isMobile = useIsMobile();

  // Sync the --app-height CSS custom property with the visual viewport.
  // This is the reliable cross-platform way to shrink the app shell when
  // the virtual keyboard opens:
  //   • 100dvh  — shrinks on iOS Safari but NOT on Android Chrome
  //   • visualViewport.height — shrinks on BOTH iOS Safari and Android Chrome
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
    };
    vv.addEventListener('resize', update);
    update(); // set immediately
    return () => vv.removeEventListener('resize', update);
  }, []);

  // 'editor' | 'console' | 'ai'
  const [mobilePanelTab, setMobilePanelTab] = useState('editor');

  // When Run is pressed on mobile, auto-switch to console
  const handleMobileRunAndSwitch = useCallback(() => {
    if (isMobile) setMobilePanelTab('console');
    handleRun();
  }, [isMobile]);

  // Panel width: left panel percent of total workspace width
  const [leftWidth, setLeftWidth] = useState(55);
  const containerRef = useRef(null);
  const draggingRef  = useRef(false);

  // Ref to the TerminalPane's imperative API
  const terminalRef = useRef(null);

  // ── Language detector state ──────────────────────────────────────────────
  const [langDetect, setLangDetect] = useState(null);
  // { language, confidence, signals, scores }
  const [showLangPopup, setShowLangPopup] = useState(false);
  const [converting, setConverting]       = useState(false);
  // Brief success toast shown after a successful conversion
  const [conversionToast, setConversionToast] = useState(null);
  // Stores the exact code the user dismissed detection for ("Keep as C")
  const dismissedCodeRef = useRef(null);

  // ── Tab management ───────────────────────────────────────────────────────────
  const handleTabAdd = useCallback(() => {
    const id = Date.now();
    const meta = LANGUAGE_META[selectedLanguage] || LANGUAGE_META.c;
    const baseName = selectedLanguage === 'java' ? 'Program' : 'program';
    setWorkspaceTabs(prev => {
      const curTabs = prev[selectedLanguage] || [];
      const num = curTabs.length + 1;
      return {
        ...prev,
        [selectedLanguage]: [...curTabs, { id, name: `${baseName}${num}${meta.ext}`, code: '' }],
      };
    });
    setActiveTabIds(prev => ({ ...prev, [selectedLanguage]: id }));
    dismissedCodeRef.current = null;
    setShowLangPopup(false);
  }, [selectedLanguage]);

  const handleTabClose = useCallback((closingId) => {
    setWorkspaceTabs(prev => {
      const curTabs = prev[selectedLanguage] || [];
      if (curTabs.length <= 1) return prev; // never close the last tab
      const closingIdx = curTabs.findIndex(t => t.id === closingId);
      const nextTabs   = curTabs.filter(t => t.id !== closingId);
      if (activeTabId === closingId) {
        const newActive = nextTabs[Math.min(closingIdx, nextTabs.length - 1)];
        setActiveTabIds(prevIds => ({ ...prevIds, [selectedLanguage]: newActive.id }));
        dismissedCodeRef.current = null;
        setShowLangPopup(false);
      }
      return { ...prev, [selectedLanguage]: nextTabs };
    });
  }, [selectedLanguage, activeTabId]);

  const handleTabSwitch = useCallback((id) => {
    if (id === activeTabId) return;
    setActiveTabIds(prev => ({ ...prev, [selectedLanguage]: id }));
    dismissedCodeRef.current = null;
    setShowLangPopup(false);
  }, [selectedLanguage, activeTabId]);

  const handleTabRename = useCallback((id, name) => {
    setWorkspaceTabs(prev => ({
      ...prev,
      [selectedLanguage]: (prev[selectedLanguage] || []).map(t =>
        t.id === id ? { ...t, name: name.trim() || t.name } : t
      ),
    }));
  }, [selectedLanguage]);

  // ── File upload handler ─────────────────────────────────────────────────────
  const handleFileUpload = useCallback(async (file) => {
    setIsUploading(true);
    try {
      const { content, filename } = await readUploadedFile(file);
      const id = Date.now();
      setWorkspaceTabs(prev => ({
        ...prev,
        [selectedLanguage]: [...(prev[selectedLanguage] || []), { id, name: filename, code: content }],
      }));
      setActiveTabIds(prev => ({ ...prev, [selectedLanguage]: id }));
      dismissedCodeRef.current = null;
      setShowLangPopup(false);
    } catch (err) {
      alert(err.message || 'Failed to read the file.');
    } finally {
      setIsUploading(false);
    }
  }, [selectedLanguage]);

  // Vertical drag divider
  const onDividerMouseDown = useCallback((e) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor    = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct  = ((ev.clientX - rect.left) / rect.width) * 100;
      setLeftWidth(Math.max(25, Math.min(75, pct)));
    };

    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor    = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // Language detection runs only on Run click (see handleRun below)

  // ── Dismiss popup ─────────────────────────────────────────────────────────
  const handleDismissPopup = useCallback(() => {
    setShowLangPopup(false);
    // Remember the exact code that was dismissed — skip popup on next Run
    dismissedCodeRef.current = code;
  }, [code]);

  // ── Convert to C via AI ───────────────────────────────────────────────────
  // ── Convert code via AI ───────────────────────────────────────────────────
  const handleConvertToC = useCallback(async () => {
    if (!langDetect) return;
    const stats = analyticsStore.getStats(selectedLanguage);
    if (analyticsStore.isLimitReached()) {
      alert(`You have used ${stats.ai_tokens_used}/${stats.token_limit} tokens according to your limit for AI analysis.`);
      setShowLangPopup(false);
      return;
    }
    setConverting(true);
    try {
      const targetLangName = LANGUAGE_META[selectedLanguage]?.label || 'C';
      const prompt = selectedLanguage === 'c'
        ? LANG_TO_C_PROMPT
        : CONVERT_CODE_PROMPT(langDetect.language, targetLangName);
      const userMessage = `The following is ${langDetect.language} code. Please translate it to ${targetLangName}:\n\n${code}`;
      const raw = await callClaude(prompt, userMessage);
      console.log('RAW AI RESPONSE:', raw);
      const parsed = parseJSON(raw);
      console.log('PARSED JSON:', parsed);
      const converted = parsed?.converted_code || parsed?.c_code || parsed?.code;
      if (converted) {
        // sanitizeAiCode strips markdown fences and fixes double-escaped
        // structural newlines while preserving string escapes.
        const cleanCode = sanitizeAiCode(converted);
        // 1. Load converted code into the editor and close the popup.
        setCode(cleanCode);
        setShowLangPopup(false);
        dismissedCodeRef.current = cleanCode; // mark so next Run skips popup
        // 2. The editor is always on the left — show a success toast so the
        //    user knows the code has been loaded and they can click Run.
        setConversionToast(`✓ Converted to ${targetLangName}! Click Run ▶ to execute.`);
        setTimeout(() => setConversionToast(null), 5000);
      } else {
        // AI responded but returned no code field — show useful error
        const preview = raw ? raw.slice(0, 200) : '(empty response)';
        alert(`Conversion failed: The AI did not return valid ${targetLangName} code.\n\nAI response preview:\n${preview}`);
        setShowLangPopup(false);
      }
    } catch (err) {
      console.error('[LangDetect] Conversion failed:', err);
      if (err.message.includes('Limit Reached') || err.message.includes('limit reached') || analyticsStore.isLimitReached()) {
        const stats = analyticsStore.getStats(selectedLanguage);
        alert(`You have used ${stats.ai_tokens_used}/${stats.token_limit} tokens according to your limit for AI analysis.`);
      } else {
        alert(`Failed to convert code: ${err.message || 'Unknown error'}`);
      }
      // Don't crash the app — just close the popup
      setShowLangPopup(false);
    } finally {
      setConverting(false);
    }
  }, [code, langDetect, selectedLanguage, setCode]);

  // ── Run — connect WebSocket and send code for interactive execution ─────
  const handleRun = useCallback(() => {
    if (!code.trim()) {
      terminalRef.current?.clear();
      return;
    }
    if (runStatus === 'compiling' || runStatus === 'running') return;

    // ── Detect language immediately on Run (no debounce) ──────────────────
    // Skip if user already dismissed for this exact code
    if (dismissedCodeRef.current === code) {
      setActiveTab('terminal');
      setMobilePanelTab('console');
      buildWsUrl().then(wsUrl => terminalRef.current?.connect(wsUrl, code, selectedLanguage));
      analyticsStore.recordRun(selectedLanguage);
      return;
    }

    const result = detectLanguage(code);
    // Only show popup if detected language differs from currently selected language
    if (
      result.language !== selectedLanguage &&
      result.language !== 'unknown' &&
      result.confidence >= DETECT_CONFIDENCE_THRESHOLD
    ) {
      setLangDetect(result);
      setShowLangPopup(true);
      return;
    }

    // Switch to terminal tab
    setActiveTab('terminal');
    // On mobile, also switch the visible panel to console
    setMobilePanelTab('console');

    // Build WS URL with JWT token, then connect
    buildWsUrl().then(wsUrl => {
      terminalRef.current?.connect(wsUrl, code, selectedLanguage);
    });
    analyticsStore.recordRun(selectedLanguage);
  }, [code, runStatus, selectedLanguage]);

  // ── Kill running program ──────────────────────────────────────────────────
  const handleKill = useCallback(() => {
    terminalRef.current?.kill();
    setRunStatus('idle');
  }, []);

  // ── Clear editor ──────────────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    if (window.confirm('Clear the editor? This cannot be undone.')) {
      setCode('');
      terminalRef.current?.clear();
      setShowLangPopup(false);
    }
  }, [setCode]);

  // ── Apply AI fix ──────────────────────────────────────────────────────────
  const handleApplyFix = useCallback((newCode) => {
    setCode(newCode);
  }, [setCode]);

  // ── Status callbacks from TerminalPane ───────────────────────────────────
  const handleStatusChange = useCallback((status) => {
    setRunStatus(status);
  }, []);

  const handleDone = useCallback((_result) => {
    setRunStatus('idle');
  }, []);

  const isRunning = runStatus === 'compiling' || runStatus === 'running';

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: '#0d1117',
        color: '#c9d1d9',
        fontFamily: "'Inter', sans-serif"
      }}>
        <div style={{
          width: '40px',
          height: '40px',
          border: '3px solid #161b22',
          borderTop: '3px solid #0fa57c',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite'
        }}></div>
        <style>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}</style>
        <div style={{ marginTop: '16px', fontSize: '14px', color: '#8b949e' }}>Verifying session...</div>
      </div>
    );
  }

  return (
    <div className={styles.appShell}>
      <Header
        selectedLanguage={selectedLanguage}
        onLanguageChange={handleLanguageChange}
        onBugTrackerToggle={handleBugTrackerToggle}
        bugTrackerErrorCount={bugErrorCount}
        onHistoryToggle={handleHistoryToggle}
        historyCount={historyCount}
        onAnalyticsToggle={handleAnalyticsToggle}
        analyticsOpen={analyticsPanelOpen}
        onAiTutorToggle={handleAiTutorToggle}
        aiTutorOpen={aiTutorOpen}
        onAdminToggle={handleAdminToggle}
        adminDashboardOpen={adminDashboardOpen}
        isAdmin={isAdmin}
        onLeaderboardToggle={handleLeaderboardToggle}
        leaderboardOpen={leaderboardOpen}
        user={user}
        onSignIn={signInWithGoogle}
        onSignOut={signOut}
        onMobileAccountClick={onMobileAccountClick}
      />

      <div className={styles.workspace} ref={containerRef}>
        {/* Left — Editor */}
        <div
          className={styles.leftPane}
          style={!isMobile ? { width: `${leftWidth}%` } : undefined}
          data-hidden={isMobile ? (mobilePanelTab !== 'editor' ? 'true' : 'false') : undefined}
        >
          <EditorPanel
            code={code}
            onChange={setCode}
            tabs={tabs}
            activeTabId={activeTabId}
            onTabSwitch={handleTabSwitch}
            onTabAdd={handleTabAdd}
            onTabClose={handleTabClose}
            onTabRename={handleTabRename}
            onFileUpload={handleFileUpload}
            onRun={handleRun}
            onKill={handleKill}
            onClear={handleClear}
            isRunning={isRunning}
            runStatus={runStatus}
            isMobile={isMobile}
            selectedLanguage={selectedLanguage}
          />
        </div>

        {/* Vertical drag divider — desktop only, hidden on mobile via CSS */}
        {!isMobile && <DragDivider orientation="vertical" onMouseDown={onDividerMouseDown} />}

        {/* Right — Terminal / AI */}
        <div
          className={styles.rightPane}
          style={!isMobile ? { width: `${100 - leftWidth}%` } : undefined}
          data-hidden={isMobile ? (mobilePanelTab === 'editor' ? 'true' : 'false') : undefined}
        >
          <RightPanel
            ref={terminalRef}
            activeTab={activeTab}
            onTabChange={(tab) => {
              setActiveTab(tab);
              if (isMobile) setMobilePanelTab(tab === 'ai' ? 'ai' : 'console');
            }}
            code={code}
            onApplyFix={handleApplyFix}
            isRunning={runStatus}
            onStatusChange={handleStatusChange}
            onDone={handleDone}
            selectedLanguage={selectedLanguage}
            activeFileName={activeProgramTab?.name}
          />
        </div>
      </div>

      {/* ── Mobile Bottom Tab Bar ─────────────────────────────────────────── */}
      <nav className={styles.mobileTabs} aria-label="Panel navigation">

        {/* Editor tab */}
        <button
          className={`${styles.mobileTab} ${mobilePanelTab === 'editor' ? styles.mobileTabActive : ''}`}
          onClick={() => setMobilePanelTab('editor')}
          aria-label="Code Editor"
          id="mobile-tab-editor"
        >
          <Code2 size={20} aria-hidden="true" />
          Editor
        </button>

        {/* Console tab */}
        <button
          className={`${styles.mobileTab} ${mobilePanelTab === 'console' ? styles.mobileTabActive : ''}`}
          onClick={() => { setMobilePanelTab('console'); setActiveTab('terminal'); }}
          aria-label="Console"
          id="mobile-tab-console"
        >
          <TerminalSquare size={20} aria-hidden="true" />
          Console
        </button>

        {/* Bug Tracker tab */}
        <button
          className={`${styles.mobileTab}`}
          onClick={() => setBugPanelOpen(true)}
          aria-label="Bug Tracker"
          id="mobile-tab-bugs"
        >
          {bugErrorCount > 0 && <span className={styles.mobileTabBadge}>{bugErrorCount > 9 ? '9+' : bugErrorCount}</span>}
          <Bug size={20} aria-hidden="true" />
          Bugs
        </button>

        {/* History tab */}
        <button
          className={`${styles.mobileTab}`}
          onClick={() => setHistoryPanelOpen(true)}
          aria-label="Compilation History"
          id="mobile-tab-history"
        >
          {historyCount > 0 && <span className={styles.mobileTabBadge}>{historyCount > 9 ? '9+' : historyCount}</span>}
          <Clock size={20} aria-hidden="true" />
          History
        </button>

        {/* Analytics tab */}
        <button
          className={`${styles.mobileTab} ${analyticsPanelOpen ? styles.mobileTabActive : ''}`}
          onClick={handleAnalyticsToggle}
          aria-label="Analytics"
          id="mobile-tab-analytics"
        >
          <BarChart2 size={20} aria-hidden="true" />
          Analytics
        </button>

        {/* AI Tutor tab */}
        <button
          className={`${styles.mobileTab} ${aiTutorOpen ? styles.mobileTabActive : ''}`}
          onClick={handleAiTutorToggle}
          aria-label="AI Tutor"
          id="mobile-tab-ai-tutor"
        >
          <BookOpen size={20} aria-hidden="true" />
          AI Tutor
        </button>

      </nav>

      {/* Mobile FAB removed — Run is accessible from the EditorPanel toolbar */}

      {/* Language Detector Popup — rendered outside the split layout */}
      {showLangPopup && langDetect && (
        <LanguageDetectorPopup
          detectedLang={langDetect.language}
          confidence={langDetect.confidence}
          signals={langDetect.signals}
          scores={langDetect.scores}
          signalsMap={langDetect.signalsMap ?? {}}
          targetLang={selectedLanguage}
          onConfirm={handleConvertToC}
          onDismiss={handleDismissPopup}
          converting={converting}
        />
      )}

      {/* Analytics Panel — slides in from right */}
      {analyticsPanelOpen && (
        <AnalyticsPanel onClose={() => setAnalyticsPanelOpen(false)} selectedLanguage={selectedLanguage} />
      )}

      {/* Bug Tracker Panel — slides in from right */}
      {bugPanelOpen && (
        <BugTrackerPanel onClose={() => setBugPanelOpen(false)} selectedLanguage={selectedLanguage} />
      )}

      {/* Compilation History Panel — slides in from right */}
      {historyPanelOpen && (
        <CompilationHistoryPanel
          onClose={() => setHistoryPanelOpen(false)}
          onLoadInEditor={handleLoadFromHistory}
          selectedLanguage={selectedLanguage}
        />
      )}

      {/* AI Tutor Panel — distinct independent panel per language (no merge) */}
      <Suspense fallback={null}>
        <TutorErrorBoundary onClose={() => setAiTutorOpen(false)}>
        {aiTutorOpen && selectedLanguage === 'python' && (
          <PythonTutorPanel
            onClose={() => setAiTutorOpen(false)}
            onApplyToEditor={(code) => { setCode(code); setAiTutorOpen(false); }}
          />
        )}
        {aiTutorOpen && selectedLanguage === 'java' && (
          <JavaTutorPanel
            onClose={() => setAiTutorOpen(false)}
            onApplyToEditor={(code) => { setCode(code); setAiTutorOpen(false); }}
          />
        )}
        {aiTutorOpen && (selectedLanguage === 'c' || !selectedLanguage) && (
          <AiTutorPanel onClose={() => setAiTutorOpen(false)} />
        )}
      </TutorErrorBoundary>
      </Suspense>

      {/* Admin Dashboard — only rendered for admin email, modal overlay */}
      {adminDashboardOpen && (
        <AdminDashboard onClose={() => setAdminDashboardOpen(false)} />
      )}

      {/* Leaderboard — modal overlay, available to all logged-in users */}
      {leaderboardOpen && (
        <LeaderboardPanel onClose={() => setLeaderboardOpen(false)} currentUser={user} />
      )}

      {/* Mobile Account Sheet */}
      {mobileAccountSheetOpen && (
        <>
          <div
            style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:8000 }}
            onClick={() => setMobileAccountSheetOpen(false)}
          />
          <div className={styles.mobileAccountSheet}>
            <div className={styles.mobileAccountSheetHandle} />
            {user ? (
              <>
                <div className={styles.mobileAccountInfo}>
                  {user.user_metadata?.avatar_url
                    ? <img src={user.user_metadata.avatar_url} alt="" className={styles.mobileAccountAvatar} />
                    : <UserCircle size={48} style={{ color:'#64748b' }} />
                  }
                  <div>
                    <div className={styles.mobileAccountName}>{user.user_metadata?.full_name || 'User'}</div>
                    <div className={styles.mobileAccountEmail}>{user.email}</div>
                  </div>
                </div>
                <button
                  className={styles.mobileAccountSignOut}
                  onClick={() => { signOut(); setMobileAccountSheetOpen(false); }}
                >Sign Out</button>
              </>
            ) : (
              <button
                className={styles.mobileAccountSignIn}
                onClick={() => { signInWithGoogle(); setMobileAccountSheetOpen(false); }}
              >Sign In with Google</button>
            )}
          </div>
        </>
      )}

      {/* OCR/Upload Overlay */}
      {isUploading && (
        <div className={styles.uploadOverlay}>
          <div className={styles.uploadSpinnerContainer}>
            <div className={styles.uploadSpinner}></div>
            <div className={styles.uploadText}>Extracting Code with OCR...</div>
          </div>
        </div>
      )}

      {/* Conversion success toast — shown after "Yes, Convert to C" */}
      {conversionToast && (
        <div style={{
          position: 'fixed',
          bottom: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'linear-gradient(135deg, #0fa57c, #0d8f6a)',
          color: '#fff',
          padding: '12px 24px',
          borderRadius: '10px',
          fontFamily: "'Inter', sans-serif",
          fontSize: '14px',
          fontWeight: 600,
          letterSpacing: '0.02em',
          boxShadow: '0 8px 32px rgba(15,165,124,0.45)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          animation: 'slideUp 0.3s ease',
          cursor: 'pointer',
        }} onClick={() => setConversionToast(null)}>
          <span style={{ fontSize: '18px' }}>✓</span>
          <span>{conversionToast}</span>
        </div>
      )}

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateX(-50%) translateY(20px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
    </div>
  );
}
