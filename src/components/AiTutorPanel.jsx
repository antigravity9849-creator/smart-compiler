import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import styles from './AiTutorPanel.module.css';
import { TUTOR_CURRICULUM, TUTOR_LEVELS } from '../tutorData';
import { TutorDiagram } from './TutorDiagrams';
import { callClaude, parseJSON, compileC } from '../api';
import { TUTOR_LOGIC_SYSTEM_PROMPT, TUTOR_CODE_SYSTEM_PROMPT, TUTOR_AI_SOLUTION_PROMPT } from '../constants';
import { analyticsStore } from '../analytics';
import { highlightC } from '../highlight';
import DOMPurify from 'dompurify';

// ─── SpeakerBtn ──────────────────────────────────────────────────────────────
// Small inline speaker button with wave animation when active.
function SpeakerBtn({ sectionKey, activeSpeakingSection, onSpeak, onStop, isSpeaking }) {
  const isActive = isSpeaking && activeSpeakingSection === sectionKey;
  return (
    <button
      className={`${styles.speakerBtn} ${isActive ? styles.speakerBtnActive : ''}`}
      onClick={(e) => { e.stopPropagation(); isActive ? onStop() : onSpeak(sectionKey); }}
      title={isActive ? 'Stop reading' : 'Read this section aloud'}
      aria-label={isActive ? 'Stop reading' : 'Read this section aloud'}
    >
      {isActive ? (
        <span className={styles.soundWave} aria-hidden="true">
          <span className={styles.soundWaveBar} />
          <span className={styles.soundWaveBar} />
          <span className={styles.soundWaveBar} />
          <span className={styles.soundWaveBar} />
          <span className={styles.soundWaveBar} />
        </span>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      )}
    </button>
  );
}


