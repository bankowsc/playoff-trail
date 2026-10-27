// public/js/bg.js — fills the background layer with slowly floating sports balls. The motion itself is CSS (style.css).

export function startBackground() {
    const layer = document.getElementById("bgfx");
    if (!layer) return;
    const balls = ["⚾", "🏀", "🏈", "🏒", "⚽", "🥎", "🏐", "🎾"];
    for (let i = 0; i < 14; i++) {
        const b = document.createElement("span");
        b.textContent = balls[i % balls.length];
        b.style.cssText =
            `left:${Math.random() * 100}%;font-size:${18 + Math.random() * 30}px;` +
            `animation-duration:${14 + Math.random() * 18}s;animation-delay:${-Math.random() * 30}s;` +    // negative delay = already mid-flight
            `--drift:${(Math.random() * 120 - 60) | 0}px;--spin:${(Math.random() * 720 - 360) | 0}deg;` +
            `opacity:${(0.07 + Math.random() * 0.1).toFixed(2)}`;
        layer.appendChild(b);
    }
}
