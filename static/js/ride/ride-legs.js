// Trip-legs panel for the 3D ride-along, shared by both engines (Three.js +
// MapLibre). For a planned-trip preview the payload carries `legs`
// ([{mode, t0, t1, name, color, board, alight, to}] over progress 0..1); this
// renders them as a compact list and highlights the leg currently being
// travelled as the ride advances. Plain routes have no legs, so the panel hides.
window.APP = window.APP || {};

APP.RideLegs = {
  _rows: [],

  /** Render the legs into `container`; no-op (hidden) when there are none. */
  build(container, legs) {
    this._rows = [];
    if (!container) return;
    container.innerHTML = "";
    if (!Array.isArray(legs) || !legs.length) {
      container.classList.add("hidden");
      return;
    }
    container.classList.remove("hidden");

    const title = document.createElement("div");
    title.className = "rl-title";
    title.textContent = "Trip";
    container.appendChild(title);

    legs.forEach((leg) => {
      const row = document.createElement("div");
      row.className = "rl-leg " + (leg.mode === "walk" ? "rl-walk" : "rl-ride");

      const node = document.createElement("span");
      if (leg.mode === "walk") {
        node.className = "rl-node rl-icon";
        node.textContent = "🚶";
      } else {
        node.className = "rl-node rl-chip";
        node.style.background = leg.color || "#888";
        const text = document.createElement("span");
        text.className = "rl-chip-text";
        const run = document.createElement("span");
        run.className = "rl-chip-run";
        run.textContent = leg.name || "";
        text.appendChild(run);
        node.appendChild(text);
      }

      const text = document.createElement("span");
      text.className = "rl-text";
      text.textContent =
        leg.mode === "walk"
          ? `Walk to ${leg.to || "destination"}`
          : `${leg.board} → ${leg.alight}`;

      row.appendChild(node);
      row.appendChild(text);
      container.appendChild(row);
      this._rows.push({ el: row, t0: leg.t0, t1: leg.t1 });
    });

    this._tickerize(container);
  },

  /** A long route name (e.g. "Jame' - Rimba") overflows the compact chip, so
   * scroll it as a seamless ticker: duplicate the run for a -50% loop. Chips
   * that fit stay static. Mirrors the planner's leg-chip ticker. */
  _tickerize(container) {
    container.querySelectorAll(".rl-chip").forEach((el) => {
      const run = el.querySelector(".rl-chip-run");
      const text = el.querySelector(".rl-chip-text");
      if (!run || !text) return;
      const cs = getComputedStyle(el);
      const avail =
        el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (run.getBoundingClientRect().width <= avail + 1) return; // fits
      run.textContent += "  "; // trailing gap baked into each copy
      text.appendChild(run.cloneNode(true)); // 2 copies -> -50% loops seamlessly
      const runW = run.getBoundingClientRect().width;
      el.style.setProperty("--rl-ticker-dur", Math.max(4, runW / 22).toFixed(1) + "s");
      el.classList.add("rl-chip-ticker");
    });
  },

  /** Highlight the leg containing progress fraction u (0..1); dim passed legs. */
  update(u) {
    if (!this._rows.length) return;
    let active = -1;
    for (let i = 0; i < this._rows.length; i++) {
      const r = this._rows[i];
      if (u >= r.t0 && u <= r.t1) {
        active = i;
        break;
      }
      if (u >= r.t0) active = i; // last leg already entered (covers gaps)
    }
    this._rows.forEach((r, i) => {
      r.el.classList.toggle("active", i === active);
      r.el.classList.toggle("done", i < active);
    });
  },
};
