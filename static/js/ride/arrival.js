// Arrival card for the 3D ride-along, shared by both engines. Shown when the
// ride reaches its destination; offers Replay / Exit and is dismissible so the
// rider can look around the destination. Never exits on its own.
window.APP = window.APP || {};

APP.Arrival = {
  /** Wire the card. opts: { summary, onReplay }. The Exit link mirrors the
   *  top-bar ✕ Exit, so it returns to wherever the ride was launched from. */
  init(opts) {
    opts = opts || {};
    this.card = document.getElementById("arrival-card");
    if (!this.card) return;

    const sub = document.getElementById("arrival-sub");
    if (sub) sub.textContent = opts.summary || "";

    const exit = document.getElementById("arrival-exit");
    const topExit = document.getElementById("exit");
    if (exit && topExit) exit.href = topExit.href;

    const replay = document.getElementById("arrival-replay");
    if (replay) {
      replay.addEventListener("click", () => {
        this.hide();
        if (opts.onReplay) opts.onReplay();
      });
    }
    const dismiss = document.getElementById("arrival-dismiss");
    if (dismiss) dismiss.addEventListener("click", () => this.hide());
  },

  show() {
    if (this.card) this.card.classList.remove("hidden");
  },

  hide() {
    if (this.card) this.card.classList.add("hidden");
  },
};
