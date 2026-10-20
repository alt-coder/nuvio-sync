/**
 * Visual subtitle waveform sync for Nuvio.
 *
 * On Tizen the AVPlay sound-analysis listener gives a 31-band spectrum while
 * native playback runs. That is enough to draw a voice-band envelope and to
 * correlate it with subtitle cue starts without a server, PCM access, or a
 * second media pipeline.
 *
 * On other platforms the overlay still opens and allows manual delay changes;
 * it simply reports that native audio is unavailable.
 */

const MIN_DELAY_MS = -180000;
const MAX_DELAY_MS = 180000;
const FINE_STEP_MS = 50;
const COARSE_STEP_MS = 500;
const MAX_SAMPLES = 24000;

let currentAvplay = null;
let samples = [];
let soundError = "";
let overlay = null;
let canvas = null;
let context = null;
let timer = 0;

const state = {
  delayMs: 0,
  cues: [],
  idx: 0,
  winStart: 0,
  winSeconds: 30,
  fine: true,
  message: "",
  autoBusy: false
};

function clampDelay(value) {
  return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(Number(value) || 0)));
}

function levelFromBands(bands) {
  if (!bands || typeof bands.length !== "number" || !bands.length) return null;
  const from = Math.min(8, bands.length - 1);
  const to = Math.min(24, bands.length - 1);
  let sum = 0;
  let count = 0;
  for (let i = from; i <= to; i++) {
    const value = Math.max(0, Number(bands[i]) || 0);
    sum += value * value;
    count++;
  }
  if (!count) return null;
  return Math.max(0, Math.min(255, Math.round(Math.sqrt(sum / count) * 2.4)));
}

function mediaTime() {
  if (!currentAvplay) return null;
  try {
    const value = Number(currentAvplay.getCurrentTime());
    return Number.isFinite(value) ? value / 1000 : null;
  } catch (_) {
    return null;
  }
}

export function attachWaveformSync(avplay) {
  if (!avplay || typeof avplay.setSoundAnalysisListener !== "function") {
    soundError = "AVPlay sound analysis is not available";
    return false;
  }
  currentAvplay = avplay;
  samples = [];
  soundError = "";
  try {
    avplay.unsetSoundAnalysisListener?.();
  } catch (_) {
    // Not registered yet.
  }
  const listener = (bands) => {
    const time = mediaTime();
    const level = levelFromBands(bands);
    if (time === null || level === null) return;
    samples.push({ t: time, v: level });
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  };
  try {
    avplay.setSoundAnalysisListener(listener);
    return true;
  } catch (error) {
    soundError = error?.message || "AVPlay sound analysis rejected";
    return false;
  }
}

export function detachWaveformSync(avplay) {
  const target = avplay || currentAvplay;
  if (target) {
    try {
      target.unsetSoundAnalysisListener?.();
    } catch (_) {
      // Ignore teardown races.
    }
  }
  if (!avplay || currentAvplay === avplay) currentAvplay = null;
}

export function hasWaveformSamples() {
  return samples.length > 0;
}

export function isWaveformSyncOpen() {
  return Boolean(overlay);
}

function injectStyle() {
  if (document.getElementById("waveformSyncStyle")) return;
  const style = document.createElement("style");
  style.id = "waveformSyncStyle";
  style.textContent = `
    #waveformSyncOverlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(5,5,9,.92);color:#f4f1ff;font-family:system-ui,sans-serif}
    #waveformSyncOverlay.hidden{display:none}
    .ws-panel{width:min(92vw,1500px);max-height:88vh;background:#11111b;border:1px solid rgba(255,255,255,.16);border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.65);padding:22px 26px;display:flex;flex-direction:column;gap:14px}
    .ws-head{display:flex;align-items:center;justify-content:space-between;gap:20px}
    .ws-title{font-size:30px;font-weight:700}
    .ws-sub{font-size:16px;color:#a7a3bf;margin-top:4px}
    .ws-offset{font-size:40px;font-variant-numeric:tabular-nums;font-weight:700;color:#ffd166;min-width:190px;text-align:right}
    .ws-canvas-wrap{position:relative;width:100%;height:250px;background:#090910;border:1px solid rgba(255,255,255,.1);border-radius:12px;overflow:hidden}
    .ws-canvas{width:100%;height:100%;display:block}
    .ws-info{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:34px}
    .ws-cue{font-size:19px;line-height:1.35;color:#ddd8ff;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ws-time{font-size:15px;color:#8d89a8;font-variant-numeric:tabular-nums}
    .ws-actions{display:flex;gap:12px;flex-wrap:wrap}
    .ws-btn{appearance:none;border:1px solid rgba(255,255,255,.16);background:#1b1b29;color:#e9e6ff;border-radius:10px;padding:11px 18px;font-size:16px;font-weight:600}
    .ws-btn.focused{background:#7b5cff;border-color:#b5a4ff;color:#fff;outline:3px solid #fff;outline-offset:2px}
    .ws-btn.primary{background:#6d4dff;border-color:#9b86ff}
    .ws-hint{font-size:14px;color:#89859e;line-height:1.6}
    .ws-status{font-size:15px;color:#ffd166;min-height:22px}
  `;
  document.head.appendChild(style);
}

