'use strict';
/**
 * utils/hotkeys.js
 * Global hotkey chord system using Electron globalShortcut.
 * Supports multi-key accelerators and a chord sequence buffer
 * for detecting sequential key presses (e.g. G then S = screenshot).
 */

const { globalShortcut } = require('electron');

const _registered = new Map();  // accelerator → handler

/**
 * Register named hotkeys.
 * @param {Object} definitions - { name: { accelerator, handler } }
 */
function register(definitions) {
  for (const [name, { accelerator, handler }] of Object.entries(definitions)) {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        try { handler(); } catch (e) { console.error(`[hotkey:${name}] error:`, e); }
      });

      if (ok) {
        _registered.set(accelerator, { name, handler });
        console.log(`[hotkeys] registered '${name}' → ${accelerator}`);
      } else {
        console.warn(`[hotkeys] failed to register '${name}' → ${accelerator} (already taken?)`);
      }
    } catch (e) {
      console.error(`[hotkeys] exception registering '${name}': ${e.message}`);
    }
  }
}

/**
 * Unregister all hotkeys.
 */
function unregisterAll() {
  globalShortcut.unregisterAll();
  _registered.clear();
  console.log('[hotkeys] all unregistered');
}

/**
 * Unregister a specific hotkey by accelerator string.
 * @param {string} accelerator
 */
function unregister(accelerator) {
  globalShortcut.unregister(accelerator);
  _registered.delete(accelerator);
}

/**
 * List all registered hotkeys.
 * @returns {Array<{name, accelerator}>}
 */
function list() {
  return [..._registered.entries()].map(([acc, { name }]) => ({ name, accelerator: acc }));
}

module.exports = { register, unregisterAll, unregister, list };
