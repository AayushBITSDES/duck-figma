import { sendBoard } from './board';
import { startIdleWatch, dismissCheckIn } from './idle';
import { loadSettings, saveSettings } from './settings-store';
import { dropSticky } from './sticky';

figma.showUI(__html__, { width: 280, height: 380, themeColors: true });

startIdleWatch();

loadSettings();

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
};
