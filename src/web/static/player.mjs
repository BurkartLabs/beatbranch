export class Transport {
  constructor(count, mode = "mix") {
    this.count = count;
    this.mode = mode;
    this.muted = new Array(count).fill(false);
    this.solo = new Array(count).fill(false);
    this.master = 0.9;
    this.playing = false;
    this.offset = 0;
    this.startedAt = 0;
    this.side = 0;
  }
  position(now) {
    return this.playing ? this.offset + (now - this.startedAt) : this.offset;
  }
  play(now) {
    if (this.playing) return this.offset;
    this.startedAt = now;
    this.playing = true;
    return this.offset;
  }
  pause(now) {
    if (!this.playing) return this.offset;
    this.offset = this.position(now);
    this.playing = false;
    return this.offset;
  }
  seek(now, seconds) {
    this.offset = Math.max(0, seconds);
    if (this.playing) this.startedAt = now;
    return this.offset;
  }
  choose(now, side) {
    this.side = side;
    return this.position(now);
  }
  toggleMute(i) {
    this.muted[i] = !this.muted[i];
  }
  toggleSolo(i) {
    this.solo[i] = !this.solo[i];
  }
  gains() {
    if (this.mode === "ab") return Array.from({ length: this.count }, (_, i) => (i === this.side ? 1 : 0));
    const anySolo = this.solo.some(Boolean);
    return Array.from({ length: this.count }, (_, i) => (this.muted[i] ? 0 : anySolo && !this.solo[i] ? 0 : 1));
  }
}

export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function drawWave(canvas, peaks, progress) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const css = getComputedStyle(document.documentElement);
  const base = css.getPropertyValue("--muted").trim() || "#888";
  const done = css.getPropertyValue("--accent").trim() || "#f60";
  ctx.clearRect(0, 0, w, h);
  const n = peaks.length / 2;
  if (!n) {
    ctx.fillStyle = base;
    ctx.fillRect(0, h / 2 - 1, w, 2);
    return;
  }
  const step = w / n;
  for (let i = 0; i < n; i++) {
    const lo = peaks[2 * i] / 127;
    const hi = peaks[2 * i + 1] / 127;
    const x = i * step;
    ctx.fillStyle = x / w <= progress ? done : base;
    const top = h / 2 - (hi * h) / 2;
    const bottom = h / 2 - (lo * h) / 2;
    ctx.fillRect(x, top, Math.max(1, step - 0.5), Math.max(1, bottom - top));
  }
}

