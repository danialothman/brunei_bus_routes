// Admin management for the /applications page: change status, edit the admin
// note, and delete — each persisted to the authed JSON endpoints. Vanilla JS;
// this page loads no other framework.
(function () {
  "use strict";

  function flash(row, text, ok) {
    var el = row.querySelector(".apps-saved");
    if (!el) return;
    el.textContent = text;
    el.className = "apps-saved " + (ok ? "is-ok" : "is-error");
    if (ok) {
      window.setTimeout(function () {
        el.textContent = "";
        el.className = "apps-saved";
      }, 1500);
    }
  }

  function send(id, body) {
    return fetch("/applications/" + id, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  document.addEventListener("change", function (e) {
    var t = e.target;
    var row = t.closest("tr[data-id]");
    if (!row) return;
    var id = row.getAttribute("data-id");

    if (t.classList.contains("js-status")) {
      var status = t.value;
      send(id, { status: status })
        .then(function () {
          row.setAttribute("data-status", status);
          flash(row, "Saved ✓", true);
        })
        .catch(function () {
          flash(row, "Failed", false);
        });
    } else if (t.classList.contains("js-note")) {
      // Fires on blur after editing — save the note.
      send(id, { note: t.value })
        .then(function () {
          flash(row, "Saved ✓", true);
        })
        .catch(function () {
          flash(row, "Failed", false);
        });
    }
  });

  // Save the per-route bounty rates shown on /join.
  var bSave = document.getElementById("bSave");
  if (bSave) {
    bSave.addEventListener("click", function () {
      var saved = document.getElementById("bSaved");
      var body = {
        currency: (document.getElementById("bCurrency") || {}).value || "",
        per_route: (document.getElementById("bPerRoute") || {}).value || "",
        payment_note: (document.getElementById("bPaymentNote") || {}).value || "",
      };
      fetch("/applications/bounty", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function () {
          if (saved) {
            saved.textContent = "Saved ✓";
            saved.className = "apps-saved is-ok";
            window.setTimeout(function () {
              saved.textContent = "";
              saved.className = "apps-saved";
            }, 1500);
          }
        })
        .catch(function () {
          if (saved) {
            saved.textContent = "Failed";
            saved.className = "apps-saved is-error";
          }
        });
    });
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".js-delete");
    if (!btn) return;
    var row = btn.closest("tr[data-id]");
    if (!row) return;
    var id = row.getAttribute("data-id");
    var who = (row.querySelector("strong") || {}).textContent || "this application";
    if (!window.confirm("Delete the application from " + who + "? This can't be undone.")) {
      return;
    }
    fetch("/applications/" + id, { method: "DELETE" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function () {
        row.parentNode.removeChild(row);
        var count = document.getElementById("appCount");
        if (count) {
          var n = parseInt(count.textContent, 10);
          if (!isNaN(n)) count.textContent = n - 1;
        }
      })
      .catch(function () {
        flash(row, "Delete failed", false);
      });
  });
})();
