// Live2D loader (Cubism 4, .model3.json).
// Lazy-loaded by `pet.ts` so the placeholder path stays light.
//
// Pinned to pixi.js@^6 + pixi-live2d-display@^0.4. v0.5-beta claims PIXI v7
// support but its ESM build still imports `@pixi/core` which doesn't exist
// outside the PIXI v6 monorepo. Downgrading is the stable path until v0.5
// (or a successor) actually lands v7 support.
//
// Features wired here:
//   - model mount + sizing to window
//   - idle motion playback (loop `Idle` group)
//   - mouse-tracking eyes/head (cheap "feels alive" effect)
//   - interaction events dispatched as `pet:interaction` (touch, click) so
//     other code (state machine, AI) can react
import * as PIXI from 'pixi.js';
// Import the Cubism 4 sub-entry, NOT the root `pixi-live2d-display`. The
// root index.js tries Cubism 2 first and throws if `live2d.min.js` isn't
// loaded, even when you only want Cubism 4. The /cubism4 sub-entry skips
// the Cubism 2 path entirely.
import { Live2DModel } from 'pixi-live2d-display/cubism4';

// pixi-live2d-display reads `window.PIXI.Ticker` to drive model updates.
// In a bundled setup PIXI isn't on the global by default, so we expose it.
(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;

export interface Live2DHandle {
  playMotion: (group: string, index?: number) => void;
  setExpression: (id: string) => void;
  destroy: () => void;
}

export async function mountLive2D(
  container: HTMLElement,
  modelUrl: string,
): Promise<Live2DHandle> {
  // Fixed stage size — same as the max-width/max-height we impose on
  // GIF/sequence frames. Live2D model renders at this resolution
  // regardless of the container/window size, so the pet never grows
  // when the user enlarges the window.
  const STAGE_W = 320;
  const STAGE_H = 360;
  const stageW = STAGE_W;
  const stageH = STAGE_H;

  const app = new PIXI.Application({
    width: stageW,
    height: stageH,
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  // Cap render frequency. PIXI's default ticker is tied to
  // requestAnimationFrame and runs at the display's refresh rate (60/120/144
  // Hz). On a 144 Hz display this means the GPU repaints the Live2D model
  // 144 times per second even though the model itself only does subtle
  // breathing motion — a transparent window with continuous invalidate is
  // expensive on Windows DWM compositing. Capping at 30 fps cuts the
  // repaint cost by 3-5x with no visible difference for a desktop pet.
  app.ticker.maxFPS = 30;
  container.appendChild(app.view as HTMLCanvasElement);

  const model = (await Live2DModel.from(modelUrl, {
    autoInteract: false, // we drive focus/eye manually below
  }).catch((err: unknown) => {
    console.error('[live2d] failed to load', modelUrl, err);
    throw err;
  })) as unknown as PIXI.Sprite & {
    motion: (group: string, index?: number) => Promise<void>;
    expression: (id: string | number) => Promise<void>;
    focus: (x: number, y: number) => void;
    hitTest: (x: number, y: number, areas?: string[]) => string | undefined;
  };

  // Layout: v0.4 Live2DModel extends Sprite so we have anchor. Set feet at
  // bottom-center of the stage, scale to fit ~85% of stage height.
  const refW = model.width || 1000;
  const refH = model.height || 1000;
  const targetH = stageH * 0.85;
  const scale = Math.min(targetH / refH, 1.5);
  model.anchor.set(0.5, 1.0);
  model.position.set(stageW / 2, stageH);
  model.scale.set(scale);
  app.stage.addChild(model);

  // Idle motion is driven by the animation state machine (see state-machine.ts),
  // so we don't auto-loop here. Leaving the auto-loop would double-trigger Idle
  // and fight with state transitions. The state machine calls `playMotion`
  // whenever it enters or leaves the idle state.

  // Mouse-tracking eyes. Live2D's focus Y is "up" (positive = look up), but
  // the browser's clientY goes down — flip so the eyes follow naturally.
  //
  // Throttle by collapsing moves into the next animation frame. A fast
  // mouse can fire pointermove 200+ times per second; the focus() call is
  // cheap individually but the cumulative cost on the renderer process
  // adds up, and the value only matters at render time. Pushing into rAF
  // means we compute focus at most once per frame (which is now capped
  // to 30 fps above) — intermediate events are dropped silently.
  let pendingPointer: { x: number; y: number } | null = null;
  let focusScheduled = false;
  const flushFocus = (): void => {
    focusScheduled = false;
    if (!pendingPointer) return;
    const p = pendingPointer;
    pendingPointer = null;
    const rect = (app.view as HTMLCanvasElement).getBoundingClientRect();
    const nx = ((p.x - rect.left) / rect.width) * 2 - 1;
    const ny = ((p.y - rect.top) / rect.height) * 2 - 1;
    model.focus(
      Math.max(-1, Math.min(1, nx)),
      Math.max(-1, Math.min(1, -ny)),
    );
  };
  const onPointerMove = (e: PointerEvent): void => {
    pendingPointer = { x: e.clientX, y: e.clientY };
    if (focusScheduled) return;
    focusScheduled = true;
    requestAnimationFrame(flushFocus);
  };
  window.addEventListener('pointermove', onPointerMove);

  // Click → fire `pet:interaction` on every click (the state machine listens
  // for this), and trigger a Tap motion as the immediate reaction. If the
  // model has hit-areas defined ("head"/"body"), include which one was hit
  // in the event detail so future code (e.g. emotion selection) can branch
  // on it.
  const onPointerDown = (e: PointerEvent) => {
    const rect = (app.view as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = model.hitTest(x, y, ['head', 'body']);
    window.dispatchEvent(
      new CustomEvent('pet:interaction', {
        detail: { area: hit ?? 'body' },
      }),
    );
    model.motion('Tap').catch(() => {});
  };
  (app.view as HTMLCanvasElement).addEventListener('pointerdown', onPointerDown);

  return {
    playMotion: (group, index = 0) => {
      model.motion(group, index).catch(() => {});
    },
    setExpression: (id) => {
      model.expression(id).catch(() => {});
    },
    destroy: () => {
      window.removeEventListener('pointermove', onPointerMove);
      (app.view as HTMLCanvasElement).removeEventListener('pointerdown', onPointerDown);
      app.destroy(true, { children: true });
    },
  };
}