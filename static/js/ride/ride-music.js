// Optional lo-fi background music for the ride-along, shared by both engines.
// Tracks are whatever audio sits in static/audio (served via /data/ride-music).
// Off by default — browsers block autoplay with sound until a user gesture, so
// playback starts when the rider clicks the 🎵 Music toggle. Tracks loop as a
// continuous playlist; the rider can skip tracks and set the volume, and the
// per-track attribution (required for CC-BY music) shows while it plays.
window.APP = window.APP || {};

const VOLUME_KEY = "ride.musicVolume";

APP.RideMusic = class {
  /**
   * @param {{src:string, credit:?object}[]} tracks - playlist entries
   */
  constructor(tracks) {
    this.tracks = (tracks || []).filter((t) => t && t.src);
    this.playing = false;
    this.muted = false;
    // Vary the opening track so repeated rides don't always start the same.
    this.idx = this.tracks.length
      ? Math.floor(Math.random() * this.tracks.length)
      : 0;

    // Control elements (all optional; degrade gracefully if absent).
    this.group = document.getElementById("music-controls");
    this.button = document.getElementById("toggle-music"); // opens the panel
    this.panel = document.getElementById("music-panel");
    this.playBtn = document.getElementById("music-playpause");
    this.prevBtn = document.getElementById("music-prev");
    this.nextBtn = document.getElementById("music-next");
    this.muteBtn = document.getElementById("music-mute");
    this.volInput = document.getElementById("music-volume");
    this.creditEl = document.getElementById("music-credit");

    // No tracks → hide the whole music cluster and bail.
    if (!this.tracks.length) {
      if (this.group) this.group.style.display = "none";
      return;
    }

    this.volume = this._loadVolume();
    this.audio = new Audio();
    this.audio.preload = "none";
    this.audio.volume = this.volume;
    // Single track loops on its own; multiple tracks advance as a playlist.
    this.audio.loop = this.tracks.length === 1;
    this.audio.addEventListener("ended", () => this._next());

    this._wire();
    this._reflectVolume();
  }

  _wire() {
    // The 🎵 button opens/closes the popover; playback lives inside it.
    if (this.button)
      this.button.addEventListener("click", (e) => {
        e.stopPropagation();
        this.togglePanel();
      });
    if (this.playBtn) this.playBtn.addEventListener("click", () => this.toggle());
    if (this.prevBtn) this.prevBtn.addEventListener("click", () => this.skip(-1));
    if (this.nextBtn) this.nextBtn.addEventListener("click", () => this.skip(1));
    if (this.muteBtn)
      this.muteBtn.addEventListener("click", () => this.toggleMute());
    if (this.volInput) {
      this.volInput.value = String(Math.round(this.volume * 100));
      this.volInput.addEventListener("input", () =>
        this.setVolume(parseInt(this.volInput.value, 10) / 100)
      );
    }
    // Click outside the cluster closes the panel.
    document.addEventListener("click", (e) => {
      if (this.group && !this.group.contains(e.target)) this.openPanel(false);
    });
  }

  // --- panel -----------------------------------------------------------------

  openPanel(open) {
    if (!this.panel) return;
    this.panel.classList.toggle("hidden", !open);
    if (this.group) this.group.classList.toggle("open", open);
    if (this.button) this.button.setAttribute("aria-expanded", String(open));
  }

  togglePanel() {
    this.openPanel(this.panel ? this.panel.classList.contains("hidden") : false);
  }

  // --- playback --------------------------------------------------------------

  _load() {
    this.audio.src = this.tracks[this.idx].src;
  }

  _play() {
    if (!this.audio.src) this._load();
    // play() rejects if no gesture was registered — revert the UI then.
    return this.audio.play().then(
      () => {
        this.playing = true;
        this._reflect();
        this._showCredit();
      },
      () => {
        this.playing = false;
        this._reflect();
        this._showCredit();
      }
    );
  }

  toggle() {
    if (this.playing) {
      this.audio.pause();
      this.playing = false;
      this._reflect();
      this._showCredit();
    } else {
      this._play();
    }
  }

  /** Move to another track. dir = +1 (next) / -1 (previous). */
  skip(dir) {
    if (this.tracks.length < 2) return;
    const n = this.tracks.length;
    this.idx = (this.idx + dir + n) % n;
    this._load();
    if (this.playing) this._play();
    else this._showCredit(); // brief peek at the now-selected track
  }

  _next() {
    this.skip(1);
  }

  // --- volume / mute ---------------------------------------------------------

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    this.muted = this.volume === 0;
    if (this.audio) this.audio.volume = this.volume;
    this._saveVolume(this.volume);
    this._reflectVolume();
  }

  toggleMute() {
    if (this.muted || this.volume === 0) {
      // Unmute to the previous level (or a sensible default).
      this.setVolume(this._preMuteVolume || 0.5);
    } else {
      this._preMuteVolume = this.volume;
      this.muted = true;
      if (this.audio) this.audio.volume = 0;
      this._reflectVolume();
    }
  }

  _loadVolume() {
    try {
      const v = parseFloat(localStorage.getItem(VOLUME_KEY));
      if (isFinite(v) && v >= 0 && v <= 1) return v;
    } catch (_) {
      /* localStorage unavailable */
    }
    return 0.5;
  }

  _saveVolume(v) {
    try {
      localStorage.setItem(VOLUME_KEY, String(v));
    } catch (_) {
      /* ignore */
    }
  }

  // --- UI --------------------------------------------------------------------

  _reflectVolume() {
    const effective = this.muted ? 0 : this.volume;
    if (this.volInput) this.volInput.value = String(Math.round(effective * 100));
    if (this.muteBtn) {
      const icon = effective === 0 ? "🔇" : effective < 0.5 ? "🔈" : "🔊";
      this.muteBtn.textContent = icon;
      this.muteBtn.title = effective === 0 ? "Unmute" : "Mute";
    }
  }

  /** Format a credit object into an attribution line. */
  _creditText(c) {
    if (!c) return "";
    const who = [c.title && `“${c.title}”`, c.artist && `by ${c.artist}`]
      .filter(Boolean)
      .join(" ");
    const tail = [c.license, c.source && `via ${c.source}`]
      .filter(Boolean)
      .join(", ");
    return ["♪ Music:", who, tail && `(${tail})`].filter(Boolean).join(" ");
  }

  _showCredit() {
    if (!this.creditEl) return;
    const text = this.playing ? this._creditText(this.tracks[this.idx].credit) : "";
    this.creditEl.textContent = text;
    this.creditEl.classList.toggle("show", !!text);
  }

  _reflect() {
    // The 🎵 button stays highlighted while music plays, even when the panel
    // is closed, so playback state is visible at a glance.
    if (this.button) {
      this.button.classList.toggle("active", this.playing);
      this.button.setAttribute("aria-pressed", String(this.playing));
    }
    if (this.playBtn) {
      this.playBtn.textContent = this.playing ? "⏸" : "▶";
      this.playBtn.title = this.playing ? "Pause" : "Play";
    }
  }
};

document.addEventListener("DOMContentLoaded", () => {
  if (!document.getElementById("music-controls")) return;
  fetch("/data/ride-music")
    .then((r) => r.json())
    .then((tracks) => new APP.RideMusic(tracks))
    .catch(() => new APP.RideMusic([]));
});