export default function AiTutorPanel({ onClose }) {
  // Curriculum selection & Navigation
  const [selectedTopicId, setSelectedTopicId] = useState('hello-world');
  const [step, setStep] = useState(1); // 1: Concept, 2: Quiz, 3: Logic, 4: Code
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLevel, setSelectedLevel] = useState(0); // 0 = All Levels

  // Mobile two-screen flow: 'topics' = topic picker, 'steps' = learning steps
  const [mobileTutorView, setMobileTutorView] = useState('topics');

  // Step 2: Quiz State
  const [quizAnswers, setQuizAnswers] = useState({}); // { questionId: selectedIndex }
  const [quizSubmitted, setQuizSubmitted] = useState(false);
  const [quizPassed, setQuizPassed] = useState(false);
  const [activeQuizIdx, setActiveQuizIdx] = useState(0);
  const [selectedOptionIdx, setSelectedOptionIdx] = useState(null);
  const [isAnswerChecked, setIsAnswerChecked] = useState(false);

  // Step 3: Logic State
  const [logicText, setLogicText] = useState('');
  const [isValidatingLogic, setIsValidatingLogic] = useState(false);
  const [logicResult, setLogicResult] = useState(null); // { correct, feedback, hints }

  // Step 4: Code State
  const [codeText, setCodeText] = useState(() => {
    const defaultTopic = TUTOR_CURRICULUM['hello-world'];
    if (defaultTopic.referenceSolution) {
      const headerLines = defaultTopic.referenceSolution.split('\n');
      const includes = headerLines.filter(line => line.startsWith('#include')).join('\n');
      return `${includes}\n\nint main() {\n    // Write your code for: ${defaultTopic.title}\n    // Refer to Step 1 & 3 concepts\n    \n    return 0;\n}`;
    }
    return '#include <stdio.h>\n\nint main() {\n    \n    return 0;\n}';
  });
  const [stdinText, setStdinText] = useState('');
  const [isRunningCode, setIsRunningCode] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState('');
  const [isValidatingCode, setIsValidatingCode] = useState(false);
  const [codeResult, setCodeResult] = useState(null); // { correct, feedback, issues }
  const [showSolution, setShowSolution] = useState(false);
  const [isGeneratingSolution, setIsGeneratingSolution] = useState(false);
  const [langWarning, setLangWarning] = useState(null); // non-null = detected language string
  const [aiSolution, setAiSolution] = useState(null);  // { c_code, explanation, steps }
  const [isGeneratingAiSolution, setIsGeneratingAiSolution] = useState(false);

  // Completed Topics (tracked in memory since no localStorage requirement)
  const [completedTopics, setCompletedTopics] = useState(new Set());
  const [showCompletionModal, setShowCompletionModal] = useState(false);

  // ─── Voice / TTS State ───────────────────────────────────────────
  const voiceSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [activeSpeakingSection, setActiveSpeakingSection] = useState(null);
  const [availableVoices, setAvailableVoices] = useState([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState('');
  const [speechRate, setSpeechRate] = useState(0.88);
  const [speechPitch, setSpeechPitch] = useState(1.05);
  const [showVoicePanel, setShowVoicePanel] = useState(false);
  const voicePanelRef = useRef(null);

  // ─── Voice Input / Speech Recognition (STT) State ──────────────
  const speechRecSupported = typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
  const [isListening, setIsListening] = useState(false);
  const [micRequesting, setMicRequesting] = useState(false); // true while getUserMedia popup is open
  const [interimTranscript, setInterimTranscript] = useState('');
  const [micError, setMicError] = useState(null);
  const [micPermission, setMicPermission] = useState('unknown'); // 'unknown' | 'granted' | 'denied'
  const recognitionRef = useRef(null);
  const micStreamRef = useRef(null); // holds the getUserMedia stream until recognition starts

  const stepBodyRef = useRef(null);

  // Auto-scroll the tutor panel body to top when step, question, or topic changes
  useEffect(() => {
    if (stepBodyRef.current) {
      stepBodyRef.current.scrollTop = 0;
    }
  }, [step, activeQuizIdx, selectedTopicId]);

  // ─── Load available voices ────────────────────────────────────────
  useEffect(() => {
    if (!voiceSupported) return;
    const loadVoices = () => {
      const all = window.speechSynthesis.getVoices();
      // Prefer English voices; sort to put en-US first
      const english = all.filter(v => v.lang.startsWith('en'));
      const sorted = [
        ...english.filter(v => v.lang === 'en-US'),
        ...english.filter(v => v.lang !== 'en-US'),
      ];
      setAvailableVoices(sorted);
      // Auto-select best instructional voice
      if (!selectedVoiceURI && sorted.length > 0) {
        const preferred = sorted.find(v =>
          v.name.includes('Zira') ||
          v.name.includes('Jenny') ||
          v.name.includes('Aria') ||
          v.name.includes('Google US English') ||
          v.name.includes('Samantha')
        ) || sorted[0];
        setSelectedVoiceURI(preferred.voiceURI);
      }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceSupported]);

  // ─── Stop speech when topic or panel changes ──────────────────────
  useEffect(() => {
    if (voiceSupported) window.speechSynthesis.cancel();
    setIsSpeaking(false);
    setIsPaused(false);
    setActiveSpeakingSection(null);
  }, [selectedTopicId, voiceSupported]);

  // Close voice panel on outside click
  useEffect(() => {
    const handler = (e) => {
      if (voicePanelRef.current && !voicePanelRef.current.contains(e.target)) {
        setShowVoicePanel(false);
      }
    };
    if (showVoicePanel) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showVoicePanel]);

  // ─── Build teacher narration scripts per section ──────────────────
  const buildScript = useCallback((sectionKey, topic) => {
    const t = topic || TUTOR_CURRICULUM[selectedTopicId];
    if (!t) return '';
    switch (sectionKey) {
      case 'whatIsIt':
        return `Let me explain what ${t.title} is. ${t.concept?.whatIsIt || ''}`;
      case 'howItWorks': {
        const steps = (t.concept?.howItWorks || []).map((s, i) =>
          `Step ${i + 1}: ${s.title}. ${s.description}`
        ).join('. ');
        return `Now let me walk you through how ${t.title} works, step by step. ${steps}`;
      }
      case 'realWorldExample':
        return `Here is a real-world analogy to help it click. ${t.concept?.realWorldExample || ''}`;
      case 'diagram':
        return `Now let us look at the visual architecture for ${t.title}. This diagram shows you how all the components connect and interact with each other. Study it carefully as it will help you understand the concept visually.`;
      case 'keyTerms': {
        const terms = (t.concept?.keyTerms || []).slice(0, 4).map(k =>
          `${k.term}: ${k.definition}`
        ).join('. ');
        return `Let us go over some key vocabulary for this topic. ${terms}.`;
      }
      case 'commonMistakes': {
        const mistakes = (t.concept?.commonMistakes || []).map((m, i) =>
          `Mistake ${i + 1}: ${m}`
        ).join('. ');
        return `Pay close attention to these common mistakes that students make. ${mistakes}.`;
      }
      case 'complexity': {
        const tc = t.concept?.timeComplexity;
        const tcStr = typeof tc === 'object' ? (tc?.average || 'O of n') : (tc || 'O of 1');
        const sc = t.concept?.spaceComplexity || 'O of 1';
        return `In terms of performance, the time complexity of ${t.title} is ${tcStr.replace(/O\(/, 'O of ').replace(/\)/, '')}, and the space complexity is ${sc.replace(/O\(/, 'O of ').replace(/\)/, '')}. Keep these in mind when optimizing your code.`;
      }
      case 'quizQuestion': {
        const q = t.quiz?.[activeQuizIdx];
        if (!q) return '';
        const opts = q.options.map((o, i) =>
          `Option ${String.fromCharCode(65 + i)}: ${o}`
        ).join('. ');
        return `Question ${activeQuizIdx + 1} of ${t.quiz.length}. ${q.question}. Your options are: ${opts}. Take your time and pick the best answer.`;
      }
      case 'logicHints':
        return `Here is a hint to help you structure your logic for ${t.title}. ${t.logicHints?.approach || 'Think about the steps involved in solving this problem algorithmically before you write any code.'}. Remember, good logic leads to clean code.`;
      case 'codeChallenge':
        return `Your coding challenge is to implement ${t.title} in C. ${t.concept?.whatIsIt || ''}. Write your solution in the editor below, run it against sample inputs, and then click Verify Solution when you are ready. Good luck!`;
      case 'readAll': {
        if (step === 1) {
          return [
            buildScript('whatIsIt', t),
            buildScript('howItWorks', t),
            buildScript('realWorldExample', t),
            buildScript('keyTerms', t),
            buildScript('commonMistakes', t),
            buildScript('complexity', t),
          ].join('. Next. ');
        }
        if (step === 2) return buildScript('quizQuestion', t);
        if (step === 3) return buildScript('logicHints', t);
        if (step === 4) return buildScript('codeChallenge', t);
        return '';
      }
      default:
        return '';
    }
  }, [selectedTopicId, activeQuizIdx, step]);

  // ─── Core speak function ──────────────────────────────────────────
  const speakSection = useCallback((sectionKey) => {
    if (!voiceSupported) return;
    window.speechSynthesis.cancel();
    const topic = TUTOR_CURRICULUM[selectedTopicId];
    const script = buildScript(sectionKey, topic);
    if (!script) return;

    const utter = new SpeechSynthesisUtterance(script);
    utter.rate = speechRate;
    utter.pitch = speechPitch;
    utter.volume = 1;

    const voice = availableVoices.find(v => v.voiceURI === selectedVoiceURI);
    if (voice) utter.voice = voice;

    utter.onstart = () => { setIsSpeaking(true); setIsPaused(false); setActiveSpeakingSection(sectionKey); };
    utter.onend   = () => { setIsSpeaking(false); setIsPaused(false); setActiveSpeakingSection(null); };
    utter.onerror = () => { setIsSpeaking(false); setIsPaused(false); setActiveSpeakingSection(null); };

    window.speechSynthesis.speak(utter);
  }, [voiceSupported, selectedTopicId, buildScript, speechRate, speechPitch, availableVoices, selectedVoiceURI]);

  const handlePauseResume = useCallback(() => {
    if (!voiceSupported) return;
    if (isPaused) {
      window.speechSynthesis.resume();
      setIsPaused(false);
    } else {
      window.speechSynthesis.pause();
      setIsPaused(true);
    }
  }, [voiceSupported, isPaused]);

  const handleStopSpeech = useCallback(() => {
    if (!voiceSupported) return;
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
    setIsPaused(false);
    setActiveSpeakingSection(null);
  }, [voiceSupported]);

  const handlePreviewVoice = useCallback(() => {
    speakSection && window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(
      `Hello! I am your AI tutor. Let's learn ${TUTOR_CURRICULUM[selectedTopicId]?.title || 'programming'} together.`
    );
    utter.rate = speechRate;
    utter.pitch = speechPitch;
    utter.volume = 1;
    const voice = availableVoices.find(v => v.voiceURI === selectedVoiceURI);
    if (voice) utter.voice = voice;
    window.speechSynthesis.speak(utter);
  }, [selectedVoiceURI, speechRate, speechPitch, availableVoices, selectedTopicId, speakSection]);

  // ─── Speech Recognition (Voice Dictation) Handler ─────────────
  // Step 1: always request getUserMedia first so the browser shows its
  // native permission popup. Only AFTER the user grants (or we detect
  // it was already granted) do we start SpeechRecognition.
  const startRecognitionEngine = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setIsListening(true);
      setMicRequesting(false);
      setInterimTranscript('');
      setMicError(null);
      // Release the getUserMedia stream — recognition has its own track now
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
      }
    };

    recognition.onresult = (event) => {
      let finalChunk = '';
      let currentInterim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalChunk += t + ' ';
        else currentInterim += t;
      }
      if (finalChunk) {
        setLogicText(prev => {
          const trimmed = prev.trim();
          return trimmed ? `${trimmed} ${finalChunk.trim()}` : finalChunk.trim();
        });
      }
      setInterimTranscript(currentInterim);
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setMicPermission('denied');
        setMicError('Microphone access was blocked. Click the 🔒 icon in your browser address bar, set Microphone to Allow, then try again.');
      } else if (event.error === 'audio-capture') {
        setMicError('No microphone detected. Please connect a microphone and try again.');
      } else if (event.error !== 'no-speech') {
        setMicError(`Voice input error: ${event.error}. Please try again.`);
      }
      setIsListening(false);
      setMicRequesting(false);
      setInterimTranscript('');
    };

    recognition.onend = () => {
      setIsListening(false);
      setMicRequesting(false);
      setInterimTranscript('');
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (err) {
      console.error('Failed to start SpeechRecognition:', err);
      setIsListening(false);
      setMicRequesting(false);
      setMicError('Could not start voice input. Please refresh the page and try again.');
    }
  }, []);

  const toggleListening = useCallback(async () => {
    if (!speechRecSupported) {
      setMicError('Speech recognition is not supported in your browser. Please use Google Chrome or Microsoft Edge.');
      return;
    }

    // ── STOP path ──
    if (isListening) {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch (e) { /* ignore */ }
      }
      setIsListening(false);
      setInterimTranscript('');
      return;
    }

    // Don't double-fire while popup is already open
    if (micRequesting) return;

    // Stop TTS so the mic doesn't capture teacher voice
    if (voiceSupported) window.speechSynthesis.cancel();
    setIsSpeaking(false);
    setIsPaused(false);
    setActiveSpeakingSection(null);
    setMicError(null);

    // ── Show "Requesting access" immediately while popup opens ──
    setMicRequesting(true);

    // ── getUserMedia triggers the native browser permission popup ──
    // If already granted: resolves instantly (no popup)
    // If first time / prompt: shows the Allow/Block popup
    // If blocked: throws NotAllowedError
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStreamRef.current = stream;
      setMicPermission('granted');
      // micRequesting stays true until recognition.onstart fires
      startRecognitionEngine();
    } catch (err) {
      const isDenied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
      const isNoMic  = err.name === 'NotFoundError'  || err.name === 'DevicesNotFoundError';
      setMicPermission(isDenied ? 'denied' : 'unknown');
      setMicRequesting(false);
      if (isDenied) {
        setMicError('🔒 Microphone access denied. Click the lock icon in your browser address bar → set Microphone to "Allow" → then click Speak Your Logic again.');
      } else if (isNoMic) {
        setMicError('No microphone found. Please connect a microphone and try again.');
      } else {
        setMicError(`Could not access microphone: ${err.message}`);
      }
    }
  }, [speechRecSupported, isListening, micRequesting, voiceSupported, startRecognitionEngine]);

  // Clean up recognition on unmount or topic change
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch (e) { console.error(e); }
      }
    };
  }, [selectedTopicId]);

  // Retrieve current topic details
  const currentTopic = useMemo(() => {
    return TUTOR_CURRICULUM[selectedTopicId] || TUTOR_CURRICULUM['hello-world'];
  }, [selectedTopicId]);

  // Helper to change topic and reset all step states
  const selectTopic = (topicId) => {
    setSelectedTopicId(topicId);
    setStep(1);
    setQuizAnswers({});
    setQuizSubmitted(false);
    setQuizPassed(false);
    setActiveQuizIdx(0);
    setSelectedOptionIdx(null);
    setIsAnswerChecked(false);
    setLogicText('');
    setLogicResult(null);
    setCodeResult(null);
    setTerminalOutput('');
    setStdinText('');
    setShowSolution(false);
    setIsGeneratingSolution(false);
    setAiSolution(null);
    setIsGeneratingAiSolution(false);

    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch (e) { console.error(e); }
    }
    setIsListening(false);
    setInterimTranscript('');
    setMicError(null);

    const topic = TUTOR_CURRICULUM[topicId] || TUTOR_CURRICULUM['hello-world'];
    if (topic.referenceSolution) {
      const headerLines = topic.referenceSolution.split('\n');
      const includes = headerLines.filter(line => line.startsWith('#include')).join('\n');
      setCodeText(`${includes}\n\nint main() {\n    // Write your code for: ${topic.title}\n    // Refer to Step 1 & 3 concepts\n    \n    return 0;\n}`);
    } else {
      setCodeText('#include <stdio.h>\n\nint main() {\n    \n    return 0;\n}');
    }
    // On mobile: automatically go to the steps view after topic selection
    setMobileTutorView('steps');
  };

  // Handle Search & Level Filtering
  const filteredTopics = useMemo(() => {
    return Object.values(TUTOR_CURRICULUM).filter(topic => {
      const matchesSearch = topic.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            topic.category.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesLevel = selectedLevel === 0 || topic.levelNum === selectedLevel;
      return matchesSearch && matchesLevel;
    });
  }, [searchQuery, selectedLevel]);

  // Step 2 Quiz submission
  const handleSubmitQuiz = () => {
    if (!currentTopic.quiz) return;
    
    // Check if all questions are answered
    const allAnswered = currentTopic.quiz.every(q => quizAnswers[q.id] !== undefined);
    if (!allAnswered) {
      alert("Please answer all questions before submitting.");
      return;
    }

    // Evaluate answers
    const allCorrect = currentTopic.quiz.every(q => {
      const answer = quizAnswers[q.id];
      return answer === q.correct;
    });

    setQuizSubmitted(true);
    if (allCorrect) {
      setQuizPassed(true);
    } else {
      setQuizPassed(false);
    }
  };

  // Step 3 Logic validation call
  const handleValidateLogic = async () => {
    if (!logicText.trim()) {
      alert("Please describe your logic or write pseudocode first.");
      return;
    }

    const stats = analyticsStore.getStats();
    if (analyticsStore.isLimitReached()) {
      setLogicResult({
        correct: false,
        feedback: `You have used ${stats.ai_tokens_used}/${stats.token_limit} tokens according to your limit for AI analysis.`,
        hints: []
      });
      return;
    }

    setIsValidatingLogic(true);
    setLogicResult(null);

    try {
      const userPrompt = `
Concept: ${currentTopic.title}
Category: ${currentTopic.category}
Level: ${currentTopic.levelNum}
Expected Approach: ${currentTopic.logicHints?.approach || ''}

Student's Proposed Logic:
"""
${logicText}
"""
`;

      const responseString = await callClaude(TUTOR_LOGIC_SYSTEM_PROMPT('C'), userPrompt);
      const parsed = parseJSON(responseString);
      setLogicResult(parsed);
    } catch (err) {
      console.error(err);
      if (err.message.includes('Limit Reached') || err.message.includes('limit reached') || analyticsStore.isLimitReached()) {
        setLogicResult({
          correct: false,
          feedback: `You have used ${stats.ai_tokens_used}/${stats.token_limit} tokens according to your limit for AI analysis.`,
          hints: []
        });
      } else {
        setLogicResult({
          correct: false,
          feedback: `Validation failed: ${err.message || err}. Please try again.`,
          hints: ["Make sure the compiler backend/AI endpoint is connected and running."]
        });
      }
    } finally {
      setIsValidatingLogic(false);
    }
  };

  // ── C-language detector ──────────────────────────────────────────
  // Returns the detected language name if clearly non-C, otherwise null.
  const detectNonC = (code) => {
    const stripped = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); // remove comments
    const lines = stripped.split('\n').map(l => l.trim()).filter(Boolean);
    // Python
    if (/^def \w+\s*\(/.test(stripped) || /^import \w/.test(stripped) || /^from \w+ import/.test(stripped) ||
        /^elif /.test(stripped) || /\bprint\s*\(/.test(stripped) && !/printf/.test(stripped)) return 'Python';
    // JavaScript / TypeScript
    if (/\bconsole\.log\s*\(/.test(stripped) || /^(const|let|var) \w+ =/.test(stripped) ||
        /=>/.test(stripped) || /\bfetch\s*\(/.test(stripped)) return 'JavaScript';
    // Java
    if (/\bpublic\s+class\s+\w+/.test(stripped) || /System\.out\.print/.test(stripped) ||
        /\bpublic\s+static\s+void\s+main/.test(stripped)) return 'Java';
    // Python (extra)
    if (/^for \w+ in /.test(stripped) || lines.some(l => l.endsWith(':') && !l.includes('//') && !l.includes(';'))) return 'Python';
    return null;
  };

  // ── AI-personalized solution based on student's current code ──────
  const handleGenerateAiSolution = async () => {
    const stats = analyticsStore.getStats();
    if (analyticsStore.isLimitReached()) {
      setAiSolution({
        c_code: currentTopic.referenceSolution || '',
        explanation: `You have used ${stats.ai_tokens_used}/${stats.token_limit} tokens according to your limit for AI analysis.`,
        steps: []
      });
      return;
    }

    setIsGeneratingAiSolution(true);
    setAiSolution(null);
    try {
      const userPrompt = `
Concept: ${currentTopic.title}
Category: ${currentTopic.category}
Level: ${currentTopic.levelNum}

Student's current code attempt:
"""
${codeText}
"""

Reference solution (do NOT reveal directly, but use it to understand the correct approach):
"""
${currentTopic.referenceSolution}
"""
`;
      const responseString = await callClaude(TUTOR_AI_SOLUTION_PROMPT('C'), userPrompt);
      const parsed = parseJSON(responseString);
      setAiSolution(parsed);
    } catch (err) {
      console.error(err);
      if (err.message.includes('Limit Reached') || err.message.includes('limit reached') || analyticsStore.isLimitReached()) {
        setAiSolution({
          c_code: currentTopic.referenceSolution || '',
          explanation: `You have used ${stats.ai_tokens_used}/${stats.token_limit} tokens according to your limit for AI analysis.`,
          steps: []
        });
      } else {
        setAiSolution({
          c_code: currentTopic.referenceSolution || '',
          explanation: `Could not generate personalized solution: ${err.message}. Showing reference solution instead.`,
          steps: ['Check your network connection and try again.']
        });
      }
    } finally {
      setIsGeneratingAiSolution(false);
    }
  };

  // Step 4 Run Code call
  const handleRunCode = async () => {
    const detected = detectNonC(codeText);
    if (detected) {
      setLangWarning(detected);
      return;
    }
    setLangWarning(null);
    setIsRunningCode(true);
    setTerminalOutput('Compiling and executing code...');

    try {
      const result = await compileC(codeText, stdinText);
      if (result.compileError) {
        setTerminalOutput(`[COMPILE ERROR]\n${result.stderr}`);
      } else {
        let output = '';
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += `\n[STDERR]\n${result.stderr}`;
        if (!result.stdout && !result.stderr) output = '(Program completed with no output)';
        setTerminalOutput(output);
      }
    } catch (err) {
      setTerminalOutput(`Execution failed: ${err.message}`);
    } finally {
      setIsRunningCode(false);
    }
  };

  // Step 4 Code validation call
  const handleVerifyCode = async () => {
    const detected = detectNonC(codeText);
    if (detected) {
      setLangWarning(detected);
      return;
    }
    setLangWarning(null);

    const stats = analyticsStore.getStats();
    if (analyticsStore.isLimitReached()) {
      setCodeResult({
        correct: false,
        feedback: `You have used ${stats.ai_tokens_used}/${stats.token_limit} tokens according to your limit for AI analysis.`,
        issues: []
      });
      return;
    }

    setIsValidatingCode(true);
    setCodeResult(null);

    try {
      const userPrompt = `
Concept: ${currentTopic.title}
Reference Solution:
"""
${currentTopic.referenceSolution}
"""

Student's Submitted Code:
"""
${codeText}
"""
`;

      const responseString = await callClaude(TUTOR_CODE_SYSTEM_PROMPT('C'), userPrompt);
      const parsed = parseJSON(responseString);
      setCodeResult(parsed);

      if (parsed.correct) {
        // Mark topic completed
        setCompletedTopics(prev => {
          const next = new Set(prev);
          next.add(selectedTopicId);
          return next;
        });
        setShowCompletionModal(true);
      }
    } catch (err) {
      console.error(err);
      if (err.message.includes('Limit Reached') || err.message.includes('limit reached') || analyticsStore.isLimitReached()) {
        setCodeResult({
          correct: false,
          feedback: `You have used ${stats.ai_tokens_used}/${stats.token_limit} tokens according to your limit for AI analysis.`,
          issues: []
        });
      } else {
        setCodeResult({
          correct: false,
          feedback: `Verification failed: ${err.message || err}. Please try again.`,
          issues: [{ line: null, description: "Check connection to backend / Groq AI proxy." }]
        });
      }
    } finally {
      setIsValidatingCode(false);
    }
  };

  // Navigate to next topic when done
  const handleNextTopic = () => {
    setShowCompletionModal(false);
    const topicListArray = Object.keys(TUTOR_CURRICULUM);
    const currIdx = topicListArray.indexOf(selectedTopicId);
    if (currIdx !== -1 && currIdx < topicListArray.length - 1) {
      selectTopic(topicListArray[currIdx + 1]);
    } else {
      // Loop back to start or keep same
      selectTopic(topicListArray[0]);
    }
  };

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.tutorContainer} data-mobile-view={mobileTutorView}>
        
        {/* ─── Sidebar (Topic Picker) ─── */}
        <div className={styles.sidebar} data-mobile-hidden={mobileTutorView === 'steps' ? 'true' : 'false'}>

          {/* Mobile-only header bar for topic picker screen */}
          <div className={styles.mobileSidebarHeader}>
            <span className={styles.mobileSidebarTitle}>📚 AI Study Tutor</span>
            <button className={styles.mobileSidebarClose} onClick={onClose} aria-label="Close">✕</button>
          </div>

          <div className={styles.sidebarHeader}>
            <div className={styles.sidebarTitle}>
              <span>AI Study Tutor</span>
            </div>
            
            {/* Search */}
            <div className={styles.searchBar}>
              <input 
                type="text" 
                placeholder="Search concepts..." 
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className={styles.searchInput}
              />
            </div>
          </div>

          {/* Level Filter Tabs */}
          <div className={styles.levelTabs}>
            <button 
              className={`${styles.levelTab} ${selectedLevel === 0 ? styles.levelTabActive : ''}`}
              style={{ backgroundColor: selectedLevel === 0 ? '#4f46e5' : '#f1f5f9', color: selectedLevel === 0 ? '#ffffff' : '#475569' }}
              onClick={() => setSelectedLevel(0)}
            >
              All
            </button>
            {Object.entries(TUTOR_LEVELS).map(([levelNum, lvl]) => (
              <button
                key={levelNum}
                className={`${styles.levelTab} ${selectedLevel === Number(levelNum) ? styles.levelTabActive : ''}`}
                style={{
                  backgroundColor: selectedLevel === Number(levelNum) ? lvl.color : '#f1f5f9',
                  color: selectedLevel === Number(levelNum) ? '#ffffff' : '#475569'
                }}
                onClick={() => setSelectedLevel(Number(levelNum))}
              >
                Lvl {levelNum}
              </button>
            ))}
          </div>

          {/* Topic List */}
          <div className={styles.topicList}>
            {filteredTopics.length === 0 ? (
              <div className={styles.searchEmpty}>No topics match your filter.</div>
            ) : (
              filteredTopics.map(topic => {
                const isActive = topic.id === selectedTopicId;
                const isDone = completedTopics.has(topic.id);
                const lvlColor = TUTOR_LEVELS[topic.levelNum]?.color || '#6366f1';
                
                return (
                  <div
                    key={topic.id}
                    className={`${styles.topicCard} ${isActive ? styles.topicCardActive : ''}`}
                    onClick={() => selectTopic(topic.id)}
                    style={{ borderLeft: `4px solid ${lvlColor}` }}
                  >
                    {topic.icon && <span className={styles.topicIcon}>{topic.icon}</span>}
                    <div className={styles.topicMeta}>
                      <div className={styles.topicTitle}>{topic.title}</div>
                      <div className={styles.topicSub}>
                        <span>{topic.category}</span>
                        <span>•</span>
                        <span>{topic.estimatedTime}</span>
                      </div>
                    </div>
                    {isDone && <span className={styles.topicCheck}>✓</span>}
                    {/* Mobile chevron — signals tap to navigate */}
                    <span className={styles.topicChevron} aria-hidden="true">›</span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ─── Main Panel Content ─── */}
        <div className={styles.mainContent} data-mobile-hidden={mobileTutorView === 'topics' ? 'true' : 'false'}>
          
          {/* Mobile-only top navigation bar for steps view */}
          <div className={styles.mobileStepsHeader}>
            <button
              className={styles.mobileBackBtn}
              onClick={() => setMobileTutorView('topics')}
              aria-label="Back to topics"
            >
              ‹ Topics
            </button>
            <span className={styles.mobileStepsTitle}>{currentTopic.icon} {currentTopic.title}</span>
            <button
              className={styles.mobileStepsClose}
              onClick={() => { handleStopSpeech(); onClose(); }}
              aria-label="Close"
            >✕</button>
          </div>

          {/* Header */}
          <div className={styles.mainHeader}>
            <div className={styles.headerLeft}>
              <span 
                className={styles.headerCategoryBadge}
                style={{ 
                  backgroundColor: `${TUTOR_LEVELS[currentTopic.levelNum]?.color}15`, 
                  color: TUTOR_LEVELS[currentTopic.levelNum]?.color 
                }}
              >
                Level {currentTopic.levelNum} • {currentTopic.category}
              </span>
              <h1 className={styles.headerTitle}>
                {currentTopic.icon && <span className={styles.headerIcon}>{currentTopic.icon}</span>}
                {currentTopic.title}
              </h1>
            </div>

            {/* ── Voice Controls (right side of header) ── */}
            <div className={styles.headerRight}>
              {voiceSupported && (
                <>
                  {/* Playback Controls — shown only while speaking */}
                  {isSpeaking && (
                    <div className={styles.playbackControls}>
                      <span className={styles.nowPlayingLabel}>
                        <span className={styles.soundWave} aria-hidden="true">
                          <span className={styles.soundWaveBar} />
                          <span className={styles.soundWaveBar} />
                          <span className={styles.soundWaveBar} />
                          <span className={styles.soundWaveBar} />
                          <span className={styles.soundWaveBar} />
                        </span>
                        Speaking
                      </span>
                      <button
                        className={styles.playbackBtn}
                        onClick={handlePauseResume}
                        title={isPaused ? 'Resume' : 'Pause'}
                      >
                        {isPaused ? '▶' : '⏸'}
                      </button>
                      <button
                        className={`${styles.playbackBtn} ${styles.playbackBtnStop}`}
                        onClick={handleStopSpeech}
                        title="Stop"
                      >
                        ⏹
                      </button>
                    </div>
                  )}

                  {/* Read All Button */}
                  <button
                    className={`${styles.readAllBtn} ${isSpeaking && activeSpeakingSection === 'readAll' ? styles.readAllBtnActive : ''}`}
                    onClick={() => isSpeaking && activeSpeakingSection === 'readAll' ? handleStopSpeech() : speakSection('readAll')}
                    title="Read entire section aloud"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    </svg>
                    Read All
                  </button>

                  {/* Voice Settings gear */}
                  <div className={styles.voicePanelWrapper} ref={voicePanelRef}>
                    <button
                      className={`${styles.voiceGearBtn} ${showVoicePanel ? styles.voiceGearBtnActive : ''}`}
                      onClick={() => setShowVoicePanel(p => !p)}
                      title="Voice settings"
                    >
                      ⚙️
                    </button>

                    {showVoicePanel && (
                      <div className={styles.voicePanel}>
                        <div className={styles.voicePanelHeader}>
                          <span>🎙️ Voice Settings</span>
                          <button className={styles.voicePanelClose} onClick={() => setShowVoicePanel(false)}>✕</button>
                        </div>

                        {/* Voice selector */}
                        <div className={styles.voicePanelRow}>
                          <label className={styles.voicePanelLabel}>Voice</label>
                          <select
                            className={styles.voicePanelSelect}
                            value={selectedVoiceURI}
                            onChange={e => setSelectedVoiceURI(e.target.value)}
                          >
                            {availableVoices.length === 0 && (
                              <option value="">Loading voices...</option>
                            )}
                            {availableVoices.map(v => (
                              <option key={v.voiceURI} value={v.voiceURI}>
                                {v.name} ({v.lang})
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* Speed slider */}
                        <div className={styles.voicePanelRow}>
                          <label className={styles.voicePanelLabel}>
                            Speed <span className={styles.voicePanelValue}>{speechRate.toFixed(2)}x</span>
                          </label>
                          <input
                            type="range"
                            min="0.6" max="1.4" step="0.05"
                            value={speechRate}
                            onChange={e => setSpeechRate(Number(e.target.value))}
                            className={styles.voicePanelSlider}
                          />
                          <div className={styles.voiceSliderTicks}>
                            <span>Slow</span><span>Fast</span>
                          </div>
                        </div>

                        {/* Pitch slider */}
                        <div className={styles.voicePanelRow}>
                          <label className={styles.voicePanelLabel}>
                            Pitch <span className={styles.voicePanelValue}>{speechPitch.toFixed(2)}</span>
                          </label>
                          <input
                            type="range"
                            min="0.7" max="1.4" step="0.05"
                            value={speechPitch}
                            onChange={e => setSpeechPitch(Number(e.target.value))}
                            className={styles.voicePanelSlider}
                          />
                          <div className={styles.voiceSliderTicks}>
                            <span>Deep</span><span>High</span>
                          </div>
                        </div>

                        {/* Preview button */}
                        <button className={styles.voicePreviewBtn} onClick={handlePreviewVoice}>
                          ▶ Preview Voice
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Close button */}
              <button className={styles.closeButton} onClick={() => { handleStopSpeech(); onClose(); }}>✕</button>
            </div>
          </div>

          {/* Step Progress Navigator */}
          <div className={styles.stepNav}>
            <button 
              type="button"
              className={`${styles.stepNavItem} ${step === 1 ? styles.stepNavActive : ''} ${step > 1 ? styles.stepNavDone : ''}`}
              onClick={() => setStep(1)}
            >
              <span className={styles.stepNumber}>{step > 1 ? '✓' : '1'}</span>
              <span className={styles.stepLabelFull}>Learn Concept</span>
              <span className={styles.stepLabelShort}>Concept</span>
            </button>
            <div className={styles.stepNavSeparator} />
            <button 
              type="button"
              className={`${styles.stepNavItem} ${step === 2 ? styles.stepNavActive : ''} ${step > 2 ? styles.stepNavDone : ''}`}
              onClick={() => setStep(2)}
            >
              <span className={styles.stepNumber}>{step > 2 ? '✓' : '2'}</span>
              <span className={styles.stepLabelFull}>Test Knowledge</span>
              <span className={styles.stepLabelShort}>Quiz</span>
            </button>
            <div className={styles.stepNavSeparator} />
            <button 
              type="button"
              className={`${styles.stepNavItem} ${step === 3 ? styles.stepNavActive : ''} ${step > 3 ? styles.stepNavDone : ''}`}
              onClick={() => setStep(3)}
            >
              <span className={styles.stepNumber}>{step > 3 ? '✓' : '3'}</span>
              <span className={styles.stepLabelFull}>Verify Logic</span>
              <span className={styles.stepLabelShort}>Logic</span>
            </button>
            <div className={styles.stepNavSeparator} />
            <button 
              type="button"
              className={`${styles.stepNavItem} ${step === 4 ? styles.stepNavActive : ''} ${step > 4 ? styles.stepNavDone : ''}`}
              onClick={() => setStep(4)}
            >
              <span className={styles.stepNumber}>{step > 4 ? '✓' : '4'}</span>
              <span className={styles.stepLabelFull}>Code Solution</span>
              <span className={styles.stepLabelShort}>Code</span>
            </button>
          </div>

          {/* Scrollable Step Content */}
          <div ref={stepBodyRef} className={styles.stepBody}>
            
            {/* STEP 1: LEARN CONCEPT */}
            {step === 1 && (
              <div className={styles.conceptGrid}>
                {/* Left Side: Summary & Explanation */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div className={`${styles.card} ${activeSpeakingSection === 'whatIsIt' ? styles.cardSpeaking : ''}`}>
                    <h2 className={styles.cardTitle}>
                      What is it?
                      <SpeakerBtn sectionKey="whatIsIt" activeSpeakingSection={activeSpeakingSection} onSpeak={speakSection} onStop={handleStopSpeech} isSpeaking={isSpeaking} />
                    </h2>
                    <p className={styles.whatIsItText}>{currentTopic.concept.whatIsIt}</p>
                  </div>

                  <div className={`${styles.card} ${activeSpeakingSection === 'howItWorks' ? styles.cardSpeaking : ''}`}>
                    <h2 className={styles.cardTitle}>
                      How it works
                      <SpeakerBtn sectionKey="howItWorks" activeSpeakingSection={activeSpeakingSection} onSpeak={speakSection} onStop={handleStopSpeech} isSpeaking={isSpeaking} />
                    </h2>
                    <div className={styles.howItWorksList}>
                      {currentTopic.concept.howItWorks.map((step, idx) => (
                        <div key={idx} className={styles.howItWorksItem}>
                          <span className={styles.howItWorksNum}>{step.step}</span>
                          <div>
                            <div className={styles.howItWorksTitle}>{step.title}</div>
                            <div className={styles.howItWorksDesc}>{step.description}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={`${styles.card} ${activeSpeakingSection === 'realWorldExample' ? styles.cardSpeaking : ''}`}>
                    <h2 className={styles.cardTitle}>
                      Real-world Analogy
                      <SpeakerBtn sectionKey="realWorldExample" activeSpeakingSection={activeSpeakingSection} onSpeak={speakSection} onStop={handleStopSpeech} isSpeaking={isSpeaking} />
                    </h2>
                    <p className={styles.whatIsItText} style={{ fontStyle: 'italic', color: '#4f46e5' }}>
                      "{currentTopic.concept.realWorldExample}"
                    </p>
                  </div>
                </div>

                {/* Right Side: Diagrams & Meta */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  {/* Visual Diagram */}
                  <div className={`${styles.card} ${activeSpeakingSection === 'diagram' ? styles.cardSpeaking : ''}`}>
                    <h2 className={styles.cardTitle}>
                      Visual Architecture
                      <SpeakerBtn sectionKey="diagram" activeSpeakingSection={activeSpeakingSection} onSpeak={speakSection} onStop={handleStopSpeech} isSpeaking={isSpeaking} />
                    </h2>
                    <TutorDiagram type={currentTopic.id} />
                  </div>

                  {/* Key Terms Grid */}
                  <div className={`${styles.card} ${activeSpeakingSection === 'keyTerms' ? styles.cardSpeaking : ''}`}>
                    <h2 className={styles.cardTitle}>
                      Key Vocabulary
                      <SpeakerBtn sectionKey="keyTerms" activeSpeakingSection={activeSpeakingSection} onSpeak={speakSection} onStop={handleStopSpeech} isSpeaking={isSpeaking} />
                    </h2>
                    <div className={styles.keyTermsGrid}>
                      {currentTopic.concept.keyTerms.slice(0, 4).map((term, idx) => (
                        <div key={idx} className={styles.termCard}>
                          <div className={styles.termWord}>{term.term}</div>
                          <div className={styles.termDef}>{term.definition}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Common Mistakes */}
                  <div className={`${styles.card} ${activeSpeakingSection === 'commonMistakes' ? styles.cardSpeaking : ''}`}>
                    <h2 className={styles.cardTitle}>
                      Common Mistakes
                      <SpeakerBtn sectionKey="commonMistakes" activeSpeakingSection={activeSpeakingSection} onSpeak={speakSection} onStop={handleStopSpeech} isSpeaking={isSpeaking} />
                    </h2>
                    <div className={styles.mistakesList}>
                      {currentTopic.concept.commonMistakes.map((mistake, idx) => (
                        <div key={idx} className={styles.mistakeItem}>
                          <span className={styles.mistakeBullet}>•</span>
                          <span>{mistake}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Complexity Stats */}
                  <div className={`${styles.card} ${activeSpeakingSection === 'complexity' ? styles.cardSpeaking : ''}`}>
                    <h2 className={styles.cardTitle}>
                      Complexities
                      <SpeakerBtn sectionKey="complexity" activeSpeakingSection={activeSpeakingSection} onSpeak={speakSection} onStop={handleStopSpeech} isSpeaking={isSpeaking} />
                    </h2>
                    <div className={styles.metaGrid}>
                      <div className={styles.metaBox}>
                        <div className={styles.metaLabel}>Time Complexity</div>
                        <div className={styles.metaValue}>
                          {typeof currentTopic.concept.timeComplexity === 'object' 
                            ? currentTopic.concept.timeComplexity?.average || 'O(n)' 
                            : currentTopic.concept.timeComplexity || 'O(1)'}
                        </div>
                      </div>
                      <div className={styles.metaBox}>
                        <div className={styles.metaLabel}>Space Complexity</div>
                        <div className={styles.metaValue}>{currentTopic.concept.spaceComplexity}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* STEP 2: TEST KNOWLEDGE */}
            {step === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '640px', margin: '0 auto', width: '100%' }}>
                {activeQuizIdx < currentTopic.quiz.length ? (
                  // Single Question View
                  (() => {
                    const q = currentTopic.quiz[activeQuizIdx];
                    if (!q) return null;
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {/* Progress Indicator */}
                        <div className={styles.card} style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', color: '#475569', fontWeight: '700' }}>
                            <span>Question {activeQuizIdx + 1} of {currentTopic.quiz.length}</span>
                            <span style={{
                              padding: '4px 10px',
                              borderRadius: '9999px',
                              background: q.difficulty === 'hard' ? '#fee2e2' : (q.difficulty === 'medium' ? '#ffedd5' : '#dcfce7'),
                              color: q.difficulty === 'hard' ? '#991b1b' : (q.difficulty === 'medium' ? '#9a3412' : '#166534'),
                              fontWeight: '800',
                              fontSize: '11px',
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em'
                            }}>
                              {q.difficulty}
                            </span>
                          </div>
                          
                          {/* Visual progress bar */}
                          <div style={{
                            height: '8px',
                            background: '#e2e8f0',
                            borderRadius: '9999px',
                            width: '100%',
                            position: 'relative',
                            overflow: 'hidden'
                          }}>
                            <div style={{
                              height: '100%',
                              background: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
                              width: `${((activeQuizIdx) / currentTopic.quiz.length) * 100}%`,
                              transition: 'width 0.3s ease-in-out',
                              borderRadius: '9999px'
                            }} />
                          </div>
                        </div>

                        {/* Question Card */}
                        <div className={`${styles.card} ${styles.quizCard} ${activeSpeakingSection === 'quizQuestion' ? styles.cardSpeaking : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                          <h2 className={styles.quizQuestion} style={{ margin: 0, fontSize: '17px', lineHeight: '1.4', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                            <span style={{ flex: 1 }}>{q.question}</span>
                            <SpeakerBtn sectionKey="quizQuestion" activeSpeakingSection={activeSpeakingSection} onSpeak={speakSection} onStop={handleStopSpeech} isSpeaking={isSpeaking} />
                          </h2>
                          
                          <div className={styles.quizOptions} style={{ margin: 0 }}>
                            {q.options.map((option, optIdx) => {
                              const isSelected = selectedOptionIdx === optIdx;
                              const isCorrect = q.correct === optIdx;
                              let optionClass = styles.quizOption;
                              
                              if (isAnswerChecked) {
                                if (isCorrect) optionClass += ` ${styles.quizOptionCorrect}`;
                                else if (isSelected) optionClass += ` ${styles.quizOptionIncorrect}`;
                              } else if (isSelected) {
                                optionClass += ` ${styles.quizOptionSelected}`;
                              }

                              return (
                                <button
                                  key={optIdx}
                                  disabled={isAnswerChecked}
                                  className={optionClass}
                                  onClick={() => setSelectedOptionIdx(optIdx)}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '16px',
                                    borderWidth: '2px',
                                    transition: 'all 0.15s ease',
                                    cursor: isAnswerChecked ? 'default' : 'pointer'
                                  }}
                                >
                                  <span style={{ flex: 1, paddingRight: '12px' }}>{option}</span>
                                  {isAnswerChecked && isCorrect && (
                                    <span style={{
                                      width: '24px',
                                      height: '24px',
                                      borderRadius: '50%',
                                      background: '#d1fae5',
                                      color: '#065f46',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontWeight: '800',
                                      fontSize: '14px',
                                      flexShrink: 0
                                    }}>✓</span>
                                  )}
                                  {isAnswerChecked && isSelected && !isCorrect && (
                                    <span style={{
                                      width: '24px',
                                      height: '24px',
                                      borderRadius: '50%',
                                      background: '#fee2e2',
                                      color: '#991b1b',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontWeight: '800',
                                      fontSize: '14px',
                                      flexShrink: 0
                                    }}>✗</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>

                          {isAnswerChecked && (
                            <div className={`${styles.quizFeedback} ${selectedOptionIdx === q.correct ? styles.quizFeedbackCorrect : styles.quizFeedbackIncorrect}`} style={{ margin: 0 }}>
                              <strong>{selectedOptionIdx === q.correct ? '✓ Correct! ' : '✗ Incorrect. '}</strong>
                              {q.explanation}
                            </div>
                          )}

                          <div style={{ marginTop: '8px' }}>
                            {!isAnswerChecked ? (
                              <button
                                className={styles.primaryButton}
                                disabled={selectedOptionIdx === null}
                                onClick={() => {
                                  setIsAnswerChecked(true);
                                  setQuizAnswers(prev => ({ ...prev, [q.id]: selectedOptionIdx }));
                                }}
                                style={{ width: '100%', justifyContent: 'center' }}
                              >
                                Check Answer
                              </button>
                            ) : (
                              <button
                                className={styles.primaryButton}
                                style={{ width: '100%', justifyContent: 'center', background: '#10b981', boxShadow: '0 4px 12px rgba(16, 185, 129, 0.25)' }}
                                onClick={() => {
                                  if (activeQuizIdx === currentTopic.quiz.length - 1) {
                                    // Submit entire quiz
                                    const allCorrect = currentTopic.quiz.every(question => {
                                      const ans = question.id === q.id ? selectedOptionIdx : quizAnswers[question.id];
                                      return ans === question.correct;
                                    });
                                    setQuizPassed(allCorrect);
                                    setQuizSubmitted(true);
                                    setActiveQuizIdx(currentTopic.quiz.length);
                                  } else {
                                    setActiveQuizIdx(prev => prev + 1);
                                    setSelectedOptionIdx(null);
                                    setIsAnswerChecked(false);
                                  }
                                }}
                              >
                                {activeQuizIdx === currentTopic.quiz.length - 1 ? 'Finish Quiz →' : 'Continue →'}
                              </button>
                            )}
                          </div>

                        </div>
                      </div>
                    );
                  })()
                ) : (
                  // Quiz Summary Screen
                  (() => {
                    const score = currentTopic.quiz.filter(question => quizAnswers[question.id] === question.correct).length;
                    const total = currentTopic.quiz.length;
                    const percentage = Math.round((score / total) * 100);
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                        <div className={styles.card} style={{ textAlign: 'center', padding: '36px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                          <div style={{ fontSize: '48px', animation: 'bounce 1.5s infinite' }}>
                            {score === total ? '★' : (score >= total * 0.6 ? '◆' : '○')}
                          </div>
                          
                          <h2 style={{ fontSize: '22px', fontWeight: '800', color: '#0f172a', margin: 0 }}>
                            {score === total ? 'Perfect Score!' : 'Quiz Completed!'}
                          </h2>

                          {/* Circular progress circle */}
                          <div style={{
                            position: 'relative',
                            width: '120px',
                            height: '120px',
                            borderRadius: '50%',
                            background: `conic-gradient(#10b981 ${percentage}%, #e2e8f0 0)`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                            margin: '10px 0'
                          }}>
                            <div style={{
                              width: '98px',
                              height: '98px',
                              borderRadius: '50%',
                              background: '#ffffff',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'center'
                            }}>
                              <span style={{ fontSize: '26px', fontWeight: '800', color: '#0f172a' }}>{score}/{total}</span>
                              <span style={{ fontSize: '11px', color: '#64748b', fontWeight: '800' }}>{percentage}% CORRECT</span>
                            </div>
                          </div>

                          <p className={styles.whatIsItText} style={{ margin: 0, color: '#475569' }}>
                            {score === total 
                              ? 'Unbelievable job! You got every question correct. You are fully prepared to start the practical steps.' 
                              : (score >= total * 0.6 
                                ? 'Well done! You got a solid grasp of this concept. Feel free to review your mistakes or proceed.' 
                                : 'Take some time to review the concepts and try again to improve your score.')
                            }
                          </p>

                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            fontSize: '12.5px',
                            color: '#4f46e5',
                            fontWeight: '700',
                            marginTop: '4px',
                            background: '#e0e7ff',
                            padding: '6px 16px',
                            borderRadius: '9999px',
                            animation: 'pulse 2s infinite ease-in-out'
                          }}>
                            <span>Scroll down to review detailed questions and explanations</span>
                          </div>

                          <div style={{ display: 'flex', gap: '12px', width: '100%', marginTop: '8px' }}>
                            <button
                              className={styles.secondaryButton}
                              onClick={() => {
                                setQuizAnswers({});
                                setQuizSubmitted(false);
                                setQuizPassed(false);
                                setActiveQuizIdx(0);
                                setSelectedOptionIdx(null);
                                setIsAnswerChecked(false);
                              }}
                              style={{ flex: 1, padding: '14px' }}
                            >
                              Retry Quiz
                            </button>
                            <button
                              className={styles.primaryButton}
                              style={{ background: '#10b981', flex: 1, justifyContent: 'center', padding: '14px', boxShadow: '0 4px 12px rgba(16, 185, 129, 0.25)' }}
                              onClick={() => {
                                setStep(3);
                              }}
                            >
                              Next: Validate Logic →
                            </button>
                          </div>
                        </div>

                        {/* Mistakes / Questions Review Panel */}
                        <div className={styles.card} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                          <h3 style={{ fontSize: '15px', fontWeight: '800', color: '#1e293b', margin: 0, borderBottom: '1px solid #f1f5f9', paddingBottom: '10px' }}>
                            Questions Review
                          </h3>
                          
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            {currentTopic.quiz.map((question, idx) => {
                              const uAns = quizAnswers[question.id];
                              const isCorrect = uAns === question.correct;
                              return (
                                <div 
                                  key={question.id} 
                                  style={{
                                    border: '1.5px solid',
                                    borderColor: isCorrect ? '#a7f3d0' : '#fca5a5',
                                    borderRadius: '12px',
                                    padding: '16px',
                                    backgroundColor: isCorrect ? '#f0fdf4' : '#fef2f2',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '10px'
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                                    <span style={{
                                      width: '20px',
                                      height: '20px',
                                      borderRadius: '50%',
                                      background: isCorrect ? '#d1fae5' : '#fee2e2',
                                      color: isCorrect ? '#065f46' : '#991b1b',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontSize: '11px',
                                      fontWeight: '800',
                                      flexShrink: 0,
                                      marginTop: '2px'
                                    }}>
                                      {idx + 1}
                                    </span>
                                    <span style={{ fontSize: '14px', fontWeight: '700', color: '#1e293b' }}>
                                      {question.question}
                                    </span>
                                  </div>

                                  <div style={{ fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '4px', paddingLeft: '28px' }}>
                                    <div style={{ color: isCorrect ? '#047857' : '#b91c1c' }}>
                                      <strong>Your Answer:</strong> {question.options[uAns] || 'Unanswered'}
                                    </div>
                                    {!isCorrect && (
                                      <div style={{ color: '#047857' }}>
                                        <strong>Correct Answer:</strong> {question.options[question.correct]}
                                      </div>
                                    )}
                                  </div>

                                  <div style={{ 
                                    fontSize: '12.5px', 
                                    color: '#475569', 
                                    borderTop: '1px dashed',
                                    borderColor: isCorrect ? '#a7f3d0' : '#fca5a5',
                                    paddingTop: '8px', 
                                    paddingLeft: '28px' 
                                  }}>
                                    {question.explanation}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })()
                )}
              </div>
            )}

            {/* STEP 3: LOGIC VALIDATION */}
            {step === 3 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '800px', width: '100%', margin: '0 auto' }}>
                <div className={`${styles.card} ${activeSpeakingSection === 'logicHints' ? styles.cardSpeaking : ''}`}>
                  <h2 className={styles.cardTitle}>
                    Describe Your Logic
                    <SpeakerBtn sectionKey="logicHints" activeSpeakingSection={activeSpeakingSection} onSpeak={speakSection} onStop={handleStopSpeech} isSpeaking={isSpeaking} />
                  </h2>
                  <p className={styles.whatIsItText} style={{ marginBottom: '16px' }}>
                    Describe your algorithm, pseudocode, or step-by-step approach to solve the <strong>{currentTopic.title}</strong> challenge. 
                    You can type below or click <strong>🎙️ Speak Your Logic</strong> to describe it out loud!
                  </p>
                  
                  {/* Voice Dictation Control Bar */}
                  <div className={styles.voiceDictationBar}>
                    <button
                      type="button"
                      className={`${styles.micDictateBtn}
                        ${isListening ? styles.micDictateBtnActive : ''}
                        ${micRequesting ? styles.micDictateBtnRequesting : ''}
                        ${micPermission === 'denied' && !micRequesting ? styles.micDictateBtnDenied : ''}`}
                      onClick={toggleListening}
                      disabled={micRequesting}
                      title={
                        isListening ? 'Click to stop listening' :
                        micRequesting ? 'Waiting for microphone permission...' :
                        micPermission === 'denied' ? 'Mic blocked — click to retry after allowing access in browser settings' :
                        'Click to speak your logic — browser will ask for microphone permission'
                      }
                    >
                      {isListening ? (
                        <>
                          <span className={styles.micPulseDot} />
                          ⏹ Stop Listening
                        </>
                      ) : micRequesting ? (
                        <>
                          <span className={styles.micSpinner} />
                          Requesting mic access...
                        </>
                      ) : micPermission === 'denied' ? (
                        <>
                          🔒 Mic Blocked — Click to Retry
                        </>
                      ) : (
                        <>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                            <line x1="12" y1="19" x2="12" y2="22"/>
                          </svg>
                          🎙️ Speak Your Logic
                        </>
                      )}
                    </button>

                    {logicText && !isListening && !micRequesting && (
                      <button
                        type="button"
                        className={styles.clearDictationBtn}
                        onClick={() => { setLogicText(''); setInterimTranscript(''); }}
                        title="Clear text"
                      >
                        Clear Text
                      </button>
                    )}
                  </div>

                  {/* Permission request in-progress banner */}
                  {micRequesting && (
                    <div className={styles.micRequestingBanner}>
                      <span className={styles.micRequestingSpinnerRing} />
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '13px' }}>Waiting for your permission...</div>
                        <div style={{ fontSize: '12px', opacity: 0.85, marginTop: '2px' }}>
                          A browser popup is asking for microphone access. Click <strong>Allow</strong> to start recording.
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Live Interim Transcript Banner */}
                  {isListening && (
                    <div className={styles.interimBanner}>
                      <span className={styles.interimPulseRing} />
                      <div style={{ flex: 1 }}>
                        <div className={styles.interimStatusText}>
                          🎤 Listening... Speak your algorithm out loud.
                        </div>
                        {interimTranscript ? (
                          <div className={styles.interimLiveText}>
                            &ldquo;{interimTranscript}&rdquo;
                          </div>
                        ) : (
                          <div className={styles.interimLiveText} style={{ opacity: 0.7 }}>
                            (Say something like: &ldquo;First I will read the input. Then I will loop from 1 to N...&rdquo;)
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Mic Error Banner */}
                  {micError && !micRequesting && (
                    <div className={`${styles.micErrorBanner} ${micPermission === 'denied' ? styles.micErrorBannerDenied : ''}`}>
                      {micError}
                    </div>
                  )}

                  <textarea
                    className={styles.tutorTextarea}
                    placeholder="Example: First, read the input. Then, loop from 1 to n. Check if n is divisible... (Or click Speak Your Logic above to dictate using your voice!)"
                    value={logicText}
                    onChange={e => setLogicText(e.target.value)}
                  />

                  <div className={styles.actionRow}>
                    <button
                      className={`${styles.primaryButton} ${isValidatingLogic ? styles.buttonDisabled : ''}`}
                      onClick={handleValidateLogic}
                    >
                      {isValidatingLogic ? (
                        <>
                          <div className={styles.loadingSpinner} />
                          Validating logic...
                        </>
                      ) : (
                        'Validate Logic'
                      )}
                    </button>
                  </div>
                </div>

                {/* AI logic feedback card */}
                {logicResult && (
                  <div className={`${styles.validationBox} ${logicResult.correct ? styles.validationSuccess : styles.validationFailure}`}>
                    <h3 style={{ fontSize: '15px', fontWeight: '800', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      {logicResult.correct ? 'Logic Approved!' : 'Logic Review Needed'}
                    </h3>
                    <p style={{ fontSize: '13.5px', lineHeight: '1.5' }}>{logicResult.feedback}</p>
                    
                    {logicResult.hints && logicResult.hints.length > 0 && (
                      <div>
                        <h4 className={styles.hintsTitle}>Suggestions to improve:</h4>
                        <ul className={styles.hintsList}>
                          {logicResult.hints.map((hint, idx) => (
                            <li key={idx} className={styles.hintItem}>{hint}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {!logicResult.correct && (
                      <div style={{
                        marginTop: '12px',
                        padding: '10px',
                        borderRadius: '6px',
                        backgroundColor: 'rgba(239, 68, 68, 0.05)',
                        border: '1px dashed #ef4444',
                        color: '#991b1b',
                        fontSize: '13px'
                      }}>
                        <strong>Tip:</strong> You can revise your explanation to try again, or click the button below to proceed to the coding stage anyway.
                      </div>
                    )}

                    {logicResult && (
                      <button
                        className={styles.primaryButton}
                        style={{ marginTop: '16px', background: '#10b981' }}
                        onClick={() => setStep(4)}
                      >
                        Next: Code Solution →
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* STEP 4: CODE SOLUTION */}
            {step === 4 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div className={`${styles.card} ${activeSpeakingSection === 'codeChallenge' ? styles.cardSpeaking : ''}`}>
                  <h2 className={styles.cardTitle}>
                    Implement in C
                    <SpeakerBtn sectionKey="codeChallenge" activeSpeakingSection={activeSpeakingSection} onSpeak={speakSection} onStop={handleStopSpeech} isSpeaking={isSpeaking} />
                  </h2>
                  <p className={styles.whatIsItText} style={{ marginBottom: '16px' }}>
                    Write your C solution for <strong>{currentTopic.title}</strong>.
                    Run it against inputs, then verify with AI. Need help? Use <strong>Give Full Solution</strong> below.
                  </p>

                  <TutorCodeEditor
                    code={codeText}
                    onChange={(v) => { setCodeText(v); setLangWarning(null); }}
                  />

                  {/* Language warning banner */}
                  {langWarning && (
                    <div style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '12px',
                      background: '#fff7ed',
                      border: '1.5px solid #fb923c',
                      borderLeft: '4px solid #ea580c',
                      borderRadius: '10px',
                      padding: '14px 16px',
                      marginTop: '12px',
                      animation: 'slideInUp 250ms ease'
                    }}>
                      <span style={{ fontSize: '20px', lineHeight: 1 }}>⚠️</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, fontSize: '13.5px', color: '#9a3412', marginBottom: '4px' }}>
                          {langWarning} code detected — please write C only!
                        </div>
                        <div style={{ fontSize: '12.5px', color: '#c2410c', lineHeight: 1.45 }}>
                          This is a C programming course. Your editor must contain valid C code (using <code style={{ fontFamily: 'JetBrains Mono, monospace', background: '#fed7aa', padding: '1px 4px', borderRadius: '4px' }}>#include</code>, <code style={{ fontFamily: 'JetBrains Mono, monospace', background: '#fed7aa', padding: '1px 4px', borderRadius: '4px' }}>int main()</code>, etc.).
                          Please rewrite your solution in C before running or verifying.
                        </div>
                      </div>
                      <button
                        onClick={() => setLangWarning(null)}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: '#9a3412', fontSize: '16px', lineHeight: 1, padding: '0 2px',
                          flexShrink: 0
                        }}
                        title="Dismiss warning"
                      >✕</button>
                    </div>
                  )}

                  {/* Primary action row */}
                  <div className={styles.actionRow}>
                    <button
                      className={`${styles.primaryButton} ${isValidatingCode ? styles.buttonDisabled : ''}`}
                      onClick={handleVerifyCode}
                    >
                      {isValidatingCode ? (
                        <>
                          <div className={styles.loadingSpinner} />
                          Verifying code...
                        </>
                      ) : (
                        'Verify Solution'
                      )}
                    </button>
                  </div>

                  {/* Helper buttons row: AI Solution + Give Full Solution */}
                  <div className={styles.helperButtonsRow} style={{ marginTop: '8px', display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    {/* AI Solution Based on My Logic */}
                    {isGeneratingAiSolution ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#7c3aed' }}>
                        <div className={styles.loadingSpinner} style={{ borderTopColor: '#7c3aed', width: '14px', height: '14px', borderWidth: '2px' }} />
                        AI is analyzing your code...
                      </div>
                    ) : (
                      <button
                        className={styles.secondaryButton}
                        style={{
                          border: '1.5px solid #7c3aed',
                          color: '#6d28d9',
                          background: '#faf5ff',
                          fontSize: '13px',
                          padding: '9px 18px'
                        }}
                        onClick={handleGenerateAiSolution}
                        title="AI will analyze your code and generate a personalized solution"
                      >
                        🤖 AI Solution Based on My Logic
                      </button>
                    )}

                    {/* Give Full Solution (prebuilt) */}
                    {isGeneratingSolution ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#6366f1' }}>
                        <div className={styles.loadingSpinner} style={{ borderTopColor: '#6366f1', width: '14px', height: '14px', borderWidth: '2px' }} />
                        Loading solution...
                      </div>
                    ) : !showSolution ? (
                      <button
                        className={styles.secondaryButton}
                        style={{
                          border: '1.5px dashed #6366f1',
                          color: '#4f46e5',
                          background: '#f5f3ff',
                          fontSize: '13px',
                          padding: '9px 18px'
                        }}
                        onClick={() => {
                          setIsGeneratingSolution(true);
                          setTimeout(() => {
                            setIsGeneratingSolution(false);
                            setShowSolution(true);
                          }, 600);
                        }}
                      >
                        💡 Give Full Solution
                      </button>
                    ) : (
                      <button
                        className={styles.secondaryButton}
                        style={{ fontSize: '13px', padding: '9px 18px' }}
                        onClick={() => setShowSolution(false)}
                      >
                        Hide Solution
                      </button>
                    )}
                  </div>
                </div>

                {/* Terminal output — shown after Run Code or when there is output */}
                {terminalOutput && (
                  <div className={styles.terminalCard}>
                    <div className={styles.terminalHeader}>
                      <span className={styles.terminalDot} style={{ backgroundColor: '#ef4444' }} />
                      <span className={styles.terminalDot} style={{ backgroundColor: '#f59e0b' }} />
                      <span className={styles.terminalDot} style={{ backgroundColor: '#10b981' }} />
                      <span style={{ color: '#94a3b8', fontSize: '11px', fontFamily: 'JetBrains Mono', marginLeft: '8px' }}>Terminal Output</span>
                    </div>
                    <div className={styles.terminalOutput}>
                      {terminalOutput}
                    </div>
                  </div>
                )}

                {/* AI verification response */}
                {codeResult && (
                  <div className={`${styles.validationBox} ${codeResult.correct ? styles.validationSuccess : styles.validationFailure}`}>
                    <h3 style={{ fontSize: '15px', fontWeight: '800', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      {codeResult.correct ? 'Code Verified!' : 'Verification Feedback'}
                    </h3>
                    <p style={{ fontSize: '13.5px', lineHeight: '1.5' }}>{codeResult.feedback}</p>

                    {codeResult.issues && codeResult.issues.length > 0 && (
                      <div>
                        <h4 className={styles.hintsTitle}>Bugs or issues detected:</h4>
                        <ul className={styles.hintsList}>
                          {codeResult.issues.map((issue, idx) => (
                            <li key={idx} className={styles.hintItem}>
                              <strong>Line {issue.line || 'general'}:</strong> {issue.description}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Tip: full solution button is above the editor */}
                    {!codeResult.correct && (
                      <div style={{ marginTop: '12px', fontSize: '12.5px', color: '#9a3412', background: 'rgba(239,68,68,0.05)', border: '1px dashed #ef4444', borderRadius: '6px', padding: '10px 12px' }}>
                        <strong>Tip:</strong> Use the <strong>💡 Give Full Solution</strong> button above the editor to reveal the reference answer.
                      </div>
                    )}
                  </div>
                )}

                {/* AI-generated personalized solution card */}
                {aiSolution && (
                  <div className={styles.card} style={{ border: '1.5px solid #a78bfa', background: 'linear-gradient(135deg, #faf5ff 0%, #f5f3ff 100%)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                      <span style={{ fontSize: '22px' }}>🤖</span>
                      <div>
                        <h3 className={styles.cardTitle} style={{ color: '#5b21b6', margin: 0 }}>AI-Personalized Solution</h3>
                        <p style={{ fontSize: '12px', color: '#7c3aed', margin: 0 }}>Generated based on your code approach</p>
                      </div>
                      <button
                        onClick={() => setAiSolution(null)}
                        style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#7c3aed', fontSize: '16px' }}
                        title="Dismiss"
                      >✕</button>
                    </div>

                    {/* AI explanation */}
                    <p style={{ fontSize: '13.5px', color: '#4c1d95', lineHeight: 1.55, marginBottom: '14px', padding: '10px 14px', background: '#ede9fe', borderRadius: '8px', border: '1px solid #c4b5fd' }}>
                      {aiSolution.explanation}
                    </p>

                    {/* Step-by-step breakdown */}
                    {aiSolution.steps && aiSolution.steps.length > 0 && (
                      <div style={{ marginBottom: '14px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 800, color: '#6d28d9', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '8px' }}>How it works</div>
                        {aiSolution.steps.map((step, i) => (
                          <div key={i} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', marginBottom: '6px' }}>
                            <span style={{ width: '20px', height: '20px', borderRadius: '50%', background: '#7c3aed', color: '#fff', fontSize: '11px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</span>
                            <span style={{ fontSize: '13px', color: '#3b0764', lineHeight: 1.45 }}>{step}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Generated C code */}
                    <div style={{ fontSize: '11px', fontWeight: 800, color: '#6d28d9', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '8px' }}>Generated C Code</div>
                    <pre style={{
                      background: '#0d1117',
                      color: '#c9d1d9',
                      padding: '16px',
                      borderRadius: '8px',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: '12.5px',
                      overflowX: 'auto',
                      whiteSpace: 'pre',
                      border: '1px solid #30363d',
                      marginBottom: '14px'
                    }}>{aiSolution.c_code}</pre>

                    <div style={{ display: 'flex', gap: '10px' }}>
                      <button
                        className={styles.primaryButton}
                        style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)', boxShadow: '0 4px 12px rgba(124,58,237,0.3)' }}
                        onClick={() => { setCodeText(aiSolution.c_code); setAiSolution(null); }}
                      >
                        Apply to Editor
                      </button>
                      <button
                        className={styles.secondaryButton}
                        onClick={() => setAiSolution(null)}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}

                {/* Reference Solution display card */}
                {showSolution && !isGeneratingSolution && (
                  <div className={styles.card} style={{ border: '1.5px solid #cbd5e1', background: '#f8fafc' }}>
                    <h3 className={styles.cardTitle} style={{ color: '#1e293b' }}>Reference Solution</h3>
                    <p className={styles.whatIsItText} style={{ fontSize: '13px', color: '#475569', marginBottom: '12px' }}>
                      Here is the correct solution for <strong>{currentTopic.title}</strong>. You can review the structure and comments below.
                    </p>
                    <pre style={{
                      background: '#0d1117',
                      color: '#adbac7',
                      padding: '16px',
                      borderRadius: '8px',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: '12.5px',
                      overflowX: 'auto',
                      whiteSpace: 'pre',
                      border: '1px solid #21262d',
                      marginBottom: '16px'
                    }}>
                      {currentTopic.referenceSolution}
                    </pre>
                    <div style={{ display: 'flex', gap: '12px' }}>
                      <button
                        className={styles.primaryButton}
                        onClick={() => {
                          setCodeText(currentTopic.referenceSolution);
                          setShowSolution(false);
                        }}
                      >
                        Apply to Editor
                      </button>
                      <button
                        className={styles.secondaryButton}
                        onClick={() => setShowSolution(false)}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}

              </div>
            )}

          </div>

          {/* Footer controls */}
          <div className={styles.footer}>
            <button 
              className={styles.secondaryButton} 
              disabled={step === 1}
              onClick={() => setStep(prev => prev - 1)}
            >
              ← Back
            </button>
            <span style={{ alignSelf: 'center', fontSize: '12px', color: '#94a3b8', fontWeight: '600' }}>
              Step {step} of 4
            </span>
            <button 
              className={styles.primaryButton}
              disabled={step === 4}
              onClick={() => setStep(prev => prev + 1)}
            >
              Next →
            </button>
          </div>

          {/* Success Overlay Modal */}
          {showCompletionModal && (
            <div className={styles.completionOverlay}>
              <div className={styles.completionCard}>
                <div className={styles.completionEmoji}>★</div>
                <h2 className={styles.completionTitle}>Concept Mastered!</h2>
                <p className={styles.completionDesc}>
                  Incredible job! You have fully completed the <strong>{currentTopic.title}</strong> module. 
                  Your logic was verified, and your C code compiler run was approved by AI.
                </p>
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                  <button 
                    className={styles.secondaryButton}
                    onClick={() => setShowCompletionModal(false)}
                  >
                    Keep Coding
                  </button>
                  <button 
                    className={styles.primaryButton}
                    onClick={handleNextTopic}
                  >
                    Next Topic →
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>

      </div>
    </>
  );
}

// ─── Tutor Custom Editor Component ──────────────────────────────────────────
function TutorCodeEditor({ code, onChange }) {
  const textareaRef = useRef(null);
  const preRef = useRef(null);
  const gutterRef = useRef(null);

  const lineCount = useMemo(() => code.split('\n').length, [code]);
  const highlighted = useMemo(() => highlightC(code), [code]);

  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop  = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) {
      // Gutter scrolls by the same amount as the textarea.
      // The gutter's first line has 16px padding-top to align with the
      // code wrapper's 16px padding-top, so straight scrollTop sync works.
      gutterRef.current.scrollTop = ta.scrollTop;
    }
  }, []);

  const handleKeyDown = useCallback((e) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const key = e.key;

    // Tab -> 4 spaces
    if (key === 'Tab') {
      e.preventDefault();
      const INDENT = '    ';
      const next = code.substring(0, start) + INDENT + code.substring(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 4;
      });
      return;
    }

    // Enter -> preserve indentation
    if (key === 'Enter') {
      e.preventDefault();
      const lineStart = code.lastIndexOf('\n', start - 1) + 1;
      const match = code.slice(lineStart).match(/^[ \t]*/);
      const indent = match ? match[0] : '';
      
      const charBefore = code[start - 1];
      const charAfter = code[start];

      // Bracket pair expansion: {|} -> {\n    |\n}
      if (charBefore === '{' && charAfter === '}') {
        const inner = '\n' + indent + '    ';
        const outer = '\n' + indent;
        const next = code.substring(0, start) + inner + outer + code.substring(end);
        const pos = start + inner.length;
        onChange(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = pos;
        });
        return;
      }

      const insert = '\n' + indent;
      const next = code.substring(0, start) + insert + code.substring(end);
      const pos = start + insert.length;
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = pos;
      });
      return;
    }

    // Auto-close brackets & quotes
    const OPEN_TO_CLOSE = { '(': ')', '{': '}', '[': ']', '"': '"', "'": "'" };
    const CLOSE_CHARS = new Set([')', '}', ']', '"', "'"]);
    const OPEN_CHARS = new Set(['(', '{', '[', '"', "'"]);

    if (key === 'Backspace' && start === end) {
      const charBefore = code[start - 1];
      const charAfter = code[start];
      if (charBefore && OPEN_TO_CLOSE[charBefore] === charAfter) {
        e.preventDefault();
        const next = code.substring(0, start - 1) + code.substring(start + 1);
        const pos = start - 1;
        onChange(next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = pos;
        });
        return;
      }
    }

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

    if (OPEN_CHARS.has(key) && start === end) {
      const close = OPEN_TO_CLOSE[key];
      const charAfter = code[start];

      if ((key === '"' || key === "'") && code[start - 1] === key) {
        return;
      }
      if (charAfter && /\w/.test(charAfter)) return;

      e.preventDefault();
      const next = code.substring(0, start) + key + close + code.substring(end);
      const pos = start + 1;
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = pos;
      });
      return;
    }
  }, [code, onChange]);

  useEffect(() => {
    syncScroll();
  }, [code, syncScroll]);

  return (
    <div className={styles.tutorEditor}>
      <div className={styles.tutorGutter} ref={gutterRef} aria-hidden="true">
        {Array.from({ length: lineCount }, (_, idx) => (
          <div key={idx} className={styles.tutorLineNum}>{idx + 1}</div>
        ))}
      </div>
      <div className={styles.tutorCodeWrapper}>
        {/*
          SECURITY: `highlighted` is the output of highlightC() (src/highlight.js).
          highlightC() HTML-escapes ALL user input via esc() (&, <, >, ", ', /)
          before wrapping tokens in <span> tags with hard-coded class names.
          No raw user or AI-generated content is ever injected as HTML.
        */}
        <pre
          ref={preRef}
          className={styles.tutorHighlight}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(highlighted + '\n') }}
        />
        <textarea
          ref={textareaRef}
          className={styles.tutorTextareaInput}
          value={code}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="C code editor"
        />
      </div>
    </div>
  );
}

