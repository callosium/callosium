// Terminal UX primitives — a single redrawing progress line, a spinner, and the
// "your brain is live" banner. Everything writes to STDERR: stdout is reserved
// for the MCP stdio protocol and for piped data, so status must never land there.
//
// Two rendering modes, chosen per call from whether stderr is a real terminal:
//   • TTY   → one line, redrawn in place with a spinner + bar (like a good CLI).
//   • non-TTY (piped, CI, the desktop shell capturing stderr) → occasional
//     milestone lines, never carriage-return spam that corrupts a log file.

const OUT = process.stderr;

/** A real, interactive terminal we may redraw in place. CALLOSIUM_NO_TTY forces
 *  the plain path (useful for tests and for anyone who hates animation). */
function isTTY(): boolean {
  return !!(OUT as { isTTY?: boolean }).isTTY && !process.env.CALLOSIUM_NO_TTY;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ANSI helpers — no-ops when not a TTY so piped logs stay clean text.
const c = (code: string, s: string) => (isTTY() ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c('2', s);
const green = (s: string) => c('32', s);
const cyan = (s: string) => c('36', s);
const bold = (s: string) => c('1', s);

function bar(pct: number, width = 22): string {
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  return c('36', '█'.repeat(filled)) + dim('░'.repeat(Math.max(0, width - filled)));
}

// Redraw the current line: return to column 0, write, then clear to end-of-line
// so a shorter line never leaves stale characters from a longer previous one.
function redraw(line: string): void {
  OUT.write('\r' + line + '\x1b[K');
}

// The dashboard URL, remembered so the download-complete line can re-surface it:
// the banner prints at startup and can scroll off during a long first index, so
// we reprint the link right where the user's eyes are when work finishes.
let liveUrl = '';

// ── first-run model download ───────────────────────────────────────────────
let mdFrame = 0;
let mdActive = false;
let mdMilestone = -1;

/** Report download progress (0-100). Safe to call many times at the same pct —
 *  the TTY path just re-renders one line; the plain path emits only at 25% steps. */
export function modelProgress(pct: number): void {
  if (isTTY()) {
    mdFrame = (mdFrame + 1) % FRAMES.length;
    redraw(
      `  ${cyan(FRAMES[mdFrame])}  getting your language model  ${bar(pct)} ${String(pct).padStart(3)}%  ${dim('one-time · ~120 MB')}`,
    );
    mdActive = true;
  } else {
    const m = Math.floor(Math.max(0, Math.min(100, pct)) / 25) * 25;
    if (m > mdMilestone) {
      mdMilestone = m;
      OUT.write(`[callosium] getting the language model (one-time, ~120MB): ${m}%\n`);
    }
  }
}

/** Resolve the download line to a clean success state. Call once the model is
 *  loaded, so the terminal never ends on a bare "100%" that reads as a hang. */
export function modelProgressDone(): void {
  if (isTTY()) {
    if (mdActive) OUT.write('\r\x1b[K');
    OUT.write(`  ${green('✓')}  language model ready  ${dim('— downloaded once, future runs are instant')}\n`);
    if (liveUrl) OUT.write(`  ${dim('→')}  open  ${cyan(liveUrl)}  ${dim("(if a browser tab didn't open)")}\n`);
  } else if (mdMilestone >= 0) {
    OUT.write('[callosium] language model ready.\n');
    if (liveUrl) OUT.write(`[callosium] open ${liveUrl}\n`);
  }
  mdActive = false;
  mdFrame = 0;
  mdMilestone = -1;
}

// ── generic spinner for indeterminate phases (e.g. indexing) ────────────────
export interface Spinner {
  succeed(msg?: string): void;
  fail(msg?: string): void;
  stop(): void;
}

/** Start an animated spinner with a label. Returns a handle; always call one of
 *  succeed/fail/stop so the interval is cleared. On a non-TTY it prints the
 *  label once and the resolution once — no animation. */
export function spinner(label: string): Spinner {
  if (!isTTY()) {
    OUT.write(`[callosium] ${label}…\n`);
    let done = false;
    const end = (mark: string, msg?: string) => {
      if (done) return;
      done = true;
      if (msg) OUT.write(`[callosium] ${mark} ${msg}\n`);
    };
    return { succeed: (m) => end('✓', m ?? label), fail: (m) => end('×', m ?? label), stop: () => end('') };
  }
  let frame = 0;
  const tick = () => redraw(`  ${cyan(FRAMES[frame = (frame + 1) % FRAMES.length])}  ${label}`);
  tick();
  const iv = setInterval(tick, 80);
  let done = false;
  const end = (render?: string) => {
    if (done) return;
    done = true;
    clearInterval(iv);
    OUT.write('\r\x1b[K');
    if (render) OUT.write(render + '\n');
  };
  return {
    succeed: (m) => end(`  ${green('✓')}  ${m ?? label}`),
    fail: (m) => end(`  ${c('31', '×')}  ${m ?? label}`),
    stop: () => end(),
  };
}

// ── the "your brain is live" banner ─────────────────────────────────────────
/** Printed once the dashboard is listening. A clear, premium end-state so the
 *  user always knows the server is up and where to open it. */
export function liveBanner(url: string): void {
  liveUrl = url; // remembered so modelProgressDone can resurface it after indexing
  OUT.write('\n');
  OUT.write(`  ${bold(cyan('◐ Callosium'))}  ${dim("your brain's cockpit is live")}\n`);
  OUT.write(`  ${dim('open in your browser →')}  ${cyan(url)}\n`);
  OUT.write(`  ${dim('running · close this window to stop · reopen anytime')}\n\n`);
}
