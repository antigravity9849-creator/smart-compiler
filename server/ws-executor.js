'use strict';
/**
 * ws-executor.js — WebSocket interactive C execution via node-pty
 *
 * Architecture (PTY mode — like OnlineGDB / CS50 IDE):
 *
 *   Browser xterm.js  ──WS──▶  node-pty (server)  ──PTY──▶  docker run -i ... /prog
 *
 * Why PTY?
 *   • Without PTY, libc fully-buffers stdout (printf hangs until program exits)
 *   • Without PTY, Ctrl+C/Ctrl+D can't be delivered as terminal signals
 *   • PTY provides echo, line-discipline, and signal delivery for free
 *
 * Extra fix — STDIO_INIT prepended to every user program:
 *   Forces stdout/stderr/stdin to be fully unbuffered via setvbuf().
 *   This ensures printf("prompt: ") appears immediately even without \n.
 *   A #line directive resets gcc error line numbers so they match the user's code.
 *
 * Protocol (JSON over WebSocket):
 *   Client → Server:
 *     { type: 'run',    code, cols, rows }
 *     { type: 'stdin',  data }   ← raw keystrokes (PTY handles echo + signals)
 *     { type: 'resize', cols, rows }
 *     { type: 'kill' }
 *
 *   Server → Client:
 *     { type: 'status',        data: 'compiling'|'running' }
 *     { type: 'output',        data }   ← raw PTY bytes (stdout+stderr+echo, ANSI OK)
 *     { type: 'compile-error', data }
 *     { type: 'done',          exitCode, timeMs, killed, signal }
 *     { type: 'error',         data }
 *     { type: 'engine',        data: 'docker'|'wandbox' }
 */

const { WebSocketServer } = require('ws');
const { spawn, execFile }  = require('child_process');
const { promisify }        = require('util');
const fs                   = require('fs');
const os                   = require('os');
const path                 = require('path');
const { v4: uuidv4 }       = require('uuid');
const https                = require('https');

// node-pty: graceful degradation if not installed
let nodePty = null;
try {
  nodePty = require('node-pty');
  console.log('[ws-executor] node-pty loaded — PTY mode active');
} catch (e) {
  console.warn('[ws-executor] node-pty not available — falling back to plain spawn');
  console.warn('[ws-executor]   Run: cd server && npm install node-pty');
}

// ISSUE 7 FIX: Accept short-lived tickets from /api/ws-ticket instead of raw JWTs.
// Shared module avoids circular dependency with index.js.
const { WS_TICKETS } = require('./ws-tickets');

const execFileAsync = promisify(execFile);

// ── Record a completed WebSocket run in Supabase ────────────────────────────
// Mirrors index.js recordUserRun but adds language tracking.
// Fire-and-forget — never delays the `done` message sent to the client.
const SUPABASE_URL     = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';

function recordWsRun(userId, userEmail, language = 'c', isCleanRun = false) {
  if (!SUPABASE_URL || !userId || userId === 'local-dev-user') return;
  const bearerKey = SUPABASE_SVC_KEY || SUPABASE_ANON_KEY;
  if (!bearerKey) return;
  const today = new Date().toISOString().slice(0, 10);
  const lang = ['c', 'java', 'python'].includes((language || '').toLowerCase())
    ? language.toLowerCase() : 'c';
  fetch(`${SUPABASE_URL}/rest/v1/rpc/record_user_run`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${bearerKey}`,
      'apikey':        bearerKey,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      p_user_id:      userId,
      p_user_email:   userEmail || '',
      p_local_date:   today,
      p_language:     lang,
      p_is_clean_run: !!isCleanRun,
    }),
  }).catch(err => console.error('[ws-executor] recordWsRun failed:', err.message));
}

function safeKillPty(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32') {
      proc.kill();
    } else {
      proc.kill('SIGKILL');
    }
  } catch {}
}

// Import the dangerous-code scanner so we block system/popen/exec/fork
// in both the REST API path (executor.js) and the WebSocket path (here).
const { checkDangerousCode } = require('./executor');

function checkDangerousCodeForLanguage(code, language = 'c') {
  if (language === 'python') {
    let stripped = code.replace(/#.*/g, '');
    stripped = stripped.replace(/"""[\s\S]*?"""/g, '').replace(/'''[\s\S]*?'''/g, '');
    stripped = stripped.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    const pyDangerous = [
      { re: /\b(os\.system|os\.popen|os\.exec|os\.spawn|subprocess\.)/, label: 'system/subprocess' },
      { re: /\b(__import__\s*\(\s*['"](os|subprocess|shutil)['"])/, label: 'dynamic system import' },
      { re: /\b(shutil\.rmtree)/, label: 'shutil.rmtree' },
    ];
    for (const { re, label } of pyDangerous) {
      if (re.test(stripped)) {
        return {
          stderr: `This environment does not support \`${label}\`. System-level calls that spawn shell commands or delete system files are not allowed in this sandbox.\n\nNote: This is an intentional security restriction — not a bug in your code.`
        };
      }
    }
    return null;
  }
  if (language === 'java') {
    let stripped = code.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    stripped = stripped.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    const javaDangerous = [
      { re: /\b(Runtime\.getRuntime\(\)\.exec|ProcessBuilder)\b/, label: 'Process execution' },
    ];
    for (const { re, label } of javaDangerous) {
      if (re.test(stripped)) {
        return {
          stderr: `This environment does not support \`${label}\`. Process execution is not allowed in this sandbox.\n\nNote: This is an intentional security restriction — not a bug in your code.`
        };
      }
    }
    return null;
  }
  return checkDangerousCode(code);
}

// ── Per-IP WebSocket rate limiting ─────────────────────────────────────────────────────────
const WS_CONNECTIONS_PER_IP = new Map(); // ip → count
const MAX_WS_PER_IP = 64; // max simultaneous WebSocket connections per IP

// Active WebSocket compile/run processes count
let activeWsRuns = 0;
const MAX_GLOBAL_WS_RUNS = 50;

// ── Constants ────────────────────────────────────────────────────────────────
const DOCKER_IMAGE    = 'gcc-runner:latest';
const COMPILE_TIMEOUT = 12_000;   // 12 s compile timeout
const EXEC_TIMEOUT_MS = 30_000;   // 30 s TLE (interactive programs need more time)
const MEMORY_LIMIT    = '64m';
const CPU_LIMIT       = '0.5';
const PIDS_LIMIT      = '64';