function ensureOverlay() {
  if (overlay) return overlay;
  injectStyle();
  overlay = document.createElement("div");
  overlay.id = "waveformSyncOverlay";
  overlay.className = "hidden";
  overlay.innerHTML = `
    <div class="ws-panel">
      <div class="ws-head">
        <div>
          <div class="ws-title">Waveform sync</div>
          <div class="ws-sub" id="wsSub"></div>
        </div>
        <div class="ws-offset" id="wsOffset" dir="ltr">+0.00s</div>
      </div>
      <div class="ws-canvas-wrap"><canvas class="ws-canvas" id="wsCanvas"></canvas></div>
      <div class="ws-info">
        <div class="ws-cue" id="wsCue"></div>
        <div class="ws-time" id="wsTime"></div>
      </div>
      <div class="ws-status" id="wsStatus"></div>
      <div class="ws-actions">
        <button class="ws-btn" data-ws="auto">Auto sync</button>
        <button class="ws-btn" data-ws="reset">Reset</button>
        <button class="ws-btn" data-ws="zoom">Zoom</button>
        <button class="ws-btn" data-ws="fine">Fine</button>
        <button class="ws-btn primary" data-ws="save">Save</button>
      </div>
      <div class="ws-hint">← → move subtitles · ↑ ↓ cue · OK preview · Red fine · Green zoom · Yellow reset · Blue save · Back close</div>
    </div>
  `;
  document.body.appendChild(overlay);
  canvas = overlay.querySelector("#wsCanvas");
  overlay.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ws]");
    if (button) {
      event.preventDefault();
      event.stopPropagation();
      handleAction(button.dataset.ws);
    }
  });
  window.addEventListener("keydown", onKeyDown, true);
  return overlay;
}

function formatDelay(ms) {
  const value = Math.trunc(Number(ms) || 0);
  const sign = value >= 0 ? "+" : "−";
  const abs = Math.abs(value);
  return `${sign}${(abs / 1000).toFixed(2)}s`;
}

function normalizedCues(cues) {
  return (Array.isArray(cues) ? cues : [])
    .map((cue) => ({
      start: Number(cue.startTimeMs || 0) / 1000,
      end: Number(cue.endTimeMs || 0) / 1000,
      text: String(cue.text || "")
        .replace(/\s+/g, " ")
        .trim()
    }))
    .filter((cue) => cue.end > cue.start && cue.text)
    .sort((left, right) => left.start - right.start);
}

