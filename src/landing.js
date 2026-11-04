/* ── XSS safety note ──────────────────────────────────────────────────────────
   All innerHTML assignments in this file use ONLY hardcoded static HTML literals
   produced at build-time. No user-supplied input is interpolated here.
   The heroGutter builder uses createElement/textContent exclusively.
   Reviewed 2026-11 (Render security audit). Do not add user data to these paths.
 ──────────────────────────────────────────────────────────────────────────────── */

/* ── Nav scroll state ── */
const nav = document.getElementById('nav');
if (nav) {
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 20);
  }, { passive: true });
}

/* ── Scroll Progress Bar ── */
window.addEventListener('scroll', () => {
  const scrollTop = window.scrollY;
  const docHeight = document.documentElement.scrollHeight - window.innerHeight;
  const scrollPercent = (scrollTop / docHeight) * 100;
  const progressEl = document.getElementById('scroll-progress');
  if (progressEl) progressEl.style.width = scrollPercent + '%';
}, { passive: true });

function initGsap() {
  if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(initGsap, 30));
    } else {
      setTimeout(initGsap, 40);
    }
    return;
  }

  // Register ScrollTrigger plugin
  gsap.registerPlugin(ScrollTrigger);

  /* ── GSAP Slide Down Nav on Load ── */
  gsap.from('#nav', {
    y: -70,
    opacity: 0,
    duration: 0.8,
    ease: 'power3.out'
  });

  /* ── Hero staggered reveal — badge → headline → sub → CTAs ── */
  const headlineEl = document.querySelector('.hero-headline');
  if (headlineEl) {
    // Split headline into words for stagger bounce
    headlineEl.innerHTML = `
      <span class="hero-word">Smart</span>
      <span class="hero-word">Compiler</span>
      <span class="hero-word">&mdash;</span>
      <span class="hero-word">The</span>
      <span class="hero-word">AI</span>
      <span class="hero-word">C</span>
      <span class="hero-word">Compiler</span>
      <span class="hero-word">That</span>
      <span class="hero-word">Catches</span><br/>
      <span class="hero-word grad-text">the</span>
      <span class="hero-word grad-text">bugs</span>
      <span class="hero-word grad-text">GCC</span>
      <span class="hero-word grad-text">can't.</span>
    `;
    // Badge fades in first
    gsap.fromTo('.hero-badge',
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.7, ease: 'power2.out' }
    );
    // Headline words bounce in
    gsap.fromTo('.hero-word',
      { opacity: 0, y: 24 },
      { opacity: 1, y: 0, duration: 0.8, stagger: 0.07, delay: 0.2, ease: 'back.out(1.7)' }
    );
    // Sub-headline slides in
    gsap.fromTo('.hero-sub',
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.8, delay: 0.55, ease: 'power2.out' }
    );
    // CTA buttons pop in
    gsap.fromTo('.hero-ctas .btn-primary',
      { opacity: 0, y: 12, scale: 0.95 },
      { opacity: 1, y: 0, scale: 1, duration: 0.6, delay: 0.8, ease: 'back.out(1.8)' }
    );
    // Hero visual slides up
    gsap.fromTo('.hero-visual',
      { opacity: 0, y: 32 },
      { opacity: 1, y: 0, duration: 1.0, delay: 0.6, ease: 'power3.out' }
    );
  }

  /* ── Staggered Scroll Reveal via GSAP ScrollTrigger ── */
  document.querySelectorAll('.reveal').forEach(el => {
    gsap.fromTo(el,
      { opacity: 0, y: 28 },
      {
        scrollTrigger: {
          trigger: el,
          start: 'top 88%',
          toggleActions: 'play none none none'
        },
        opacity: 1,
        y: 0,
        duration: 0.85,
        ease: 'power2.out'
      }
    );
  });

  /* ── Horizontal Feature sections sliding in ── */
  document.querySelectorAll('.feature-grid').forEach(grid => {
    const isFlipped = grid.classList.contains('flip');
    const text = grid.querySelector('.feature-text');
    const visual = grid.querySelector('.feature-text + div');
    if (text && visual) {
      gsap.from(text, {
        scrollTrigger: {
          trigger: grid,
          start: 'top 85%',
        },
        opacity: 0,
        x: isFlipped ? 40 : -40,
        duration: 0.8,
        ease: 'power2.out'
      });
      gsap.from(visual, {
        scrollTrigger: {
          trigger: grid,
          start: 'top 85%',
        },
        opacity: 0,
        x: isFlipped ? -40 : 40,
        duration: 0.8,
        ease: 'power2.out'
      });
    }
  });

  /* ── Product Flow Step-by-Step Scroll Trigger ── */
  document.querySelectorAll('.flow-step-card').forEach((card) => {
    const step = card.getAttribute('data-step');
    ScrollTrigger.create({
      trigger: card,
      start: 'top 60%',
      end: 'bottom 40%',
      onEnter: () => activateStep(step, card),
      onEnterBack: () => activateStep(step, card)
    });
  });

  /* ── Donut chart animation on scroll ── */
  const donutData = { logical: 0, syntax: 0, runtime: 0, other: 0 };
  ScrollTrigger.create({
    trigger: '.bug-tracker-ui',
    start: 'top 85%',
    onEnter: () => {
      gsap.to(donutData, {
        logical: 38,
        syntax: 27,
        runtime: 15,
        other: 20,
        duration: 1.6,
        ease: 'power2.out',
        onUpdate: () => {
          const donut = document.querySelector('.donut');
          if (donut) {
            const l = donutData.logical;
            const s = l + donutData.syntax;
            const r = s + donutData.runtime;
            donut.style.background = `conic-gradient(
              #ef4444 0% ${l}%,
              #f59e0b ${l}% ${s}%,
              #10b981 ${s}% ${r}%,
              #0ea5e9 ${r}% 100%
            )`;
          }
        }
      });
    }
  });

  /* ── Language detector confidence fill on scroll ── */
  ScrollTrigger.create({
    trigger: '.lang-detector-ui',
    start: 'top 85%',
    onEnter: () => {
      gsap.to('.lang-confidence-fill', {
        width: '94%',
        duration: 1.4,
        ease: 'power2.out'
      });
    }
  });

  /* ── 3D Perspective Card Tilt on Mousemove ── */
  init3DTilt();
}

