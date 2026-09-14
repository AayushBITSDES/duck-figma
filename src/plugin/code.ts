import { sendBoard } from './board';
import { startIdleWatch, dismissCheckIn } from './idle';
import { loadSettings, saveSettings } from './settings-store';
import { dropSticky } from './sticky';
import { initWindow, handleResize, handleMinimize, handleExpand, handleTextSize, handleUiMode } from './window';

figma.showUI(__html__, { width: 280, height: 380, themeColors: true });

startIdleWatch();

loadSettings();

// Reads the saved geometry and resizes to it once it arrives; see window.ts
// for why this can't just be another field on figma.showUI's own options.
initWindow();

// Give the UI a board snapshot up front so the first reply is never board-blind.
sendBoard();

figma.ui.onmessage = (msg) => {
  if (msg.type === 'dismiss') {
    dismissCheckIn();
  }

  if (msg.type === 'get-board') {
    sendBoard();
  }

  if (msg.type === 'drop-sticky') {
    dropSticky(msg.text || 'What are you stuck on?');
  }

  // A save carries the whole of the settings, so there is nothing to merge onto
  // and nothing for two saves to race over.
  if (msg.type === 'save-settings') {
    saveSettings(msg.provider, msg.key);
  }

  if (msg.type === 'resize') {
    handleResize(msg.width, msg.height);
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

  // See the MESSAGE CONTRACT comment in window.ts: this is how the plugin
  // finds out whether the UI is actually idle, since it has no window into
  // that on its own.
  if (msg.type === 'mode') {
    handleUiMode(msg.mode);
  }
};
