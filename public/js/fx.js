// public/js/fx.js — confetti for the winner.

export function confetti() {
  if (matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.createElement("canvas");
  c.id = "confetti";
  document.body.appendChild(c);
  document.body.classList.add("party");                 // freezes the heavy CSS loops while the confetti plays
  const x = c.getContext("2d");
  const r = c.getBoundingClientRect();
  c.width = r.width || innerWidth; c.height = r.height || innerHeight;

  const cols = ["#f0b92e", "#3b8dff", "#34c26b", "#b07cff", "#e8efe9"];
  const sprites = ["⚾", "🏀", "🏈", "🏒", "⚽", "🏆"].map(e => {   // emoji drawn once, then stamped
    const s = document.createElement("canvas"); s.width = s.height = 32;
    const g = s.getContext("2d");
    g.font = "24px serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(e, 16, 17);
    return s;
  });
  const ps = Array.from({ length: innerWidth < 600 ? 90 : 140 }, () => ({
    x: Math.random() * c.width, y: -Math.random() * c.height * .6,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8,
    vx: -1 + Math.random() * 2, vy: 2 + Math.random() * 3,
    r: Math.random() * 6, vr: -.15 + Math.random() * .3,
    col: cols[Math.random() * cols.length | 0],
    sp: Math.random() < .22 ? sprites[Math.random() * sprites.length | 0] : null,
  }));

  let last = performance.now();
  (function frame(now) {
    const dt = Math.min(2.5, (now - last) / 16.67); last = now;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, c.width, c.height);
    let alive = false;
    for (const p of ps) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
      if (p.y > c.height + 20) continue;
      alive = true;
      const cs = Math.cos(p.r), sn = Math.sin(p.r);
      x.setTransform(cs, sn, -sn, cs, p.x, p.y);
      if (p.sp) x.drawImage(p.sp, -16, -16);
      else { x.fillStyle = p.col; x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); }
    }
    x.setTransform(1, 0, 0, 1, 0, 0);
    if (alive) requestAnimationFrame(frame); else { c.remove(); document.body.classList.remove("party"); }
  })(last);
}