function setup(root) {
  const items = [...root.querySelectorAll(".stem")];
  const mode = root.dataset.mode || "mix";
  const t = new Transport(items.length, mode);
  const duration = Number(root.dataset.duration || 0) / 1000;
  const playBtn = root.querySelector(".play");
  const time = root.querySelector(".time");
  const master = root.querySelector(".master");
  let ctx = null;
  let buffers = null;
  let sources = [];
  let gainNodes = [];
  let masterGain = null;
  let loading = null;
  const peaks = items.map((li) => {
    try {
      return JSON.parse(li.dataset.peaks || "[]");
    } catch {
      return [];
    }
  });
  const now = () => (ctx ? ctx.currentTime : 0);
  const length = () => (buffers ? Math.max(...buffers.map((b) => b.duration)) : duration);
  const paint = () => {
    const p = length() ? t.position(now()) / length() : 0;
    items.forEach((li, i) => drawWave(li.querySelector("canvas"), peaks[i], p));
    if (time) time.textContent = `${clock(t.position(now()))} / ${clock(length())}`;
  };
  const applyGains = () => {
    const g = t.gains();
    gainNodes.forEach((node, i) => node.gain.setTargetAtTime(g[i], now(), 0.01));
    items.forEach((li, i) => {
      li.classList.toggle("silent", g[i] === 0);
      const m = li.querySelector(".mute");
      const s = li.querySelector(".solo");
      if (m) m.setAttribute("aria-pressed", String(t.muted[i]));
      if (s) s.setAttribute("aria-pressed", String(t.solo[i]));
    });
    root.querySelectorAll(".ab-a, .ab-b").forEach((b) => b.setAttribute("aria-pressed", String((b.classList.contains("ab-a") ? 0 : 1) === t.side)));
  };
  const load = () => {
    if (loading) return loading;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = Number(master ? master.value : 0.9);
    masterGain.connect(ctx.destination);
    loading = Promise.all(items.map((li) => fetch(li.dataset.src, { credentials: "same-origin" }).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.arrayBuffer();
    }).then((ab) => ctx.decodeAudioData(ab)))).then((bs) => {
      buffers = bs;
      gainNodes = bs.map(() => {
        const g = ctx.createGain();
        g.connect(masterGain);
        return g;
      });
      applyGains();
    });
    return loading;
  };
  const stopSources = () => {
    sources.forEach((s) => {
      try {
        s.stop();
      } catch {}
    });
    sources = [];
  };
  const startSources = () => {
    stopSources();
    const at = ctx.currentTime + 0.05;
    const offset = t.offset;
    t.startedAt = at;
    sources = buffers.map((b, i) => {
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(gainNodes[i]);
      if (offset < b.duration) s.start(at, offset);
      return s;
    });
  };
  const play = async () => {
    playBtn.disabled = true;
    playBtn.textContent = "Loading...";
    try {
      await load();
    } catch {
      playBtn.textContent = "Couldn't load";
      return;
    }
    await ctx.resume();
    if (t.position(now()) >= length()) t.offset = 0;
    t.play(ctx.currentTime);
    startSources();
    playBtn.disabled = false;
    playBtn.textContent = "Pause";
    playBtn.setAttribute("aria-label", "Pause");
  };
  const pause = () => {
    t.pause(now());
    stopSources();
    playBtn.textContent = "Play";
    playBtn.setAttribute("aria-label", "Play");
  };
  const seekTo = async (seconds, andPlay) => {
    t.seek(now(), Math.min(seconds, length() || seconds));
    if (t.playing) startSources();
    else if (andPlay) await play();
    paint();
  };
  playBtn.addEventListener("click", () => (t.playing ? pause() : play()));
  if (master) master.addEventListener("input", () => {
    t.master = Number(master.value);
    if (masterGain) masterGain.gain.setTargetAtTime(t.master, now(), 0.01);
  });
  items.forEach((li, i) => {
    const m = li.querySelector(".mute");
    const s = li.querySelector(".solo");
    if (m) m.addEventListener("click", () => { t.toggleMute(i); applyGains(); });
    if (s) s.addEventListener("click", () => { t.toggleSolo(i); applyGains(); });
    li.querySelector("canvas").addEventListener("click", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      seekTo(((e.clientX - r.left) / r.width) * length(), false);
    });
  });
  root.querySelectorAll(".ab-a, .ab-b").forEach((b) => b.addEventListener("click", () => {
    t.choose(now(), b.classList.contains("ab-a") ? 0 : 1);
    applyGains();
  }));
  root.querySelectorAll(".marker, .seek").forEach((b) => b.addEventListener("click", () => seekTo(Number(b.dataset.at) / 1000, true)));
  setInterval(() => {
    if (t.playing && t.position(now()) >= length()) pause();
    paint();
  }, 120);
  applyGains();
  paint();
}

if (typeof document !== "undefined") {
  document.querySelectorAll("[data-player]").forEach(setup);
  document.addEventListener("branch-changed", () => document.querySelectorAll("[data-player]:not([data-ready])").forEach((el) => {
    el.setAttribute("data-ready", "1");
    setup(el);
  }));
  document.querySelectorAll("[data-player]").forEach((el) => el.setAttribute("data-ready", "1"));
  document.querySelectorAll(".comment-form .at-input").forEach((input) => input.addEventListener("focus", () => {
    const box = input.closest("form").querySelector(".timed");
    if (box) box.checked = true;
  }));
}