function init3DTilt() {
  document.querySelectorAll('.flow-step-card, .mistake-card').forEach(card => {
    card.style.transformStyle = 'preserve-3d';
    card.style.perspective = '1000px';

    card.addEventListener('mousemove', e => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      const rotateX = ((y - centerY) / centerY) * -5;
      const rotateY = ((x - centerX) / centerX) * 5;

      if (typeof gsap !== 'undefined') {
        gsap.to(card, {
          rotateX: rotateX,
          rotateY: rotateY,
          transformPerspective: 1000,
          ease: 'power1.out',
          duration: 0.3
        });
      }
    });

    card.addEventListener('mouseleave', () => {
      if (typeof gsap !== 'undefined') {
        gsap.to(card, {
          rotateX: 0,
          rotateY: 0,
          ease: 'power2.out',
          duration: 0.5
        });
      }
    });
  });
}

initGsap();

/* ══════════════════════════════════════════════════════════════
   HERO TYPING ANIMATION
   Shows buggy C code being typed, then AI panel slides in
   Controlled and animated via GSAP timelines
 ══════════════════════════════════════════════════════════════ */
const codeLines = [
  { raw: '#include <stdio.h>', html: '<span class="kw">#include</span> <span class="str">&lt;stdio.h&gt;</span>' },
  { raw: '', html: '' },
  { raw: 'int main() {', html: '<span class="kw">int</span> <span class="fn">main</span>() {' },
  { raw: '    int n, i;', html: '    <span class="kw">int</span> n, i<span class="op">;</span>' },
  { raw: '    long long fact = 0;', html: '    <span class="kw">long long</span> fact <span class="op">=</span> <span class="num">0</span><span class="op">;</span> <span class="cm">// ← bug</span>' },
  { raw: '', html: '' },
  { raw: '    printf("Enter a number: ");', html: '    <span class="fn">printf</span>(<span class="str">"Enter a number: "</span>)<span class="op">;</span>' },
  { raw: '    scanf("%d", &n);', html: '    <span class="fn">scanf</span>(<span class="str">"%d"</span>, <span class="op">&amp;</span>n)<span class="op">;</span>' },
  { raw: '', html: '' },
  { raw: '    for (i = 1; i < n; i++) {', html: '    <span class="kw">for</span> (i <span class="op">=</span> <span class="num">1</span>; i <span class="op">&lt;</span> n; i++) {  <span class="cm">// ← bug</span>' },
  { raw: '        fact = fact * i;', html: '        fact <span class="op">=</span> fact <span class="op">*</span> i<span class="op">;</span>' },
  { raw: '    }', html: '    }' },
  { raw: '', html: '' },
  { raw: '    printf("Factorial: %lld\\n", fact);', html: '    <span class="fn">printf</span>(<span class="str">"Factorial: %lld\\n"</span>, fact)<span class="op">;</span>' },
  { raw: '    return 0;', html: '    <span class="kw">return</span> <span class="num">0</span><span class="op">;</span>' },
  { raw: '}', html: '}' },
];

const heroCode = document.getElementById('hero-code');
const heroGutter = document.getElementById('hero-gutter');
const heroPanel = document.getElementById('hero-ai-panel');

