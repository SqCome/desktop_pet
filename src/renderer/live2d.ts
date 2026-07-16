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
  const stageW = container.clientWidth;
  const stageH = container.clientHeight;

  const app = new PIXI.Application({
    width: stageW,
    height: stageH,
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
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
  const onPointerMove = (e: PointerEvent) => {
    const rect = (app.view as HTMLCanvasElement).getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    model.focus(
      Math.max(-1, Math.min(1, nx)),
      Math.max(-1, Math.min(1, -ny)),
    );
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