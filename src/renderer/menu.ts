// Right-click menu wiring. Right-click anywhere on the pet opens the menu;
// clicking outside closes it.
//
// The main window is `setIgnoreMouseEvents(true)` by default for click-
// through. While the menu is open, the user has to move the cursor AWAY
// from the pet canvas to reach the menu items — that's exactly the moment
// mouseleave would normally flip us back to click-through, killing the menu.
//
// We solve this with an "interactive lock": main holds a counter of named
// locks; while at least one lock is held, the window stays interactive
// regardless of cursor position. The lock is released when the menu closes.
export type MenuAction = 'chat' | 'reminder' | 'weather' | 'notes' | 'settings' | 'quit' | 'todos';

const MENU_LOCK = 'menu';

export function setupMenu(canvas: HTMLElement, onAction: (a: MenuAction) => void): void {
  const menu = document.getElementById('menu') as HTMLDivElement;
  let menuOpen = false;

  /** Position the menu at (clientX, clientY) and clamp so it stays
   * within the viewport. The menu is absolutely positioned inside
   * #stage (100vw×100vh), so clientX/Y map directly. */
  const positionMenu = (cx: number, cy: number) => {
    const rect = menu.getBoundingClientRect();
    const mw = rect.width || 140;  // fallback width before layout
    const mh = rect.height || 320;
    const pad = 6;
    let x = Math.min(cx, window.innerWidth - mw - pad);
    let y = Math.min(cy, window.innerHeight - mh - pad);
    x = Math.max(pad, x);
    y = Math.max(pad, y);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  };

  const openMenu = (cx: number, cy: number) => {
    menu.classList.remove('hidden');
    // Force layout so getBoundingClientRect returns real dimensions.
    // Use requestAnimationFrame to wait one frame for the browser to
    // compute the layout box, then clamp.
    requestAnimationFrame(() => positionMenu(cx, cy));
    window.petApi.pet.lockInteractive(MENU_LOCK);
    menuOpen = true;
  };

  const closeMenu = () => {
    if (!menuOpen) return;
    menu.classList.add('hidden');
    window.petApi.pet.unlockInteractive(MENU_LOCK);
    menuOpen = false;
  };

  // Listen on the document so right-click works even when the bubble
  // stack (z-index 6) overlaps the pet canvas (z-index 1) and would
  // otherwise intercept the event. Only open the menu when the click
  // target is inside the pet area or the bubble stack — not the todo
  // panel, settings, or chat window.
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as Node;
    const canvas = document.getElementById('pet-canvas');
    const stack = document.getElementById('bubble-stack');
    const inPetArea = canvas?.contains(target) || stack?.contains(target);
    if (!inPetArea) return;
    e.preventDefault();
    console.log('[menu] contextmenu fired');
    openMenu(e.clientX, e.clientY);
  });

  // Close on outside LEFT-click only. Right-click fires `mousedown` before
  // `contextmenu`, so filtering by button prevents closing the menu the
  // same instant we open it.
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (!menuOpen) return;
    if (!menu.contains(e.target as Node)) closeMenu();
  });

  menu.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action as MenuAction;
      console.log('[menu] clicked:', action);
      closeMenu();
      onAction(action);
    });
  });
}