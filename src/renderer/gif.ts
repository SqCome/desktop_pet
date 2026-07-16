// Single-GIF renderer. Browsers natively decode and play GIFs in <img>
// elements, including animation timing and loop counts. We just style and
// forward interaction events.
//
// The downside vs. PNG sequences: less control over frame timing and
// scaling artifacts on high-DPI displays. Still — for a quick win it's
// the easiest asset format to source online.
import type { Live2DHandle } from './live2d';

export async function mountGif(
  container: HTMLElement,
  gifUrl: string,
): Promise<Live2DHandle> {
  // Probe first so we can fail loudly instead of showing a broken-image icon.
  const probe = await fetch(gifUrl, { method: 'HEAD' });
  if (!probe.ok) throw new Error('GIF not found: ' + gifUrl);

  const img = document.createElement('img');
  img.className = 'gif-frame';
  img.src = gifUrl;
  img.draggable = false;
  container.appendChild(img);

  return {
    playMotion: () => {/* GIF plays itself */},
    setExpression: () => {/* no separate expression channel */},
    destroy: () => img.remove(),
  };
}