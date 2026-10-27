// public/js/autocomplete.js — the custom team dropdown. Works the same on phones and desktops.
// PC: opening the empty box lists every team. Phones: the list appears once you start typing.

const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();   // "Montreal" finds "Montréal"
const detail = t => [t.sport, t.conference, t.division].filter(Boolean).join(" · ");
const finePointer = () => !!(window.matchMedia && matchMedia("(hover: hover) and (pointer: fine)").matches);

export function createAutocomplete({ input, list, getTeams, getUsed, canOpen }) {
  let items = [], active = -1;

  function close(instant) {
    items = []; active = -1;
    input.setAttribute("aria-expanded", "false");
    if (list.hidden) return;
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (instant || reduce) { list.hidden = true; list.classList.remove("closing"); return; }
    list.classList.add("closing");                                  // play the collapse, then hide
    list.addEventListener("animationend", () => {
      if (list.classList.contains("closing")) { list.hidden = true; list.classList.remove("closing"); }
    }, { once: true });
  }

  function show() {
    if (!canOpen()) return close(true);
    const q = norm(input.value.trim());
    if (!q && !finePointer()) return close();
    const used = new Set(getUsed());
    let found = getTeams().filter(t => !used.has(t.name) && (!q || norm(t.name).includes(q)));
    if (q) {
      const rank = t => norm(t.name).startsWith(q) ? 0 : 1;
      found = found.sort((a, b) => rank(a) - rank(b)).slice(0, 30);
    }
    if (!found.length) return close();
    items = found; active = -1;
    list.classList.remove("closing", "up");
    list.innerHTML = items.map((t, i) => `<li role="option" data-i="${i}"><b></b><small></small></li>`).join("");
    items.forEach((t, i) => {                                       // textContent, so team names can never inject markup
      list.children[i].querySelector("b").textContent = t.name;
      list.children[i].querySelector("small").textContent = detail(t);
    });
    list.hidden = false; list.scrollTop = 0;
    input.setAttribute("aria-expanded", "true");
    const r = input.getBoundingClientRect(), vv = window.visualViewport;
    const below = (vv ? vv.offsetTop + vv.height : innerHeight) - r.bottom;   // room left above a phone keyboard
    list.classList.toggle("up", below < 200 && r.top > below);
  }

  function pick(i) { input.value = items[i].name; close(); input.focus(); }

  input.addEventListener("input", show);
  input.addEventListener("focus", show);
  input.addEventListener("click", show);
  list.addEventListener("mousedown", e => e.preventDefault());       // keep focus in the box
  list.addEventListener("click", e => { const li = e.target.closest("li"); if (li) pick(+li.dataset.i); });
  document.addEventListener("pointerdown", e => { if (!e.target.closest(".acWrap")) close(); });
  input.addEventListener("keydown", e => {
    if (list.hidden && e.key === "ArrowDown") { show(); return; }
    if (list.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      [...list.children].forEach((li, i) => li.classList.toggle("on", i === active));
      list.children[active].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(active); }   // pick, don't submit
    else if (e.key === "Escape") close();
  });

  return { close, show };
}
