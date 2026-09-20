import { sendBoard } from './board';
import { bootSession } from './session';
import { updateSummary } from './summary';
import { initWindow, handleResize, handleResetSize, handleMinimize, handleExpand, handleTextSize } from './window';

figma.showUI(__html__, { width: 280, height: 380, themeColors: true });

// Reads the saved geometry and resizes to it once it arrives; see window.ts
// for why this can't just be another field on figma.showUI's own options.
initWindow();

// Give the UI a board snapshot up front so the first reply is never board-blind.
sendBoard();

// Identity for the group session. clientId is async (clientStorage); roomId
// and displayName are available immediately. The UI waits for this before
// opening the Worker socket.
bootSession();

figma.ui.onmessage = (msg) => {
  if (msg.type === 'get-board') {
    sendBoard();
  }

  if (msg.type === 'update-summary') {
    updateSummary(msg.text || '');
  }

  if (msg.type === 'resize') {
    handleResize(msg.width, msg.height);
  }

  if (msg.type === 'reset-size') {
    handleResetSize();
  }

  if (msg.type === 'minimize') {
    handleMinimize();
  }

  if (msg.type === 'expand') {
    handleExpand();
  }

  if (msg.type === 'text-size') {
    handleTextSize(msg.size);
  }
};
