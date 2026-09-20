import { showConnecting } from './screens';
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
// Pointer capture keeps the drag alive when the cursor outruns the grip,
// which it will immediately on any real drag.
//
// The size is tracked as a delta from where the drag started, not as the
// cursor's absolute position. Absolute math parks the panel edge exactly
// under the cursor, so any drag faster than the postMessage round trip puts
// the cursor outside the iframe, where no pointer event can reach it and the
// drag dies mid-stroke. A delta keeps whatever slack the user grabbed with.
function wireGrip(id: string, axis: 'x' | 'y' | 'both') {
  const grip = document.getElementById(id);
  if (!grip) return;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  let dragging = false;

  grip.addEventListener('pointerdown', (e) => {
    if (state.minimized) return;
    const p = e as PointerEvent;
    dragging = true;
    startX = p.clientX;
    startY = p.clientY;
    // The iframe's own size is the panel's size, and unlike a mirrored copy
    // of it, it cannot be stale.
    startW = window.innerWidth;
    startH = window.innerHeight;
    grip.setPointerCapture(p.pointerId);
    e.preventDefault();
  });

  grip.addEventListener('pointermove', (e) => {
    if (!dragging || state.minimized) return;
    const p = e as PointerEvent;
    // The plugin clamps these, so sending an out-of-range value is harmless
    // and there is no reason to duplicate the bounds on this side.
    post({
      type: 'resize',
      width: axis === 'y' ? startW : Math.floor(startW + (p.clientX - startX)),
      height: axis === 'x' ? startH : Math.floor(startH + (p.clientY - startY)),
    });
  });

  const stop = (e: Event) => {
    dragging = false;
    const id2 = (e as PointerEvent).pointerId;
    if (grip.hasPointerCapture(id2)) grip.releasePointerCapture(id2);
  };
  grip.addEventListener('pointerup', stop);
  grip.addEventListener('pointercancel', stop);
}

wireGrip('grip-e', 'x');
wireGrip('grip-s', 'y');
wireGrip('grip', 'both');

showConnecting();