function currentCueIndex(time) {
  if (!state.cues.length) return -1;
  const shifted = time - state.delayMs / 1000;
  let lo = 0;
  let hi = state.cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (shifted < state.cues[mid].start) hi = mid - 1;
    else if (shifted >= state.cues[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

function focusedCue() {
  return state.cues[state.idx] || null;
}

function centerOnCue(index, { force = false } = {}) {
  if (!state.cues.length) return;
  state.idx = Math.max(0, Math.min(state.cues.length - 1, index));
  const cue = state.cues[state.idx];
  const cueTime = cue.start + state.delayMs / 1000;
  const left = state.winStart;
  const right = state.winStart + state.winSeconds;
  if (force || cueTime < left + 2 || cueTime > right - 2) {
    state.winStart = Math.max(0, cueTime - state.winSeconds * 0.35);
  }
}

function updateLabels() {
  if (!overlay) return;
  const offset = overlay.querySelector("#wsOffset");
  const cue = overlay.querySelector("#wsCue");
  const time = overlay.querySelector("#wsTime");
  const status = overlay.querySelector("#wsStatus");
  const sub = overlay.querySelector("#wsSub");
  const active = currentCueIndex(Number(context?.getTime?.() || 0));
  const focus = focusedCue();
  offset.textContent = formatDelay(state.delayMs);
  sub.textContent = context?.title ? `${context.title} · native TV audio` : "Native TV audio";
  cue.textContent = focus
    ? `#${state.idx + 1}/${state.cues.length} · ${focus.text}`
    : "No subtitle cue";
  time.textContent = `active ${active >= 0 ? active + 1 : "—"}`;
  status.textContent =
    state.message || soundError || (samples.length ? "" : "Listening to TV audio…");
}

function draw() {
  if (!canvas || !overlay) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 1200;
  const height = canvas.clientHeight || 250;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const start = state.winStart;
  const end = start + state.winSeconds;
  ctx.strokeStyle = "rgba(255,255,255,.07)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const x = (width * i) / 10;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,255,255,.16)";
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  const visible = samples.filter((sample) => sample.t >= start && sample.t <= end);
  const mid = height / 2;
  const barWidth = Math.max(1, width / (state.winSeconds * 20));
  for (const sample of visible) {
    const x = ((sample.t - start) / state.winSeconds) * width;
    const amp = (sample.v / 255) * (height * 0.42);
    ctx.fillStyle = amp > height * 0.16 ? "#9b7dff" : "#514d73";
    ctx.fillRect(x, mid - amp, barWidth, Math.max(1, amp * 2));
  }

  // subtitle cue starts (shifted by the current delay)
  state.cues.forEach((cue, index) => {
    const cueTime = cue.start + state.delayMs / 1000;
    if (cueTime < start || cueTime > end) return;
    const x = ((cueTime - start) / state.winSeconds) * width;
    ctx.strokeStyle = index === state.idx ? "#ffd166" : "rgba(255,209,102,.35)";
    ctx.lineWidth = index === state.idx ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  });

  const now = Number(context?.getTime?.() || 0);
  if (now >= start && now <= end) {
    const x = ((now - start) / state.winSeconds) * width;
    ctx.strokeStyle = "#5ef2c2";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  if (!visible.length) {
    ctx.fillStyle = "rgba(255,255,255,.42)";
    ctx.font = "18px system-ui, sans-serif";
    ctx.fillText(
      samples.length
        ? "No audio captured in this window"
        : "Play a few seconds to capture TV audio…",
      20,
      mid - 16
    );
  }
}

function update() {
  if (!overlay || overlay.classList.contains("hidden")) return;
  const now = Number(context?.getTime?.() || 0);
  const active = currentCueIndex(now);
  if (active >= 0 && active !== state.idx) {
    state.idx = active;
  }
  const cue = focusedCue();
  if (cue) {
    const cueTime = cue.start + state.delayMs / 1000;
    if (cueTime < state.winStart || cueTime > state.winStart + state.winSeconds) {
      state.winStart = Math.max(0, cueTime - state.winSeconds * 0.35);
    }
  }
  updateLabels();
  draw();
}

function applyDelay(value, message = "") {
  state.delayMs = clampDelay(value);
  state.message = message;
  try {
    context?.setDelay?.(state.delayMs);
  } catch (_) {
    // The player may be tearing down.
  }
  update();
}

function handleAction(action) {
  if (!overlay) return;
  if (action === "auto") {
    autoAlign();
  } else if (action === "reset") {
    applyDelay(0, "Delay reset");
  } else if (action === "zoom") {
    state.winSeconds = state.winSeconds >= 60 ? 15 : state.winSeconds * 2;
    update();
  } else if (action === "fine") {
    state.fine = !state.fine;
    state.message = state.fine ? "Fine 0.05s" : "Coarse 0.50s";
    update();
  } else if (action === "save") {
    closeWaveformSync({ save: true });
  }
}

let energyBins = null;
let energyStart = 0;

function rebuildEnergyBins() {
  if (!samples.length) {
    energyBins = null;
    return;
  }
  const rate = 4;
  const start = Math.floor(samples[0].t * rate) / rate;
  const end = Math.ceil(samples[samples.length - 1].t * rate) / rate;
  const bins = new Float32Array(Math.max(1, Math.ceil((end - start) * rate) + 1));
  for (const sample of samples) {
    const index = Math.round((sample.t - start) * rate);
    if (index < 0 || index >= bins.length) continue;
    if (sample.v > bins[index]) bins[index] = sample.v;
  }
  energyStart = start;
  energyBins = { rate, bins };
}

function energyAt(time) {
  if (!energyBins) return 0;
  const { rate, bins } = energyBins;
  const from = Math.max(0, Math.round((time - 0.7 - energyStart) * rate));
  const to = Math.min(bins.length - 1, Math.round((time + 0.7 - energyStart) * rate));
  let best = 0;
  for (let i = from; i <= to; i++) {
    if (bins[i] > best) best = bins[i];
  }
  return best;
}

function autoAlign() {
  if (!samples.length) {
    state.message = soundError || "No native audio captured yet — play a few seconds first";
    update();
    return;
  }
  if (!state.cues.length) {
    state.message = "No subtitle cues to align";
    update();
    return;
  }
  state.autoBusy = true;
  state.message = "Correlating voice activity with cue starts…";
  update();
  rebuildEnergyBins();
  const starts = state.cues.slice(0, 200).map((cue) => cue.start);
  let bestShift = 0;
  let bestScore = -Infinity;
  for (let shift = -20; shift <= 20; shift += 0.25) {
    let score = 0;
    let hits = 0;
    for (const start of starts) {
      const energy = energyAt(start + shift);
      if (energy > 0) {
        score += energy;
        hits++;
      }
    }
    if (!hits) continue;
    score = score / hits - Math.abs(shift) * 0.35;
    if (score > bestScore) {
      bestScore = score;
      bestShift = shift;
    }
  }
  state.autoBusy = false;
  if (!Number.isFinite(bestScore) || bestScore <= 0) {
    state.message = "Not enough voice activity to auto-align — use ← →";
    update();
    return;
  }
  applyDelay(
    state.delayMs + bestShift * 1000,
    `Auto aligned ${bestShift >= 0 ? "+" : ""}${bestShift.toFixed(2)}s`
  );
}

function onKeyDown(event) {
  if (!overlay || overlay.classList.contains("hidden")) return;
  const key = String(event.key || "");
  const code = Number(event.keyCode || 0);
  const stop = () => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  };

  if (key === "Escape" || code === 461 || code === 10009) {
    stop();
    closeWaveformSync({ save: true });
    return;
  }
  if (key === "ArrowLeft") {
    stop();
    applyDelay(state.delayMs - (state.fine ? FINE_STEP_MS : COARSE_STEP_MS));
    return;
  }
  if (key === "ArrowRight") {
    stop();
    applyDelay(state.delayMs + (state.fine ? FINE_STEP_MS : COARSE_STEP_MS));
    return;
  }
  if (key === "ArrowUp") {
    stop();
    centerOnCue(state.idx - 1);
    update();
    return;
  }
  if (key === "ArrowDown") {
    stop();
    centerOnCue(state.idx + 1);
    update();
    return;
  }
  if (key === "Enter" || code === 13) {
    stop();
    const cue = focusedCue();
    if (cue) {
      const target = Math.max(0, cue.start + state.delayMs / 1000 - 2);
      try {
        context?.seek?.(target);
      } catch (_) {
        /* ignore */
      }
      state.message = "Previewing cue";
      update();
    }
    return;
  }
  if (key === "a" || key === "A") {
    stop();
    autoAlign();
    return;
  }
  if (code === 403) {
    stop();
    handleAction("fine");
    return;
  }
  if (code === 404) {
    stop();
    handleAction("zoom");
    return;
  }
  if (code === 405) {
    stop();
    handleAction("reset");
    return;
  }
  if (code === 406) {
    stop();
    handleAction("save");
    return;
  }
}

export function openWaveformSync(options) {
  ensureOverlay();
  context = options || {};
  state.delayMs = clampDelay(context.delayMs || 0);
  state.cues = normalizedCues(context.cues);
  state.idx = 0;
  state.winSeconds = 30;
  state.fine = true;
  state.message = "";
  state.autoBusy = false;
  const now = Number(context.getTime?.() || 0);
  const active = currentCueIndex(now);
  state.idx = active >= 0 ? active : 0;
  if (state.cues.length) centerOnCue(state.idx, { force: true });
  else state.winStart = Math.max(0, now - 15);
  overlay.classList.remove("hidden");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  updateLabels();
  draw();
  clearInterval(timer);
  timer = setInterval(update, 250);
  setTimeout(() => {
    const first = overlay?.querySelector('[data-ws="auto"]');
    first?.focus?.();
  }, 60);
  return true;
}

export function closeWaveformSync({ save = true } = {}) {
  if (!overlay) return;
  clearInterval(timer);
  timer = 0;
  if (save) {
    try {
      context?.setDelay?.(state.delayMs);
    } catch (_) {
      /* ignore */
    }
  }
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
  const callback = context?.onClose;
  context = null;
  try {
    callback?.();
  } catch (_) {
    /* ignore */
  }
  if (document.activeElement && overlay.contains(document.activeElement)) {
    document.activeElement.blur();
  }
}
