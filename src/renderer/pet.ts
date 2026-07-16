// Pet controller. Handles:
//   - detecting available assets and picking the right renderer
//     (Live2D > GIF > PNG sequence > placeholder)
//   - drag-to-move the underlying BrowserWindow via IPC
//   - click-through toggling: when the cursor is over the pet body, ask main
//     to stop ignoring mouse events so the user can actually drag/click it.
//   - wiring the animation state machine
import type { Live2DHandle } from './live2d';
import type { PetRenderMode } from '../shared/types';
import { PetStateMachine } from './state-machine';

export interface PetHandle {
  /** Trigger a Live2D motion group ("idle", "tap", "shake", ...). No-op for image modes. */
  playMotion: (group: string, index?: number) => void;
  /** Change facial expression. No-op for image modes. */
  setExpression: (id: string) => void;
  destroy: () => void;
}

// Module-level handle so other modules (chat, tools) can reach the pet.
// Tiny global on purpose — there's only ever one pet on screen.
let currentHandle: PetHandle | null = null;
let stateMachine: PetStateMachine | null = null;

export function getPet(): PetHandle | null {
  return currentHandle;
}

export function getStateMachine(): PetStateMachine | null {
  return stateMachine;
}

export async function startPet(
  canvas: HTMLDivElement,
  cfg: {
    mode: PetRenderMode;
    assetDir: string;
    sequenceFrameMs: number;
    animation: import('../shared/types').PetAnimationConfig;
  },
): Promise<PetHandle> {
  // Probe priority: Live2D > GIF > sequence > placeholder.
  // We use HEAD requests so we don't pay the cost of actually loading each
  // variant before settling on one.
  const assetRoot = `assets/${cfg.assetDir}/`;
  const probes: Array<{ mode: Exclude<PetRenderMode, 'auto'>; probe: string; loader: () => Promise<Live2DHandle> }> = [];

  if (cfg.mode === 'auto' || cfg.mode === 'live2d') {
    probes.push({
      mode: 'live2d',
      probe: `${assetRoot}live2d/pet.model3.json`,
      loader: async () => {
        const { mountLive2D } = await import('./live2d');
        return mountLive2D(canvas, `${assetRoot}live2d/pet.model3.json`);
      },
    });
  }
  if (cfg.mode === 'auto' || cfg.mode === 'gif') {
    probes.push({
      mode: 'gif',
      probe: `${assetRoot}animation.gif`,
      loader: async () => {
        const { mountGif } = await import('./gif');
        return mountGif(canvas, `${assetRoot}animation.gif`);
      },
    });
  }
  if (cfg.mode === 'auto' || cfg.mode === 'sequence') {
    probes.push({
      mode: 'sequence',
      probe: `${assetRoot}frames/frame_001.png`,
      loader: async () => {
        const { mountSequence } = await import('./sequence');
        return mountSequence(canvas, `${assetRoot}frames/`, cfg.sequenceFrameMs);
      },
    });
  }

  for (const p of probes) {
    try {
      const r = await fetch(p.probe, { method: 'HEAD' });
      if (r.ok) {
        const handle = await p.loader();
        currentHandle = handle;
        stateMachine = new PetStateMachine(handle, cfg.animation);
        wireInteractionsToStateMachine(stateMachine);
        console.log(`[pet] mounted in ${p.mode} mode`);
        setupDrag(canvas);
        setupClickThrough(canvas);
        return handle;
      }
      console.log(`[pet] probe miss: ${p.mode} (${p.probe}) -> ${r.status}`);
    } catch (err) {
      console.log(`[pet] probe error: ${p.mode} (${p.probe})`, err);
    }
  }

  // No assets at all — fall back to the placeholder so the app still runs.
  console.log('[pet] no assets found, showing placeholder');
  const placeholderHandle = mountPlaceholder(canvas);
  currentHandle = placeholderHandle;
  // State machine still useful for image modes — the GIF/sequence won't
  // react to playMotion but timer-based behavior (greet) is a no-op anyway.
  stateMachine = new PetStateMachine(placeholderHandle, cfg.animation);
  wireInteractionsToStateMachine(stateMachine);
  setupDrag(canvas);
  setupClickThrough(canvas);
  return placeholderHandle;
}

// Bridge events from the renderer's pointer handlers into the state machine.
// Kept as a single subscriber so we can later swap a real event bus here
// without touching the rest of the code.
function wireInteractionsToStateMachine(sm: PetStateMachine): void {
  // Live2D dispatches `pet:interaction` from inside its canvas listener.
  // The placeholder / GIF paths don't dispatch this event; canvas-level
  // clicks are caught by `setupClickThrough` -> we synthesize the event
  // there. But the state machine itself shouldn't know which renderer is
  // active — it just listens for events.
  window.addEventListener('pet:interaction', () => sm.poke());

  // Right-click shouldn't poke (that's the menu) — already handled in
  // menu.ts by preventing default on contextmenu.
}

function mountPlaceholder(canvas: HTMLDivElement): PetHandle {
  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  canvas.appendChild(placeholder);
  return {
    playMotion: () => {},
    setExpression: () => {},
    destroy: () => placeholder.remove(),
  };
}

function setupDrag(canvas: HTMLDivElement) {
  let dragging = false;
  let startX = 0;
  let startY = 0;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // left-click only
    dragging = true;
    startX = e.screenX;
    startY = e.screenY;
    canvas.classList.add('dragging');
    // Stop forwarding mouse events while dragging so Electron's native move kicks in.
    window.petApi.pet.setInteractive(true);
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - startX;
    const dy = e.screenY - startY;
    startX = e.screenX;
    startY = e.screenY;
    // Reserved for future "edge-snap" / "boundary-lock" logic.
    window.dispatchEvent(new CustomEvent('pet:drag', { detail: { dx, dy } }));
  });

  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      canvas.classList.remove('dragging');
    }
  });
}

function setupClickThrough(canvas: HTMLDivElement) {
  // Toggle click-through based on whether the cursor is over the pet body.
  // Main window ignores mouse events by default; renderer toggles it off
  // when the pointer enters the pet's hit-area so dragging/clicking works.
  canvas.addEventListener('mouseenter', () => window.petApi.pet.setInteractive(true));
  canvas.addEventListener('mouseleave', () => window.petApi.pet.setInteractive(false));
}