let displayedLines = [];
let currentLine = 0;

function buildGutter() {
  heroGutter.replaceChildren(); // safe: clears child nodes without parsing HTML
  const totalLines = Math.max(displayedLines.length, 1);
  for (let i = 1; i <= totalLines; i++) {
    const s = document.createElement('span');
    s.textContent = i;
    heroGutter.appendChild(s);
  }
}

function typeNextLine() {
  if (currentLine >= codeLines.length) {
    // All lines typed — slide in AI panel with GSAP
    setTimeout(() => {
      gsap.to('#hero-ai-panel', {
        x: 0,
        duration: 0.75,
        ease: 'power3.out',
        onStart: () => {
          heroPanel.classList.add('visible');
        }
      });
    }, 600);
    return;
  }

  const line = codeLines[currentLine];
  displayedLines.push(line.html);
  heroCode.innerHTML = displayedLines.join('\n') + '<span class="cursor-blink"></span>';
  buildGutter();
  currentLine++;

  const delay = line.raw === '' ? 60 : 80 + Math.random() * 60;
  setTimeout(typeNextLine, delay);
}

// Start typing after initial page load delay
setTimeout(typeNextLine, 1200);

/* ── Apply fix button (hero) ── */
const applyBtn = document.getElementById('hero-apply-btn');
if (applyBtn) {
  applyBtn.addEventListener('click', () => {
    applyBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
        <path d="M4 10l5 5 7-7" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Fix Applied ✓`;

    gsap.to(applyBtn, {
      backgroundImage: 'linear-gradient(90deg, #047857, #059669)',
      scale: 1.05,
      duration: 0.25,
      yoyo: true,
      repeat: 1
    });

    const fixedLines = [
      '<span class="kw">#include</span> <span class="str">&lt;stdio.h&gt;</span>',
      '',
      '<span class="kw">int</span> <span class="fn">main</span>() {',
      '    <span class="kw">int</span> n, i<span class="op">;</span>',
      '    <span class="kw">long long</span> fact <span class="op">=</span> <span class="num">1</span><span class="op">;</span> <span class="cm">// ✓ fixed</span>',
      '',
      '    <span class="fn">printf</span>(<span class="str">"Enter a number: "</span>)<span class="op">;</span>',
      '    <span class="fn">scanf</span>(<span class="str">"%d"</span>, <span class="op">&amp;</span>n)<span class="op">;</span>',
      '',
      '    <span class="kw">for</span> (i <span class="op">=</span> <span class="num">1</span>; i <span class="op">&lt;=</span> n; i++) {  <span class="cm">// ✓ fixed</span>',
      '        fact <span class="op">=</span> fact <span class="op">*</span> i<span class="op">;</span>',
      '    }',
      '',
      '    <span class="fn">printf</span>(<span class="str">"Factorial: %lld\\n"</span>, fact)<span class="op">;</span>',
      '    <span class="kw">return</span> <span class="num">0</span><span class="op">;</span>',
      '}',
    ];

    // Fade code block and update with green flash
    gsap.to('#hero-code', {
      opacity: 0,
      duration: 0.15,
      onComplete: () => {
        heroCode.innerHTML = fixedLines.join('\n');
        buildGutter();
        gsap.to('#hero-code', { opacity: 1, duration: 0.3 });
        gsap.fromTo('#hero-code',
          { backgroundColor: 'rgba(16, 185, 129, 0.15)' },
          { backgroundColor: 'transparent', duration: 1.2 }
        );
      }
    });
  });
}

/* ── FAQ Accordion Toggles ── */
function initFaqAccordion() {
  const faqQuestions = document.querySelectorAll('.faq-question');
  faqQuestions.forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.parentElement;
      const answer = btn.nextElementSibling;
      const isExpanded = btn.getAttribute('aria-expanded') === 'true';

      // Toggle aria-expanded
      btn.setAttribute('aria-expanded', !isExpanded);

      // Close other open FAQ items for a clean single-open accordion feel
      document.querySelectorAll('.faq-item').forEach(otherItem => {
        if (otherItem !== item && otherItem.classList.contains('active')) {
          otherItem.classList.remove('active');
          const otherBtn = otherItem.querySelector('.faq-question');
          if (otherBtn) otherBtn.setAttribute('aria-expanded', 'false');
          const otherAnswer = otherItem.querySelector('.faq-answer');
          if (otherAnswer) otherAnswer.style.maxHeight = '0';
        }
      });

      // Toggle active class and slide animation
      if (!isExpanded) {
        item.classList.add('active');
        answer.style.maxHeight = answer.scrollHeight + 'px';
      } else {
        item.classList.remove('active');
        answer.style.maxHeight = '0';
      }
    });
  });
}
initFaqAccordion();
