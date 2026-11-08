const STARFIELD_JS = `
(() => {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const layers = [...document.querySelectorAll("canvas")].map((canvas, index) => ({
    canvas,
    context: canvas.getContext("2d"),
    depth: [0.22, 0.55, 1][index],
    density: [4700, 9500, 21000][index],
    radius: [0.55, 0.85, 1.25][index],
    color: ["96,107,131", "116,127,149", "142,151,170"][index],
    opacity: [0.23, 0.34, 0.5][index],
    stars: [],
  }));
  let width = 1, height = 1, frame = 0, previousTime = 0;
  let pointerX = 0, pointerY = 0, cameraX = 0, cameraY = 0;
  let previousPointerX = null, previousPointerY = null, energy = 0;
  let velocityX = 4, velocityY = -2;

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    for (const layer of layers) {
      layer.canvas.width = Math.round(width * ratio);
      layer.canvas.height = Math.round(height * ratio);
      layer.context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.min(420, Math.max(18, Math.round(width * height / layer.density)));
      layer.stars = Array.from({ length: count }, () => ({
        x: Math.random() * (width + 160) - 80,
        y: Math.random() * (height + 160) - 80,
        radius: layer.radius * (0.55 + Math.random() * 0.65),
        brightness: 0.6 + Math.random() * 0.4,
      }));
    }
    if (reducedMotion.matches) draw(0);
  }

  function wrap(value, size) {
    return ((value + 80) % (size + 160) + size + 160) % (size + 160) - 80;
  }

  function draw(dt) {
    const ease = 1 - Math.exp(-dt * 4);
    energy *= Math.exp(-dt * 2.6);
    cameraX += (pointerX - cameraX) * ease;
    cameraY += (pointerY - cameraY) * ease;
    velocityX += (4 + pointerX * energy * 55 - velocityX) * ease;
    velocityY += (-2 + pointerY * energy * 55 - velocityY) * ease;
    for (const layer of layers) {
      const context = layer.context;
      context.clearRect(0, 0, width, height);
      for (const star of layer.stars) {
        star.x = wrap(star.x + velocityX * layer.depth * dt, width);
        star.y = wrap(star.y + velocityY * layer.depth * dt, height);
        const x = star.x - cameraX * layer.depth * 32;
        const y = star.y - cameraY * layer.depth * 32;
        context.beginPath();
        context.fillStyle = "rgba(" + layer.color + "," + layer.opacity * star.brightness + ")";
        context.arc(x, y, star.radius, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  function animate(time) {
    const dt = previousTime ? Math.min((time - previousTime) / 1000, 0.05) : 1 / 60;
    previousTime = time;
    draw(dt);
    frame = requestAnimationFrame(animate);
  }

  function resume() {
    cancelAnimationFrame(frame);
    previousTime = 0;
    if (!document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(animate);
    else draw(0);
  }

  window.addEventListener("pointermove", (event) => {
    if (reducedMotion.matches || event.pointerType === "touch") return;
    pointerX = event.clientX / width * 2 - 1;
    pointerY = event.clientY / height * 2 - 1;
    if (previousPointerX !== null) {
      energy = Math.min(2, energy + Math.hypot(event.clientX - previousPointerX, event.clientY - previousPointerY) / 140);
    }
    previousPointerX = event.clientX;
    previousPointerY = event.clientY;
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => {
    pointerX = pointerY = energy = 0;
    previousPointerX = previousPointerY = null;
  });
  window.addEventListener("blur", () => { pointerX = pointerY = energy = 0; });
  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", resume);
  reducedMotion.addEventListener("change", resume);
  resize();
  resume();
})();
`;

export function renderStarfieldHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#000000">
  <title>TellyMCP</title>
  <link rel="icon" href="data:,">
  <style>
    :root { color-scheme: dark; background: #000; }
    html, body, main { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
    main { position: fixed; inset: 0; isolation: isolate; }
    canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; pointer-events: none; }
  </style>
</head>
<body>
  <main aria-label="TellyMCP">
    <canvas aria-hidden="true" data-layer="far"></canvas>
    <canvas aria-hidden="true" data-layer="middle"></canvas>
    <canvas aria-hidden="true" data-layer="near"></canvas>
  </main>
  <script>${STARFIELD_JS}</script>
</body>
</html>`;
}