const WANDBOX_URL      = 'https://wandbox.org/api/compile.json';
const WANDBOX_COMPILER = 'gcc-head-c';

/**
 * Prepended to every user program before compilation.
 *
 * 1. Forces stdio fully unbuffered so output appears immediately.
 * 2. #line 1 "main.c" resets GCC error reporting so line numbers
 *    match the user's code (not our prepended lines).
 */
const STDIO_INIT = `\
#ifndef __SMART_COMPILER_INIT__
#define __SMART_COMPILER_INIT__
#include <stdio.h>
#include <stdlib.h>
static void __attribute__((constructor,used)) __sc_io_init__(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);
  setvbuf(stdin,  NULL, _IONBF, 0);
}
#endif
#line 1 "main.c"
`;

/**
 * Strip PTY-only control sequences that node-pty / ConPTY inject into the
 * output stream but that are never part of a user program's actual output.
 * These sequences cause xterm.js to display artifacts like "[I" or "[?2004h"
 * when they arrive split across WebSocket frames.
 *
 * Sequences removed:
 *   ESC [ ? ... h/l  — private DEC modes (bracketed paste, alt screen, cursor keys)
 *   ESC [ I          — CHT (Cursor Forward Tabulation) — PTY tab init
 *   ESC [ 1 ; ... r  — DECSTBM (scroll region) — PTY window init
 *   ESC =  / ESC >   — keypad application / numeric mode
 *   ESC 7 / ESC 8    — save / restore cursor (DECSC/DECRC)
 */
function stripPtyNoise(data) {
  return data
    // Private DEC mode sequences: ESC [ ? <params> h/l  (e.g. ?2004h, ?1049h, ?1h)
    .replace(/\x1b\[\?[\d;]*[hl]/g, '')
    // CHT — Cursor Forward Tabulation: ESC [ <n> I
    .replace(/\x1b\[\d*I/g, '')
    // Scroll-region (DECSTBM): ESC [ <top> ; <bot> r
    .replace(/\x1b\[\d*;\d*r/g, '')
    // Keypad mode switches: ESC = and ESC >
    .replace(/\x1b[=>]/g, '')
    // Save/restore cursor (DECSC / DECRC): ESC 7 and ESC 8
    .replace(/\x1b[78]/g, '');
}

// ── Docker probe ─────────────────────────────────────────────────────────────
let _dockerReady = null;

async function isDockerReady() {
  if (_dockerReady !== null) return _dockerReady;
  try {
    await execFileAsync('docker', ['info'], { timeout: 3000 });
    const { stdout } = await execFileAsync(
      'docker', ['images', '-q', DOCKER_IMAGE], { timeout: 3000 }
    );
    _dockerReady = stdout.trim().length > 0;
    if (_dockerReady) {
      console.log('[ws-executor] Docker ready — using Docker engine');
    } else {
      console.warn('[ws-executor] Docker running but gcc-runner image not found. Attempting auto-build...');
      const dockerfileGcc = path.join(__dirname, 'Dockerfile.gcc');
      if (fs.existsSync(dockerfileGcc)) {
        try {
          console.log('[ws-executor] Auto-building gcc-runner:latest Docker image...');
          await execFileAsync('docker', ['build', '-f', dockerfileGcc, '-t', DOCKER_IMAGE, __dirname], { timeout: 120_000 });
          _dockerReady = true;
          console.log('[ws-executor] ✅ gcc-runner image auto-built successfully!');
          return _dockerReady;
        } catch (buildErr) {
          console.warn('[ws-executor] Auto-build failed:', buildErr.message);
        }
      }
      console.warn('[ws-executor] gcc-runner image not found — using Wandbox fallback');
    }
  } catch {
    _dockerReady = false;
    console.warn('[ws-executor] Docker not available — using Wandbox fallback');
  }
  return _dockerReady;
}

function resetDockerCache() { _dockerReady = null; }

function getCleanEnv() {
  const cleanEnv = {};
  const safeKeys = [
    'PATH',
    'TERM',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'windir',
    'USER',
    'USERNAME',
    'HOME',
    'HOMEPATH',
    'HOMEDRIVE'
  ];
  for (const key of safeKeys) {
    if (process.env[key] !== undefined) {
      cleanEnv[key] = process.env[key];
    }
  }
  return cleanEnv;
}

// ── Local GCC probe ──────────────────────────────────────────────────────────
// Tries `gcc --version`. Returns true if GCC is in PATH.
// NOTE: We NO LONGER disable this in production. The Dockerfile now installs
// GCC directly into the production container, so local GCC is always preferred
// over docker-in-docker (which caused the 24-hour restart image-loss bug).
async function isLocalGccReady() {
  try {
    await execFileAsync('gcc', ['--version'], { timeout: 3000 });
    console.log('[ws-executor] Local GCC found — using local GCC engine (no docker-in-docker)');
    return true;
  } catch {
    console.warn('[ws-executor] Local GCC not found in PATH');
    return false;
  }
}

let _pythonReady = null;
let _pythonBin   = 'python';   // resolved at first probe

async function isLocalPythonReady() {
  if (_pythonReady !== null) return _pythonReady;
  // Try 'python3' first (Debian/Ubuntu default install name),
  // then fall back to 'python' (Windows, python3-is-python symlink).
  for (const candidate of ['python3', 'python']) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 3000 });
      _pythonBin   = candidate;
      _pythonReady = true;
      console.log(`[ws-executor] Local Python found — using '${candidate}'`);
      return true;
    } catch { /* try next */ }
  }
  _pythonReady = false;
  console.warn('[ws-executor] Local Python not found — will use Wandbox for Python');
  return false;
}

let _javaReady = null;
let _javacBin = process.platform === 'win32' ? 'javac.exe' : 'javac';
let _javaBin  = process.platform === 'win32' ? 'java.exe' : 'java';

