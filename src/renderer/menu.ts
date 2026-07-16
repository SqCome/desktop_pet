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
export type MenuAction = 'chat' | 'reminder' | 'weather' | 'notes' | 'settings' | 'quit';

const MENU_LOCK = 'menu';

export function setupMenu(canvas: HTMLElement, onAction: (a: MenuAction) => void): void {
  const menu = document.getElementById('menu') as HTMLDivElement;
  let menuOpen = false;

  const openMenu = () => {
    menu.classList.remove('hidden');
    window.petApi.pet.lockInteractive(MENU_LOCK);
    menuOpen = true;
  };

  const closeMenu = () => {
    if (!menuOpen) return;
    menu.classList.add('hidden');
    window.petApi.pet.unlockInteractive(MENU_LOCK);
    menuOpen = false;
  };

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    console.log('[menu] contextmenu fired');
    openMenu();
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