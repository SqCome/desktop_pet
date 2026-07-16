// Animation state machine for the pet.
//
// States:
//   - idle:    looping `Idle` motion. The default state.
//   - touch:   one-shot reaction to being poked/tapped. Returns to idle after.
//   - speak:   triggered by chat streaming. The pet "looks at the camera"
//              while the message comes in, then goes back to idle.
//   - greet:   rare proactive wave — fires after N seconds of idle to make
//              the pet feel alive instead of decoratively looping.
//
// Configuration lives in `PetAnimationConfig` (shared/types.ts) and is
// passed in from the renderer entry, which reads it from main's
// `AppConfig`. Users can tweak timings and motion names via `config.json`
// without touching code.
//
// To add a new state: add a value to `PetState`, add a field on
// `PetAnimationConfig`, add a case to `enter()`, and (optionally) wire
// a trigger from `pet:interaction` or chat events.

import type { PetHandle } from './pet';
import type { PetAnimationConfig } from '../shared/types';

export type PetState = 'idle' | 'touch' | 'speak' | 'greet' | 'attention';

export class PetStateMachine {
  private state: PetState = 'idle';
  private pet: PetHandle;
  private cfg: PetAnimationConfig;
  private returnTimer: number | null = null;
  private greetTimer: number | null = null;

  constructor(pet: PetHandle, cfg: PetAnimationConfig) {
    this.pet = pet;
    this.cfg = cfg;
    this.enter('idle');
    this.scheduleGreet();
  }

  getState(): PetState {
    return this.state;
  }

  /** Called by mouse/touch interaction handlers. */
  poke(): void {
    this.cancelReturn();
    this.enter('touch');
    this.scheduleReturn('idle', this.cfg.touchDurationMs);
    this.rescheduleGreet();
  }

  /** Hold "speaking" while chat is streaming. Pass false to release. */
  setSpeaking(active: boolean): void {
    if (active) {
      this.cancelReturn();
      this.cancelGreet();
      this.enter('speak');
    } else {
      this.enter('idle');
      this.scheduleReturn('idle', 0);
      this.rescheduleGreet();
    }
  }

  /** Force a proactive greet (e.g. when app launches). */
  greet(): void {
    this.cancelReturn();
    this.enter('greet');
    this.scheduleReturn('idle', this.cfg.greetDurationMs);
    this.rescheduleGreet();
  }

  /**
   * Briefly flash the "attention" mood. Used when a Claude Code hook
   * fires — the bubble carries the message, this just signals "look at me".
   * Returns to idle after `greetDurationMs` (we reuse the same timer;
   * no need to add a new config knob for v1).
   */
  attention(): void {
    this.cancelReturn();
    this.cancelGreet();
    this.enter('attention');
    this.scheduleReturn('idle', this.cfg.greetDurationMs);
    this.rescheduleGreet();
  }

  /** Replace the running config (e.g. from a settings panel hot-reload). */
  updateConfig(next: PetAnimationConfig): void {
    this.cfg = next;
    // Re-apply the current state's motion so changes take effect immediately.
    this.playCurrentStateMotion();
  }

  destroy(): void {
    this.cancelReturn();
    this.cancelGreet();
  }

  // -- internals --------------------------------------------------------

  private enter(next: PetState): void {
    if (this.state === next) {
      // Still re-trigger the motion so config changes (e.g. switching to a
      // different motion group) take effect on the active state.
      this.playMotionForState(next);
      return;
    }
    this.state = next;
    this.playMotionForState(next);
  }

  private playCurrentStateMotion(): void {
    this.playMotionForState(this.state);
  }

  private playMotionForState(state: PetState): void {
    switch (state) {
      case 'idle':       this.pet.playMotion(this.cfg.idleMotion); break;
      case 'touch':      this.pet.playMotion(this.cfg.touchMotion); break;
      case 'speak':      this.pet.playMotion(this.cfg.speakMotion); break;
      case 'greet':      this.pet.playMotion(this.cfg.greetMotion); break;
      case 'attention':  this.pet.playMotion(this.cfg.idleMotion); break;
    }
  }

  private scheduleReturn(to: PetState, ms: number): void {
    this.cancelReturn();
    if (ms <= 0) {
      this.enter(to);
      return;
    }
    this.returnTimer = window.setTimeout(() => {
      this.returnTimer = null;
      this.enter(to);
    }, ms);
  }

  private cancelReturn(): void {
    if (this.returnTimer !== null) {
      window.clearTimeout(this.returnTimer);
      this.returnTimer = null;
    }
  }

  /** Fire `greet` after N seconds of no interaction, to keep the pet lively. */
  private scheduleGreet(): void {
    this.cancelGreet();
    this.greetTimer = window.setTimeout(() => {
      this.greetTimer = null;
      // Only greet if we're still idling — don't interrupt speak/touch.
      if (this.state === 'idle') this.greet();
    }, this.cfg.greetAfterIdleMs);
  }

  private cancelGreet(): void {
    if (this.greetTimer !== null) {
      window.clearTimeout(this.greetTimer);
      this.greetTimer = null;
    }
  }

  /** Reset the greet countdown — called after any user interaction. */
  private rescheduleGreet(): void {
    this.scheduleGreet();
  }
}