async function isLocalJavaReady() {
  if (_javaReady !== null) return _javaReady;

  const javacCmd = process.platform === 'win32' ? 'javac.exe' : 'javac';
  const javaCmd  = process.platform === 'win32' ? 'java.exe' : 'java';

  // 1. Check standard PATH
  try {
    await execFileAsync(javacCmd, ['-version'], { timeout: 3000 });
    await execFileAsync(javaCmd, ['-version'], { timeout: 3000 });
    _javacBin = javacCmd;
    _javaBin = javaCmd;
    _javaReady = true;
    console.log('[ws-executor] Local Java found on PATH');
    return true;
  } catch {}

  // 2. On Windows, probe common JDK installation paths (IntelliJ JBR, Program Files, JAVA_HOME)
  if (process.platform === 'win32') {
    const candidateDirs = [];
    if (process.env.JAVA_HOME) {
      candidateDirs.push(path.join(process.env.JAVA_HOME, 'bin'));
    }

    // JetBrains IDE runtimes (JBR has full javac + java)
    const jbBase = 'C:\\Program Files\\JetBrains';
    try {
      if (fs.existsSync(jbBase)) {
        const dirs = fs.readdirSync(jbBase);
        for (const d of dirs) {
          const jbrBin = path.join(jbBase, d, 'jbr', 'bin');
          if (fs.existsSync(jbrBin)) candidateDirs.push(jbrBin);
        }
      }
    } catch {}

    // Standard Java / Adoptium / Corretto locations
    const pfRoots = ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Amazon Corretto'];
    for (const r of pfRoots) {
      try {
        if (fs.existsSync(r)) {
          const sub = fs.readdirSync(r);
          for (const s of sub) {
            const b = path.join(r, s, 'bin');
            if (fs.existsSync(b)) candidateDirs.push(b);
          }
        }
      } catch {}
    }

    for (const dir of candidateDirs) {
      const jc = path.join(dir, 'javac.exe');
      const jv = path.join(dir, 'java.exe');
      if (fs.existsSync(jc) && fs.existsSync(jv)) {
        try {
          await execFileAsync(jc, ['-version'], { timeout: 3000 });
          await execFileAsync(jv, ['-version'], { timeout: 3000 });
          _javacBin = jc;
          _javaBin = jv;
          _javaReady = true;
          if (!process.env.PATH.includes(dir)) {
            process.env.PATH = `${dir};${process.env.PATH}`;
          }
          console.log(`[ws-executor] Local Java found at: ${dir}`);
          return true;
        } catch {}
      }
    }
  }

  // 3. On Linux (Debian/Ubuntu), scan /usr/lib/jvm/ — where `apt install default-jdk` places OpenJDK.
  //    Needed if update-alternatives didn't add javac/java to PATH (e.g. fresh Docker container).
  if (process.platform === 'linux') {
    const jvmRoot = '/usr/lib/jvm';
    try {
      if (fs.existsSync(jvmRoot)) {
        for (const jvmDir of fs.readdirSync(jvmRoot)) {
          const binPath = path.join(jvmRoot, jvmDir, 'bin');
          const jc = path.join(binPath, 'javac');
          const jv = path.join(binPath, 'java');
          if (fs.existsSync(jc) && fs.existsSync(jv)) {
            try {
              await execFileAsync(jc, ['-version'], { timeout: 3000 });
              await execFileAsync(jv, ['-version'], { timeout: 3000 });
              _javacBin  = jc;
              _javaBin   = jv;
              _javaReady = true;
              if (!process.env.PATH.includes(binPath)) {
                process.env.PATH = `${binPath}:${process.env.PATH}`;
              }
              console.log(`[ws-executor] Java found via /usr/lib/jvm/ → ${binPath}`);
              return true;
            } catch { /* try next jvm dir */ }
          }
        }
      }
    } catch { /* /usr/lib/jvm doesn't exist */ }
  }

  _javaReady = false;
  console.log('[ws-executor] Local Java not available — will use Wandbox for Java');
  return false;
}

// ── Windows path → Docker mount path ─────────────────────────────────────────
function toDockerPath(p) {
  return p.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d) => `//${d.toLowerCase()}`);
}

// ── Shared Docker base args for the run step ──────────────────────────────────
function buildRunArgs(mountPath, runId) {
  const args = [
    'run', '--rm', '--init',
    '-i',                              // keep stdin pipe open
    '--network', 'none',               // no network inside container
    '--memory', MEMORY_LIMIT,
    '--cpus', CPU_LIMIT,
    '--pids-limit', PIDS_LIMIT,
    '--read-only',                     // read-only root filesystem
    '--tmpfs', '/tmp:size=10m',        // writable /tmp only
    '-v', `${mountPath}:/sandbox`,
    '--user', 'runner',                // non-root
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '-e', 'TERM=xterm-256color',
  ];
  if (runId) {
    args.push('--name', `sc-run-${runId}`);
  }
  args.push(DOCKER_IMAGE, 'sh', '-c', 'ulimit -f 20480 -v 32768 && exec /sandbox/prog');
  return args;
}

