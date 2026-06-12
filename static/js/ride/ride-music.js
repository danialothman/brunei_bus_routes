// Optional lo-fi background music for the ride-along, shared by both engines.
// Tracks are whatever audio sits in static/audio (served via /data/ride-music).
//
// The controls are intentionally minimal and live inside the now-playing credit
// pill (bottom-left): a mute toggle and a skip-track button, alongside the
// track's attribution (required for the bundled CC-BY tracks).
//
// Autoplay: browsers only permit autoplay when muted, so we always start muted
// the moment the ride loads, then restore the rider's real preference — fading
// the sound in — on their first click/keypress/scroll. A rider who saved
// "muted" simply stays silent.
//
// Settings persist across rides in localStorage: the volume level and the mute
// state — so if you muted the music last time, it stays muted next time.
window.APP = window.APP || {};

const VOLUME_KEY = "ride.musicVolume";
const MUTED_KEY = "ride.musicMuted";
const COLLAPSED_KEY = "ride.musicCollapsed";

APP.RideMusic = class {
  /**
   * @param {{src:string, credit:?object}[]} tracks - playlist entries
   */
  constructor(tracks) {
    this.tracks = (tracks || []).filter((t) => t && t.src);
    this.playing = false;
    // While true, audio is held silent (post-autoplay) until the first gesture.
    this._pendingUnmute = false;
    this._fadeToken = 0;
    // Vary the opening track so repeated rides don't always start the same.
    this.idx = this.tracks.length
      ? Math.floor(Math.random() * this.tracks.length)
      : 0;

    // Control elements (the credit pill is also the control surface).
    this.creditEl = document.getElementById("music-credit");
    this.creditTextEl = document.getElementById("music-credit-text");
    this.muteBtn = document.getElementById("music-mute");
    this.nextBtn = document.getElementById("music-next");
    this.volInput = document.getElementById("music-volume");
    this.toggleBtn = document.getElementById("music-toggle");

    // No tracks → hide the pill and bail.
    if (!this.tracks.length) {
      if (this.creditEl) this.creditEl.style.display = "none";
      return;
    }

    // Restore remembered settings.
    this.volume = this._loadVolume();
    this.muted = this._loadMuted();

    this.audio = new Audio();
    this.audio.preload = "none";
    this.audio.volume = this.volume;
    this.audio.muted = this.muted;
    // Single track loops on its own; multiple tracks advance as a playlist.
    this.audio.loop = this.tracks.length === 1;
    this.audio.addEventListener("ended", () => this._next());

    this.collapsed = this._loadCollapsed();
    this._applyCollapsed();

    this._wire();
    this._reflectVolume();
    this._autostart();
  }

  _wire() {
    // While waiting for the first interaction the buttons (and the pill itself)
    // act as "start playback"; afterwards they're the normal mute/skip controls.
    if (this.muteBtn)
      this.muteBtn.addEventListener("click", () =>
        this._pendingUnmute ? this._resolvePending() : this.toggleMute()
      );
    if (this.nextBtn) {
      if (this.tracks.length < 2) this.nextBtn.style.display = "none";
      this.nextBtn.addEventListener("click", () =>
        this._pendingUnmute ? this._resolvePending() : this.skip(1)
      );
    }
    if (this.volInput)
      this.volInput.addEventListener("input", () => {
        if (this._pendingUnmute) this._resolvePending();
        this.setVolume(parseInt(this.volInput.value, 10) / 100);
      });
    if (this.toggleBtn)
      this.toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleCollapsed();
      });
    if (this.creditEl)
      this.creditEl.addEventListener("click", () => {
        if (this._pendingUnmute) this._resolvePending();
      });
  }

  // --- collapse / compact ----------------------------------------------------

  toggleCollapsed() {
    this.collapsed = !this.collapsed;
    this._applyCollapsed();
    try {
      localStorage.setItem(COLLAPSED_KEY, this.collapsed ? "1" : "0");
    } catch (_) {
      /* ignore */
    }
  }

  _applyCollapsed() {
    if (this.creditEl) this.creditEl.classList.toggle("collapsed", this.collapsed);
    if (this.toggleBtn) {
      this.toggleBtn.textContent = this.collapsed ? "›" : "‹";
      this.toggleBtn.title = this.collapsed ? "Show music player" : "Collapse";
    }
  }

  _loadCollapsed() {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  // --- autoplay --------------------------------------------------------------

  _autostart() {
    this._load();
    // Force a silent start so the browser permits autoplay.
    this.audio.muted = true;
    this.audio.volume = this.volume;
    this.audio.play().then(
      () => {
        this.playing = true;
        if (!this.muted) {
          // Rider wants sound — hold silent and prompt for the first gesture.
          this._pendingUnmute = true;
          this.audio.volume = 0;
          this._armFirstGesture();
        }
        this._reflectVolume();
        this._showCredit();
      },
      () => {
        // Even muted autoplay was refused (rare) — start on the first gesture.
        this.playing = false;
        this._showCredit();
        const once = () => {
          document.removeEventListener("pointerdown", once);
          document.removeEventListener("keydown", once);
          this._play();
        };
        document.addEventListener("pointerdown", once, { passive: true });
        document.addEventListener("keydown", once, { passive: true });
      }
    );
  }

  /** Listen (once) for the rider's first off-pill interaction. */
  _armFirstGesture() {
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    const handler = (e) => {
      // Clicks on the pill are handled by its own controls.
      if (e.type !== "keydown" && this.creditEl && this.creditEl.contains(e.target)) {
        return;
      }
      this._resolvePending();
    };
    this._firstGestureEvents = events;
    this._firstGestureHandler = handler;
    events.forEach((ev) =>
      document.addEventListener(ev, handler, { passive: true })
    );
  }

  _removeFirstGesture() {
    if (!this._firstGestureHandler) return;
    this._firstGestureEvents.forEach((ev) =>
      document.removeEventListener(ev, this._firstGestureHandler)
    );
    this._firstGestureHandler = null;
  }

  /** First interaction: bring the sound in (fading), or honor a saved mute. */
  _resolvePending() {
    if (!this._pendingUnmute) return;
    this._pendingUnmute = false;
    this._removeFirstGesture();
    this._reflectVolume();
    if (this.muted) {
      this._applyAudio(); // stays muted by preference
      this._showCredit();
      return;
    }
    this.audio.muted = false;
    const target = this.volume;
    const token = ++this._fadeToken;
    this.audio.volume = 0;
    const t0 = performance.now();
    const step = (t) => {
      if (token !== this._fadeToken) return; // superseded by a manual change
      // The first rAF timestamp can predate t0 (it's stamped at frame start),
      // so clamp both ends or volume goes negative and throws.
      const k = Math.min(1, Math.max(0, (t - t0) / 800));
      this.audio.volume = target * k;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    this._showCredit();
  }

  // --- playback --------------------------------------------------------------

  _load() {
    this.audio.src = this.tracks[this.idx].src;
  }

  _applyAudio() {
    if (!this.audio) return;
    this._fadeToken++; // cancel any in-flight fade-in
    this.audio.volume = this.volume;
    // Stay silent while a track is auto-playing pre-interaction.
    this.audio.muted = this.muted || this._pendingUnmute;
  }

  _play() {
    if (!this.audio.src) this._load();
    this._applyAudio();
    return this.audio.play().then(
      () => {
        this.playing = true;
        this._showCredit();
      },
      () => {
        this.playing = false;
        this._showCredit();
      }
    );
  }

  /** Move to another track. dir = +1 (next) / -1 (previous). */
  skip(dir) {
    if (this.tracks.length < 2) return;
    const n = this.tracks.length;
    this.idx = (this.idx + dir + n) % n;
    this._load();
    if (this.playing) this._play();
    else this._showCredit();
  }

  _next() {
    this.skip(1);
  }

  // --- mute (the only volume control, kept minimal) --------------------------

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    // Dragging to zero mutes; dragging up unmutes.
    this.muted = this.volume === 0;
    this._applyAudio();
    this._save();
    this._reflectVolume();
  }

  toggleMute() {
    this.muted = !this.muted;
    // Unmuting needs an audible level to come back to.
    if (!this.muted && this.volume === 0) this.volume = 0.5;
    this._applyAudio();
    this._save();
    this._reflectVolume();
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

  _loadMuted() {
    try {
      return localStorage.getItem(MUTED_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  _save() {
    try {
      localStorage.setItem(VOLUME_KEY, String(this.volume));
      localStorage.setItem(MUTED_KEY, this.muted ? "1" : "0");
    } catch (_) {
      /* ignore */
    }
  }

  // --- UI --------------------------------------------------------------------

  _reflectVolume() {
    const shown = this.muted ? 0 : this.volume;
    if (this.volInput) this.volInput.value = String(Math.round(shown * 100));
    if (!this.muteBtn) return;
    if (this._pendingUnmute) {
      // Pre-interaction: invite the rider to start it.
      this.muteBtn.textContent = "▶";
      this.muteBtn.title = "Click to play music";
      return;
    }
    this.muteBtn.textContent = shown === 0 ? "🔇" : shown < 0.5 ? "🔈" : "🔊";
    this.muteBtn.title = this.muted ? "Unmute" : "Mute";
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
    return [who, tail && `(${tail})`].filter(Boolean).join(" ");
  }

  /** Show the credit pill (and its controls) whenever music is active. */
  _showCredit() {
    if (!this.creditEl) return;
    let text = "";
    if (this._pendingUnmute) text = "Click to play music ♪";
    else if (this.playing) text = this._creditText(this.tracks[this.idx].credit);
    if (this.creditTextEl) this.creditTextEl.textContent = text;
    const visible = this.playing || this._pendingUnmute;
    this.creditEl.classList.toggle("show", visible);
    this.creditEl.classList.toggle("hint", this._pendingUnmute);
  }
};

document.addEventListener("DOMContentLoaded", () => {
  if (!document.getElementById("music-credit")) return;
  fetch("/data/ride-music")
    .then((r) => r.json())
    .then((tracks) => new APP.RideMusic(tracks))
    .catch(() => new APP.RideMusic([]));
});
