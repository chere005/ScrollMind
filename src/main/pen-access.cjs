'use strict';

// What to tell a person about their pen display's side buttons, from what the helper reports (status) of Input Monitoring
// and of a supported display. macOS opens the display's interface for any app but delivers its button reports only to an
// app with Input Monitoring, so without it the buttons reach ScrollMind only as far as the Wacom driver passes them on.

const SETTINGS_BUTTON = 'Open System Settings';

/**
 * Null when there is nothing to say (no supported pen display, or Input Monitoring is on and this was not asked for).
 * Otherwise the dialog: { message, detail, buttons, opensSettings }.
 */
function penAccessPrompt({ access, opened }, { manual = false } = {}) {
  if (!opened) {
    return manual ? { message: 'No supported pen display found', detail: 'ScrollMind reads the side buttons of a Wacom One 12 on a Mac. Connect the display and choose this again.', buttons: ['OK'], opensSettings: false } : null;
  }
  if (access === 'granted') {
    return manual ? { message: 'Your pen display’s buttons are on', detail: 'ScrollMind reads the side buttons of your Wacom pen display directly, whatever Wacom Center assigns to them.', buttons: ['OK'], opensSettings: false } : null;
  }
  return {
    message: 'Turn on Input Monitoring for your pen display’s buttons',
    detail: 'macOS lets an app read a pen display’s side buttons only with your permission. In System Settings, open Privacy & Security ▸ Input Monitoring, turn on ScrollMind, then reopen ScrollMind. Until then the buttons work only as far as the Wacom driver passes them on.',
    buttons: [SETTINGS_BUTTON, 'Not Now'],
    opensSettings: true,
  };
}

module.exports = { penAccessPrompt };