// ── Attach WebSocket server ────────────────────────────────────────────────────────
function attachWebSocketServer(httpServer) {
  // ISSUE 7 FIX: Validate a short-lived ticket (not the raw JWT) during upgrade.
  // Client flow:
  //   1. POST /api/ws-ticket  (with Authorization: Bearer <jwt>)  → { ticket }
  //   2. Connect to ws://host/ws/run?ticket=<ticket>
  // The ticket is a random UUID, valid for 30 s and consumed on first use.
  // The full JWT never appears in the WS URL, access logs, or browser history.
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/run',
    verifyClient: async ({ req }, done) => {
      try {
        const url    = new URL(req.url, 'http://localhost');
        const ticket = url.searchParams.get('ticket') || '';

        const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
        const isLocalDev = process.env.NODE_ENV !== 'production'
          || !process.env.NODE_ENV
          || !supabaseUrl
          || supabaseUrl.includes('dummy')
          || supabaseUrl.includes('<your-project-ref>');

        if (!ticket || ticket === 'invalid' || ticket === 'dev-local') {
          if (isLocalDev) {
            req._wsUser = { id: 'local-dev-user', email: 'guest@example.com' };
            return done(true);
          }
          return done(false, 401, 'Unauthorized: No ticket provided. Call POST /api/ws-ticket first.');
        }

        // Look up the ticket (single-use — consumed immediately on connection)
        const ticketData = WS_TICKETS ? WS_TICKETS.get(ticket) : null;
        if (!ticketData) {
          if (isLocalDev) {
            req._wsUser = { id: 'local-dev-user', email: 'guest@example.com' };
            return done(true);
          }
          return done(false, 401, 'Unauthorized: Invalid or expired ticket. Please reconnect.');
        }
        if (ticketData.expiresAt < Date.now()) {
          WS_TICKETS.delete(ticket);
          if (isLocalDev) {
            req._wsUser = { id: 'local-dev-user', email: 'guest@example.com' };
            return done(true);
          }
          return done(false, 401, 'Unauthorized: Ticket expired. Please reconnect.');
        }

        // Consume the ticket (single-use — prevents replay attacks)
        WS_TICKETS.delete(ticket);

        // Attach the user info (from ticket) to the request
        req._wsUser = { id: ticketData.userId, email: ticketData.userEmail };
        done(true);
      } catch {
        done(false, 500, 'Internal error during authentication');
      }
    },
  });

  wss.on('connection', (ws, req) => {
    // ── Per-IP rate limiting ────────────────────────────────────────────────────
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket?.remoteAddress
      || 'unknown';

    const currentCount = WS_CONNECTIONS_PER_IP.get(clientIp) || 0;
    if (currentCount >= MAX_WS_PER_IP) {
      console.warn(`[ws-executor] Rejected connection from ${clientIp} — too many open connections (${currentCount})`);
      ws.close(1008, 'Too many connections from your IP. Please try again.');
      return;
    }
    WS_CONNECTIONS_PER_IP.set(clientIp, currentCount + 1);

    // Decrement count when this connection closes
    let countDecremented = false;
    const onWsClose = () => {
      if (countDecremented) return;
      countDecremented = true;
      const n = WS_CONNECTIONS_PER_IP.get(clientIp) || 1;
      if (n <= 1) WS_CONNECTIONS_PER_IP.delete(clientIp);
      else WS_CONNECTIONS_PER_IP.set(clientIp, n - 1);
    };
    ws.on('close', onWsClose);
    ws.on('error', onWsClose);

    let ptyProc     = null;   // node-pty process (PTY mode)
    let plainProc   = null;   // regular child_process (fallback)
    let compileProc = null;   // active compiler process
    let runId       = null;   // active run/execution ID
    let tmpDir      = null;
    let killTimer   = null;
    let cleaned     = false;
    let startTime   = 0;
    let cols        = 80;
    let rows        = 24;
    let hasIncrementedGlobalRuns = false;

    // ── Helpers ───────────────────────────────────────────────────────────
    function send(obj) {
      if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(obj));
    }

    // sendDone — records the run in Supabase then sends { type:'done', ... }.
    // isCleanRun = exitCode 0 (program completed without errors) AND not killed.
    function sendDone(payload, currentLang) {
      const u = req._wsUser;
      if (u?.id) {
        const isCleanRun = payload.exitCode === 0 && !payload.killed;
        recordWsRun(u.id, u.email, currentLang || 'c', isCleanRun);
      }
      send(payload);
    }

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (hasIncrementedGlobalRuns) {
        activeWsRuns = Math.max(0, activeWsRuns - 1);
        hasIncrementedGlobalRuns = false;
      }
      if (killTimer) clearTimeout(killTimer);
      if (ptyProc)   { safeKillPty(ptyProc); ptyProc = null; }
      if (plainProc && !plainProc.killed) {
        try { plainProc.kill('SIGKILL'); } catch {}
        plainProc = null;
      }
      if (compileProc && !compileProc.killed) {
        try { compileProc.kill('SIGKILL'); } catch {}
        compileProc = null;
      }
      if (runId) {
        try {
          execFile('docker', ['kill', `sc-compile-${runId}`], () => {});
          execFile('docker', ['kill', `sc-run-${runId}`], () => {});
        } catch {}
      }
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        tmpDir = null;
      }
    }

    // ── Message handler ───────────────────────────────────────────────────
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // ── stdin: forward raw keystrokes to PTY/process ──────────────────
      if (msg.type === 'stdin') {
        if (ptyProc) {
          try { ptyProc.write(msg.data); } catch {}
        } else if (plainProc?.stdin && !plainProc.stdin.destroyed) {
          try { plainProc.stdin.write(msg.data); } catch {}
        }
        return;
      }

      // ── resize: update PTY dimensions ────────────────────────────────
      if (msg.type === 'resize') {
        cols = Math.max(10, msg.cols || 80);
        rows = Math.max(4,  msg.rows || 24);
        if (ptyProc) { try { ptyProc.resize(cols, rows); } catch {} }
        return;
      }

      // ── kill: force-terminate ─────────────────────────────────────────
      if (msg.type === 'kill') {
        cleanup();
        send({ type: 'done', exitCode: -1, timeMs: 0, killed: true, signal: null });
        return;
      }

      // ── run: compile then execute ───────────────────────────────────────────────────────────────
      if (msg.type !== 'run') return;

      const { code, stdin: providedStdin = '', language = 'c' } = msg;
      const lang = (language || 'c').toLowerCase();
      cols = Math.max(10, msg.cols || 80);
      rows = Math.max(4,  msg.rows || 24);

      // Clean up previous runs on this connection first to prevent orphaned processes
      cleanup();

      // Check global concurrent limit AFTER cleanup (in case this clean released a slot)
      if (activeWsRuns >= MAX_GLOBAL_WS_RUNS) {
        send({ type: 'error', data: 'Server is busy: too many concurrent compilation or run processes. Please try again.' });
        return;
      }

      // User was already verified by verifyClient during the upgrade handshake.
      // We read the pre-verified user from the request object.
      const wsUser = req._wsUser;
      if (!wsUser?.id) {
        send({ type: 'error', data: 'Unauthorized: Please log in to compile and run code.' });
        cleanup();
        return;
      }

      if (!code?.trim()) {
        send({ type: 'error', data: 'No code provided.' });
        return;
      }

      if (Buffer.byteLength(code, 'utf8') > 100_000) {
        send({ type: 'error', data: 'Code is too large (max 100 KB).' });
        return;
      }

      // Block dangerous system-level calls
      const blocked = checkDangerousCodeForLanguage(code, lang);
      if (blocked) {
        send({
          type: 'compile-error',
          data: blocked.stderr,
        });
        send({ type: 'done', exitCode: 1, timeMs: 0, killed: false, signal: null });
        cleanup();
        return;
      }

      cleaned = false;
      if (!hasIncrementedGlobalRuns) {
        activeWsRuns++;
        hasIncrementedGlobalRuns = true;
      }
      runId = uuidv4();
      const baseTmp = process.env.COMPILER_TMP_DIR || (process.platform === 'win32' ? os.tmpdir() : '/data/compiler-tmp');
      tmpDir = path.join(baseTmp, `sc-ws-${runId}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      try { fs.chmodSync(tmpDir, 0o777); } catch {}

      // ══════════════════════════════════════════════════════════════════
      // PYTHON EXECUTION PATH
      // ══════════════════════════════════════════════════════════════════
      if (lang === 'python') {
        const pyFile = path.join(tmpDir, 'main.py');
        fs.writeFileSync(pyFile, code, 'utf8');

        const localPy = await isLocalPythonReady();
        if (localPy) {
          send({ type: 'engine', data: 'local' });
          send({ type: 'status', data: 'compiling' });

          // Fast syntax pre-check via py_compile
          let pySyntaxErr = null;
          try {
            await execFileAsync(_pythonBin, ['-m', 'py_compile', pyFile], { timeout: COMPILE_TIMEOUT });
          } catch (err) {
            pySyntaxErr = (err.stderr || err.stdout || err.message || '').trim();
          }

          if (pySyntaxErr) {
            const cleanErr = pySyntaxErr
              .replace(new RegExp(tmpDir.replace(/\\/g, '\\\\'), 'g'), '')
              .replace(/File ".*[\\\/]main\.py"/g, 'File "main.py"')
              .trim();
            send({ type: 'compile-error', data: cleanErr || 'Python syntax error.' });
            send({ type: 'done', exitCode: 1, timeMs: 0, killed: false, signal: null });
            cleanup();
            return;
          }

          // Run Python with -u (unbuffered) for interactive PTY
          send({ type: 'status', data: 'running' });
          startTime = Date.now();

          const ptyEnv = getCleanEnv();
          ptyEnv.TERM = 'xterm-256color';
          ptyEnv.PYTHONUNBUFFERED = '1';

          // Use whichever Python binary was discovered by isLocalPythonReady()
          const pyBin = process.platform === 'win32' ? 'python.exe' : _pythonBin;
          if (nodePty) {
            try {
              ptyProc = nodePty.spawn(pyBin, ['-u', 'main.py'], {
                name: 'xterm-256color',
                cols,
                rows,
                cwd: tmpDir,
                env: ptyEnv,
              });
            } catch (err) {
              send({ type: 'error', data: `Failed to start Python: ${err.message}` });
              cleanup();
              return;
            }

            ptyProc.onData(data => {
              if (!cleaned) {
                const out = stripPtyNoise(data);
                if (out) send({ type: 'output', data: out });
              }
            });

            ptyProc.onExit(({ exitCode: ec, signal: sig }) => {
              if (cleaned) return;
              const timeMs = Date.now() - startTime;
              const killed = ec === 137 || sig === 9;
              sendDone({ type: 'done', exitCode: ec ?? 0, timeMs, killed, signal: sig ?? null }, lang);
              ptyProc = null;
              cleanup();
            });
          } else {
            const plainPyBin = process.platform === 'win32' ? 'python.exe' : _pythonBin;
            plainProc = spawn(plainPyBin, ['-u', 'main.py'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: tmpDir, env: ptyEnv });
            const normalize = d => d.toString().replace(/\r?\n/g, '\r\n');
            plainProc.stdout.on('data', d => { if (!cleaned) send({ type: 'output', data: normalize(d) }); });
            plainProc.stderr.on('data', d => { if (!cleaned) send({ type: 'output', data: normalize(d) }); });
            plainProc.on('close', (ec, sig) => {
              if (cleaned) return;
              const timeMs = Date.now() - startTime;
              sendDone({ type: 'done', exitCode: ec ?? 0, timeMs, killed: ec === 137, signal: sig ?? null }, lang);
              cleanup();
            });
            plainProc.on('error', err => {
              if (!cleaned) send({ type: 'error', data: `Runtime error: ${err.message}` });
              cleanup();
            });
          }

          killTimer = setTimeout(() => {
            if (cleaned) return;
            console.warn(`[ws-executor] TLE — killing Python process after ${EXEC_TIMEOUT_MS}ms`);
            if (ptyProc)   { safeKillPty(ptyProc); }
            if (plainProc) { try { plainProc.kill('SIGKILL');  } catch {} }
          }, EXEC_TIMEOUT_MS);

          return;
        }

        // Wandbox fallback for Python
        send({ type: 'engine', data: 'wandbox' });
        send({ type: 'status', data: 'running' });
        await runWithWandbox(code, providedStdin, send, 'python');
        cleanup();
        return;
      }

      // ══════════════════════════════════════════════════════════════════
      // JAVA EXECUTION PATH
      // ══════════════════════════════════════════════════════════════════
      if (lang === 'java') {
        // ── Smart entry class detection ──────────────────────────────────────
        // Priority 1: find the class that actually contains 'public static void main'
        // Priority 2: first 'public class'
        // Priority 3: first 'class'
        // Priority 4: default to 'Main'
        let entryClass = 'Main';
        const mainMatch = code.match(/class\s+([A-Za-z0-9_$]+)[^{]*\{[\s\S]*?public\s+static\s+void\s+main/);
        if (mainMatch) {
          entryClass = mainMatch[1];
        } else {
          const publicClassMatch = code.match(/public\s+class\s+([A-Za-z0-9_$]+)/);
          if (publicClassMatch) {
            entryClass = publicClassMatch[1];
          } else {
            const anyClassMatch = code.match(/class\s+([A-Za-z0-9_$]+)/);
            if (anyClassMatch) entryClass = anyClassMatch[1];
          }
        }

        // Strip 'package' declarations — the runner compiles in a flat temp dir
        // so package-qualified names would cause 'Could not find or load main class'.
        const strippedCode = code.replace(/^\s*package\s+[\w.]+\s*;\s*\n?/m, '');

        const javaFileName = `${entryClass}.java`;
        const javaFile = path.join(tmpDir, javaFileName);
        fs.writeFileSync(javaFile, strippedCode, 'utf8');

        const localJava = await isLocalJavaReady();
        if (localJava) {
          send({ type: 'engine', data: 'local' });
          send({ type: 'status', data: 'compiling' });

          let javacOut = '';
          let javacOk = false;
          await new Promise((res) => {
            compileProc = spawn(_javacBin, [javaFileName], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'], env: getCleanEnv() });
            compileProc.stdout.on('data', d => { javacOut += d.toString(); });
            compileProc.stderr.on('data', d => { javacOut += d.toString(); });
            const t = setTimeout(() => { if (compileProc) compileProc.kill(); res(); }, COMPILE_TIMEOUT);
            compileProc.on('close', (c) => { clearTimeout(t); javacOk = c === 0; res(); });
            compileProc.on('error', (err) => { clearTimeout(t); javacOut += `\n${err.message}`; res(); });
          });
          compileProc = null;

          if (!javacOk) {
            send({ type: 'compile-error', data: javacOut.trim() || 'Java compilation failed.' });
            send({ type: 'done', exitCode: 1, timeMs: 0, killed: false, signal: null });
            cleanup();
            return;
          }

          send({ type: 'status', data: 'running' });
          startTime = Date.now();
          const ptyEnv = getCleanEnv();
          ptyEnv.TERM = 'xterm-256color';

          // Memory flags — identical to OnlineGDB / Programiz constraints:
          //   -Xms16m       → start with a 16 MB heap (don't pre-allocate max up front)
          //   -Xmx128m      → cap student programs at 128 MB (prevents memory-bomb loops)
          //   -XX:+UseSerialGC → single-threaded GC; drops idle JVM RAM from ~120 MB → ~40 MB
          const JVM_FLAGS = ['-Xms16m', '-Xmx128m', '-XX:+UseSerialGC'];

          if (nodePty) {
            try {
              ptyProc = nodePty.spawn(_javaBin, [...JVM_FLAGS, entryClass], {
                name: 'xterm-256color',
                cols,
                rows,
                cwd: tmpDir,
                env: ptyEnv,
              });
            } catch (err) {
              send({ type: 'error', data: `Failed to start Java: ${err.message}` });
              cleanup();
              return;
            }

            ptyProc.onData(data => {
              if (!cleaned) {
                const out = stripPtyNoise(data);
                if (out) send({ type: 'output', data: out });
              }
            });

            ptyProc.onExit(({ exitCode: ec, signal: sig }) => {
              if (cleaned) return;
              const timeMs = Date.now() - startTime;
              sendDone({ type: 'done', exitCode: ec ?? 0, timeMs, killed: ec === 137, signal: sig ?? null }, lang);
              ptyProc = null;
              cleanup();
            });
          } else {
            plainProc = spawn(_javaBin, [...JVM_FLAGS, entryClass], { stdio: ['pipe', 'pipe', 'pipe'], cwd: tmpDir, env: ptyEnv });
            const normalize = d => d.toString().replace(/\r?\n/g, '\r\n');
            plainProc.stdout.on('data', d => { if (!cleaned) send({ type: 'output', data: normalize(d) }); });
            plainProc.stderr.on('data', d => { if (!cleaned) send({ type: 'output', data: normalize(d) }); });
            plainProc.on('close', (ec, sig) => {
              if (cleaned) return;
              const timeMs = Date.now() - startTime;
              sendDone({ type: 'done', exitCode: ec ?? 0, timeMs, killed: ec === 137, signal: sig ?? null }, lang);
              cleanup();
            });
            plainProc.on('error', err => {
              if (!cleaned) send({ type: 'error', data: `Runtime error: ${err.message}` });
              cleanup();
            });
          }

          killTimer = setTimeout(() => {
            if (cleaned) return;
            console.warn(`[ws-executor] TLE — killing Java process after ${EXEC_TIMEOUT_MS}ms`);
            if (ptyProc)   { safeKillPty(ptyProc); }
            if (plainProc) { try { plainProc.kill('SIGKILL'); } catch {} }
          }, EXEC_TIMEOUT_MS);

          return;
        }

        // Wandbox fallback for Java
        send({ type: 'engine', data: 'wandbox' });
        send({ type: 'status', data: 'compiling' });
        await runWithWandbox(code, providedStdin, send, 'java');
        cleanup();
        return;
      }

      // ══════════════════════════════════════════════════════════════════
      // C EXECUTION PATH
      // ══════════════════════════════════════════════════════════════════
      // Write code with stdio init prepended + #line directive for correct error lines
      fs.writeFileSync(path.join(tmpDir, 'main.c'), STDIO_INIT + code, 'utf8');

      // ── Engine selection (permanent fix for 24-hour docker image loss bug) ──
      // 1. Local GCC  — always available (GCC baked into Dockerfile Stage 3)
      // 2. Docker     — only if docker socket mounted AND gcc-runner image exists
      // 3. Wandbox    — last resort (batch mode, no interactive stdin)
      const localGcc = await isLocalGccReady();

      if (localGcc) {
        // ── Local GCC + node-pty: fully interactive, exactly like OnlineGDB ──
        send({ type: 'engine', data: 'local' });
        send({ type: 'status', data: 'compiling' });

        // Step 1: compile locally with GCC
        const localExeName = process.platform === 'win32' ? 'prog.exe' : 'prog';
        const localExePath = path.join(tmpDir, localExeName);
        const srcPath      = path.join(tmpDir, 'main.c');

        let localCompileOut     = '';
        let localCompileTimeout = false;
        let localCompileOk      = false;

        await new Promise((resolve) => {
          compileProc = spawn(
            'gcc',
            [srcPath, '-Wall', '-Wextra', '-O2', '-o', localExePath, '-lm'],
            { stdio: ['ignore', 'pipe', 'pipe'], env: getCleanEnv() }
          );
          compileProc.stdout.on('data', d => { localCompileOut += d.toString(); });
          compileProc.stderr.on('data', d => { localCompileOut += d.toString(); });
          const t = setTimeout(() => {
            if (compileProc) compileProc.kill();
            localCompileTimeout = true;
            resolve();
          }, COMPILE_TIMEOUT);
          compileProc.on('close', code => {
            clearTimeout(t);
            localCompileOk = code === 0;
            resolve();
          });
          compileProc.on('error', err => {
            clearTimeout(t);
            localCompileOut += `\nGCC error: ${err.message}`;
            resolve();
          });
        });
        compileProc = null;

        // Strip the temp directory prefix from error messages so line numbers are clean
        const localCompileMsg = localCompileOut
          .replace(new RegExp(tmpDir.replace(/\\/g, '\\\\'), 'g'), '')
          .replace(/\/[^:]+main\.c/g, 'main.c')
          .trim();

        if (localCompileTimeout || !localCompileOk) {
          send({ type: 'compile-error', data: localCompileMsg || 'Compilation failed.' });
          cleanup();
          return;
        }

        // Emit warnings on success
        if (localCompileMsg) {
          send({ type: 'output', data: `\x1b[33m${localCompileMsg}\x1b[0m\r\n` });
        }

        // Step 2: run with node-pty (interactive PTY)
        send({ type: 'status', data: 'running' });
        startTime = Date.now();

        if (nodePty) {
          try {
            const ptyEnv = getCleanEnv();
            ptyEnv.TERM = 'xterm-256color';
            ptyProc = nodePty.spawn(localExePath, [], {
              name: 'xterm-256color',
              cols,
              rows,
              cwd: tmpDir,
              env: ptyEnv,
            });
          } catch (err) {
            send({ type: 'error', data: `Failed to start program: ${err.message}` });
            cleanup();
            return;
          }

          ptyProc.onData(data => {
            if (!cleaned) {
              const out = stripPtyNoise(data);
              if (out) send({ type: 'output', data: out });
            }
          });

          ptyProc.onExit(({ exitCode: ec, signal: sig }) => {
            if (cleaned) return;
            const timeMs = Date.now() - startTime;
            const killed = ec === 137 || sig === 9;
            sendDone({ type: 'done', exitCode: ec ?? 1, timeMs, killed, signal: sig ?? null }, lang);
            ptyProc = null;
            cleanup();
          });

        } else {
          // node-pty not available: plain spawn (no interactive input, but at least runs)
          plainProc = spawn(localExePath, [], { stdio: ['pipe', 'pipe', 'pipe'], cwd: tmpDir, env: getCleanEnv() });
          const normalize = d => d.toString().replace(/\r?\n/g, '\r\n');
          plainProc.stdout.on('data', d => { if (!cleaned) send({ type: 'output', data: normalize(d) }); });
          plainProc.stderr.on('data', d => { if (!cleaned) send({ type: 'output', data: normalize(d) }); });
          plainProc.on('close', (code, sig) => {
            if (cleaned) return;
            const timeMs = Date.now() - startTime;
            const killed = code === 137 || sig === 'SIGKILL';
            sendDone({ type: 'done', exitCode: code ?? 1, timeMs, killed, signal: sig ?? null }, lang);
            cleanup();
          });
          plainProc.on('error', err => {
            if (!cleaned) send({ type: 'error', data: `Runtime error: ${err.message}` });
            cleanup();
          });
        }

        // Hard TLE
        killTimer = setTimeout(() => {
          if (cleaned) return;
          console.warn(`[ws-executor] TLE — killing local process after ${EXEC_TIMEOUT_MS}ms`);
          if (ptyProc)   { safeKillPty(ptyProc); }
          if (plainProc) { try { plainProc.kill('SIGKILL');  } catch {} }
        }, EXEC_TIMEOUT_MS);

        return; // done — skip Docker/Wandbox path below
      }

      // ── No local GCC: try Docker, then Wandbox ─────────────────────────────
      const dockerAvailable = await isDockerReady();
      if (!dockerAvailable) {
        // Last resort: Wandbox batch API
        send({ type: 'engine', data: 'wandbox' });
        send({ type: 'status', data: 'compiling' });
        await runWithWandbox(code, providedStdin, send);
        cleanup();
        return;
      }

      send({ type: 'engine', data: 'docker' });
      send({ type: 'status', data: 'compiling' });



      // ── Step 1: Compile (no PTY needed) ──────────────────────────────
      const mountPath = toDockerPath(tmpDir);

      const compileArgs = [
        'run', '--rm', '--init', '--network', 'none',
        '--name', `sc-compile-${runId}`,
        '--memory', MEMORY_LIMIT, '--cpus', CPU_LIMIT,
        '--pids-limit', PIDS_LIMIT, '--read-only',
        '--tmpfs', '/tmp:size=10m',
        '-v', `${mountPath}:/sandbox`,
        '--user', 'runner', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        DOCKER_IMAGE,
        'sh', '-c',
        // Compile, capture all output (stdout + stderr merged), print exit code
        'ulimit -f 20480 -v 65536; gcc /sandbox/main.c -Wall -Wextra -O3 -D__USE_MINGW_ANSI_STDIO -o /sandbox/prog -lm 2>&1; echo "::CEXIT::$?"',
      ];

      let compileOut     = '';
      let compileTimeout = false;

      await new Promise((resolve) => {
        compileProc = spawn('docker', compileArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: getCleanEnv() });
        compileProc.stdout.on('data', d => { compileOut += d.toString(); });
        compileProc.stderr.on('data', d => { compileOut += d.toString(); });
        const t = setTimeout(() => { if (compileProc) compileProc.kill(); compileTimeout = true; resolve(); }, COMPILE_TIMEOUT);
        compileProc.on('close', () => { clearTimeout(t); resolve(); });
        compileProc.on('error', err => {
          clearTimeout(t);
          compileTimeout = true;
          compileOut += `\nDocker error: ${err.message}`;
          resolve();
        });
      });
      compileProc = null;

      // Parse compile result
      const compileLines = compileOut.split('\n');
      const exitMarker   = compileLines.find(l => l.startsWith('::CEXIT::'));
      const exitCode     = exitMarker ? parseInt(exitMarker.replace('::CEXIT::', '').trim(), 10) : 1;

      // Clean up output: remove exit marker and /sandbox/ path prefix
      // (The #line directive makes gcc report "main.c" directly, so /sandbox/ shouldn't appear
      //  but we strip it anyway as defence in depth)
      const compileMsg = compileLines
        .filter(l => !l.startsWith('::CEXIT::'))
        .join('\n')
        .replace(/\/sandbox\//g, '')
        .trim();

      if (compileTimeout || exitCode !== 0) {
        // Check if Docker failed because of missing runner image or Docker daemon error
        if (
          compileOut.includes('Unable to find image') ||
          compileOut.includes('pull access denied') ||
          compileOut.includes('repository does not exist') ||
          compileOut.includes('docker: Error response from daemon')
        ) {
          console.warn('[ws-executor] Docker runner image missing or daemon error. Invalidating cache & falling back to Wandbox API.');
          resetDockerCache();
          send({ type: 'engine', data: 'wandbox' });
          send({ type: 'status', data: 'compiling' });
          await runWithWandbox(code, providedStdin, send);
          cleanup();
          return;
        }

        send({ type: 'compile-error', data: compileMsg || 'Compilation failed.' });
        cleanup();
        return;
      }

      // Emit warnings even on success (exitCode === 0 but gcc printed something)
      if (compileMsg) {
        send({ type: 'output', data: `\x1b[33m${compileMsg}\x1b[0m\r\n` });
      }

      // ── Step 2: Run ───────────────────────────────────────────────────
      send({ type: 'status', data: 'running' });
      startTime = Date.now();

      const runArgs = buildRunArgs(mountPath, runId);

      if (nodePty) {
        // ── PTY mode (node-pty) ───────────────────────────────────────
        // node-pty creates a real pseudo-terminal on the host.
        // The PTY driver handles: echo, line-editing, Ctrl+C (SIGINT), Ctrl+D (EOF).
        // The setvbuf() in STDIO_INIT forces unbuffered I/O inside the container.
        try {
          const ptyEnv = getCleanEnv();
          ptyEnv.TERM = 'xterm-256color';
          ptyProc = nodePty.spawn('docker', runArgs, {
            name:  'xterm-256color',
            cols,
            rows,
            cwd:   os.tmpdir(),
            env:   ptyEnv,  // ✅ only safe keys — no API keys or secrets
          });
        } catch (err) {
          send({ type: 'error', data: `Failed to start program: ${err.message}` });
          cleanup();
          return;
        }

        ptyProc.onData(data => {
          if (!cleaned) {
            const out = stripPtyNoise(data);
            if (out) send({ type: 'output', data: out });
          }
        });

        ptyProc.onExit(({ exitCode: ec, signal: sig }) => {
          if (cleaned) return;
          const timeMs = Date.now() - startTime;
          // exit 137 = SIGKILL (OOM or our TLE timer)
          const killed = ec === 137 || sig === 9;
          send({
            type:     'done',
            exitCode: ec ?? 1,
            timeMs,
            killed,
            signal:   sig ?? null,
          });
          cleanup();
        });

      } else {
        // ── Plain spawn fallback (no node-pty) ────────────────────────
        // Output is pipe-based; normalize \n → \r\n for xterm.js.
        plainProc = spawn('docker', runArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: getCleanEnv() });

        const normalize = d => d.toString().replace(/\r?\n/g, '\r\n');

        plainProc.stdout.on('data', d => { if (!cleaned) send({ type: 'output', data: normalize(d) }); });
        plainProc.stderr.on('data', d => { if (!cleaned) send({ type: 'output', data: normalize(d) }); });

        plainProc.on('close', (code, sig) => {
          if (cleaned) return;
          const timeMs = Date.now() - startTime;
          const killed = code === 137 || sig === 'SIGKILL';
          sendDone({ type: 'done', exitCode: code ?? 1, timeMs, killed, signal: sig ?? null }, lang);
          cleanup();
        });

        plainProc.on('error', err => {
          if (!cleaned) send({ type: 'error', data: `Runtime error: ${err.message}` });
          cleanup();
        });
      }

      // Hard TLE — kills whatever is running after EXEC_TIMEOUT_MS
      killTimer = setTimeout(() => {
        if (cleaned) return;
        console.warn(`[ws-executor] TLE — killing after ${EXEC_TIMEOUT_MS}ms`);
        if (ptyProc)   { safeKillPty(ptyProc); }
        if (plainProc) { try { plainProc.kill('SIGKILL'); } catch {} }
      }, EXEC_TIMEOUT_MS);
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return wss;
}

// ── Wandbox batch fallback (no Docker) ───────────────────────────────────────
async function runWithWandbox(code, stdin, send, language = 'c') {
  const startTime = Date.now();
  let compiler = WANDBOX_COMPILER;
  let payloadCode = code;
  let options = 'warning,optimize';
  let compilerRaw = '-lm';

  if (language === 'python') {
    compiler = 'cpython-3.12.7';
    options = '';
    compilerRaw = '';
  } else if (language === 'java') {
    compiler = 'openjdk-jdk-21+35';
    // Make class non-public so it compiles in Wandbox prog.java
    payloadCode = code.replace(/\bpublic\s+class\b/g, 'class');
    options = '';
    compilerRaw = '';
  }

  const payload = {
    compiler,
    code: payloadCode,
    stdin: stdin || '',
  };
  if (options) payload.options = options;
  if (compilerRaw) payload['compiler-option-raw'] = compilerRaw;

  const body = JSON.stringify(payload);

  return new Promise((resolve) => {
    const options = {
      hostname: 'wandbox.org',
      path:     '/api/compile.json',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'smart-compiler/1.0',
      },
    };

    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const data    = JSON.parse(raw);
          const ec      = parseInt(data.status ?? '0', 10);
          const killed  = data.signal === 'Killed' || data.signal === 'TLE';
          const cErr    = (data.compiler_error  || '').trim();
          const cOut    = (data.compiler_output || '').trim();
          const cMsg    = cErr || cOut;   // combined compiler messages

          // A real compile error: non-zero exit AND the compiler emitted error text
          // (not just warnings) AND the program produced no output.
          const isCompileError = ec !== 0 && !!cErr && !data.program_output;

          if (isCompileError) {
            send({ type: 'compile-error', data: cMsg });
            // Always send done so the UI exits the 'compiling' state
            sendDone({ type: 'done', exitCode: ec, timeMs: Date.now() - startTime, killed: false, signal: null }, lang);
            resolve();
            return;
          }

          // Compile succeeded (possibly with warnings) — tell the client we are now running
          send({ type: 'status', data: 'running' });

          // Show a notice that this is batch mode (Wandbox) — input is pre-set, not interactive
          if (stdin) {
            send({ type: 'output', data: `\x1b[38;5;240m[Running in batch mode · stdin: ${stdin.trim().split('\n').length} line(s) provided via Input tab]\x1b[0m\r\n` });
          } else {
            send({ type: 'output', data: `\x1b[38;5;240m[Running in batch mode · if your program needs input, switch to the ⌨ Input tab and enter values before pressing Run]\x1b[0m\r\n` });
          }

          // Emit compiler warnings (yellow) if any
          if (cMsg) {
            send({ type: 'output', data: `\x1b[33m${cMsg}\x1b[0m\r\n` });
          }

          // Emit program output
          if (data.program_output) {
            // Normalize line endings for xterm.js
            send({ type: 'output', data: data.program_output.replace(/\r?\n/g, '\r\n') });
          }

          sendDone({ type: 'done', exitCode: ec, timeMs: Date.now() - startTime, killed, signal: data.signal || null }, lang);
        } catch {
          send({ type: 'error', data: 'Wandbox returned invalid response.' });
        }
        resolve();
      });
    });

    const t = setTimeout(() => {
      req.destroy();
      send({ type: 'error', data: 'Wandbox timed out (35 s). Please try again.' });
      resolve();
    }, 35_000);

    req.on('error', e => { clearTimeout(t); send({ type: 'error', data: `Wandbox connection failed: ${e.message}` }); resolve(); });
    req.on('close', () => clearTimeout(t));
    req.write(body);
    req.end();
  });
}

module.exports = { attachWebSocketServer, resetDockerCache, checkDangerousCodeForLanguage };
