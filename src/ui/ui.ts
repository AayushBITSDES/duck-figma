import { idleDuck } from './screens';
import { post } from './bridge';
import { state } from './state';
import './bridge';

// One delegated listener instead of rebinding these after every repaint. The
// collapse control and the collapsed duck are the only two controls that
// outlive a screen, so they are the only two handled here.
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target || !target.closest) return;
  if (target.closest('#min')) post({ type: 'minimize' });
  else if (target.closest('#collapsed')) post({ type: 'expand' });
});

// Figma fires no resize event and draws no handle, so the only way a plugin
// window changes size is by asking the sandbox side to call figma.ui.resize.
// Pointer capture keeps the drag alive when the cursor outruns the 14px grip,
// which it will immediately on any real drag.
const grip = document.getElementById('grip');
if (grip) {
  let dragging = false;
  grip.addEventListener('pointerdown', (e) => {
    dragging = true;
    grip.setPointerCapture((e as PointerEvent).pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (dragging && !state.minimized) {
      const p = e as PointerEvent;
      // The plugin clamps these, so sending an undersized value is harmless
      // and there is no reason to duplicate the bounds on this side.
      post({ type: 'resize', width: Math.floor(p.clientX + 6), height: Math.floor(p.clientY + 6) });
    }
  });
  const stop = (e: Event) => {
    dragging = false;
    const id = (e as PointerEvent).pointerId;
    if (grip.hasPointerCapture(id)) grip.releasePointerCapture(id);
  };
  grip.addEventListener('pointerup', stop);
  grip.addEventListener('pointercancel', stop);
}

idleDuck();
