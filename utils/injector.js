'use strict';
/**
 * utils/injector.js
 * JavaScript injection engine.
 * - Injects custom JS from a file (Ctrl+Shift+J)
 * - Builds the paste-injection payload (screenshot → AI chat input)
 * - Shadow DOM traversal for deep element targeting (mirrors Ultralay's __ovDq logic)
 */

const fs   = require('fs');
const path = require('path');

// Default inject file path (user can place custom JS here)
const DEFAULT_INJECT_FILE = path.join(process.cwd(), 'inject', 'custom.js');

/**
 * Inject JS from a file into the overlay window's page context.
 * @param {BrowserWindow} win
 * @param {Logger} log
 */
async function injectFromFile(win, log) {
  if (!win || win.isDestroyed()) return;

  // Try user-supplied custom.js first, then paste-inject.js
  const candidates = [
    DEFAULT_INJECT_FILE,
    path.join(__dirname, '..', 'inject', 'paste-inject.js'),
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const code = fs.readFileSync(file, 'utf8');
        log.info(`[inject] reading ${file} (${code.length} bytes)`);
        const result = await win.webContents.executeJavaScript(
          `(function(){${code}})()`, true
        );
        log.info(`[inject] result: ${String(result).slice(0, 120)}`);
        return result;
      } catch (err) {
        log.error(`[inject] could not read or execute ${file}: ${err.message}`);
      }
    } else {
      log.warn(`[inject] could not read ${file}`);
    }
  }
}

/**
 * Build the paste-injection script for a given PNG image path.
 * Reconstructed from Ultralay binary strings — exact same logic:
 *   1. Read PNG file → base64
 *   2. In-page JS: atob → Uint8Array → File → DataTransfer → ClipboardEvent('paste')
 *   3. Shadow DOM traversal to find the AI chat input
 *   4. Dispatch paste event on it
 *
 * @param {string} imgPath - Absolute path to PNG file
 * @returns {string} JS code string ready to be eval'd in the page
 */
function buildPasteScript(imgPath) {
  // Read the PNG and base64-encode it (done in main process)
  const buf = fs.readFileSync(imgPath);
  const b64 = buf.toString('base64');

  // This is the reconstructed paste-injection JS (mirrors Ultralay exactly)
  return `
(function(b64) {
  var log = [];

  /* Step 1: Decode base64 PNG → File object */
  var file;
  try {
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    file = new File([new Blob([arr], { type: 'image/png' })], 'overlay-screenshot.png', { type: 'image/png' });
    log.push('file:' + file.size);
  } catch(e) { return 'build-file-failed:' + e; }

  /* Step 2: Shadow DOM deep query helper — mirrors Ultralay's __ovDq */
  function __ovDq(root, sel) {
    if (root.querySelector) {
      var r = root.querySelector(sel);
      if (r) return r;
    }
    var els = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var i = 0; i < els.length; i++) {
      if (els[i].shadowRoot) {
        var r = __ovDq(els[i].shadowRoot, sel);
        if (r) return r;
      }
    }
    return null;
  }

  /* Step 3: Find AI chat input — mirrors Ultralay's __ovFind */
  var t = null;
  try {
    function __ovFind() {
      // ChatGPT
      var x = __ovDq(document, '#prompt-textarea');
      if (x) return x;
      // Generic composer
      x = __ovDq(document, '[data-testid="composer-text-input"]');
      if (x) return x;
      // Claude / Gemini / others — any visible contenteditable
      var ce = __ovDq(document, '[contenteditable="true"]');
      if (ce && (ce.offsetParent || ce.getClientRects().length)) return ce;
      // Last resort: active element
      if (document.activeElement && document.activeElement !== document.body) return document.activeElement;
      return null;
    }
    t = __ovFind();
    if (!t || t === document.body) return 'no-target';
    t.focus();
    log.push('target:' + t.tagName + (t.id ? '#'+t.id : ''));
  } catch(e) { return 'target-failed:' + e; }

  /* Step 4: Build DataTransfer with the PNG file */
  function makeCD(dt) {
    if (dt && dt.items && dt.items.add) {
      try { dt.items.add(file); log.push('dt-add:ok'); return dt; }
      catch(e) { log.push('dt-add:fail'); }
    }
    return {
      files: [file],
      types: ['Files'],
      items: {
        length: 1,
        0: { kind: 'file', type: 'image/png', getAsFile: function() { return file; } },
        add: function() {},
        clear: function() {}
      },
      getData: function() { return ''; },
      setData: function() { return false; }
    };
  }

  var cd;
  try { cd = makeCD(new DataTransfer()); }
  catch(e) { log.push('dt-ctor:fail'); cd = makeCD(null); }

  /* Step 5: Dispatch synthetic ClipboardEvent('paste') */
  var ev;
  try {
    ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: cd });
    if (!ev.clipboardData) {
      ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: cd });
      log.push('ce:ctor-dropped-cd');
    } else {
      log.push('ce:ctor-ok');
    }
  } catch(e) {
    ev = new Event('paste', { bubbles: true, cancelable: true });
    try { Object.defineProperty(ev, 'clipboardData', { value: cd }); log.push('ce:define'); }
    catch(e2) { ev.clipboardData = cd; log.push('ce:assign'); }
  }

  var accepted = t.dispatchEvent(ev);
  log.push('dispatched:' + (accepted ? 'default' : 'prevented'));
  return log.join('|');

})(${JSON.stringify(b64)});
`;
}

module.exports = { injectFromFile, buildPasteScript };
