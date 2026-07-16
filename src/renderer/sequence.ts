// PNG-sequence-frame animation renderer.
//
// Why this exists: GIF is the obvious "easy" choice, but PNG sequences give
// you (a) sharper scaling, (b) frame-perfect control, (c) the ability to mix
// states by appending frames (e.g. walk → stop). They also avoid the
// 256-color limit and the GIF decoder quirks on some platforms.
//
// Expected layout (resolved relative to the renderer):
//   assets/pet/frames/frame_001.png
//   assets/pet/frames/frame_002.png
//   ...
//
// Frames are loaded in filename sort order. Missing indices are tolerated —
// the loop just skips them. If the folder is empty, the loader throws and
// `pet.ts` falls back to the placeholder.
import type { Live2DHandle } from './live2d';

export async function mountSequence(
  container: HTMLElement,
  framesUrl: string,
  frameMs: number,
): Promise<Live2DHandle> {
  // Probe directory listing via the dev server / file:// index.
  // Electron's renderer can `fetch()` file:// URLs as long as webSecurity
  // is on, which is the default. We probe frame_001.png first; if that
  // 404s, abort and let the caller fall back.
  const probe = await fetch(framesUrl + 'frame_001.png', { method: 'HEAD' });
  if (!probe.ok) {
    throw new Error('No PNG sequence found at ' + framesUrl);
  }

  // Preload all frames. Cap at 256 to keep memory sane — if you have more,
  // split into sub-states (`idle/`, `walk/`, ...).
  const MAX_FRAMES = 256;
  const urls: string[] = [];
  for (let i = 1; i <= MAX_FRAMES; i++) {
    const u = `${framesUrl}frame_${String(i).padStart(3, '0')}.png`;
    // Stop at the first 404 — sequences are contiguous by convention.
    const ok = await fetch(u, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
    if (!ok) break;
    urls.push(u);
  }

  if (urls.length === 0) throw new Error('Sequence had zero frames');

  const images: HTMLImageElement[] = await Promise.all(
    urls.map(
      (u) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('Failed to load ' + u));
          img.src = u;
        }),
    ),
  );

  const img = document.createElement('img');
  img.className = 'sequence-frame';
  img.draggable = false;
  container.appendChild(img);

  // Loop with a single setInterval. requestAnimationFrame would be smoother
  // but burns CPU when the pet is offscreen; setInterval respects the
  // browser's background throttling automatically.
  let i = 0;
  const tick = () => {
    img.src = images[i].src;
    i = (i + 1) % images.length;
  };
  tick();
  const timer = window.setInterval(tick, frameMs);

  return {
    playMotion: () => {/* sequence mode has one animation only */},
    setExpression: () => {/* ditto */},
    destroy: () => {
      window.clearInterval(timer);
      img.remove();
    },
  };
}