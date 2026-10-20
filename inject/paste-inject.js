/**
 * inject/paste-inject.js
 * Standalone paste injection script.
 * Can be dropped onto the overlay via Ctrl+Shift+J to manually inject
 * the last clipboard image into the active AI chat input.
 *
 * This script is also used internally by injector.js for screenshot → paste flow.
 */

(function() {
  'use strict';

  // ── Shadow DOM deep query (mirrors Ultralay __ovDq) ──────────────────────
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

  // ── Find AI chat input (mirrors Ultralay __ovFind) ──────────────────────
  function __ovFind() {
    var t;
    // ChatGPT
    t = __ovDq(document, '#prompt-textarea');
    if (t) return t;
    // Composer data-testid
    t = __ovDq(document, '[data-testid="composer-text-input"]');
    if (t) return t;
    // Claude / Gemini / Perplexity / Copilot — visible contenteditable
    var ces = document.querySelectorAll('[contenteditable="true"]');
    for (var i = 0; i < ces.length; i++) {
      if (ces[i].offsetParent || ces[i].getClientRects().length) {
        return ces[i];
      }
    }
    // Textarea fallback
    t = __ovDq(document, 'textarea');
    if (t && (t.offsetParent || t.getClientRects().length)) return t;
    // Active element
    if (document.activeElement && document.activeElement !== document.body) return document.activeElement;
    return null;
  }

  // ── Read clipboard image and paste it ────────────────────────────────────
  async function pasteClipboardImage() {
    var target = __ovFind();
    if (!target || target === document.body) {
      if (window.console) console.log('CEFOV: no-target');
      return 'no-target';
    }
    target.focus();

    try {
      var items = await navigator.clipboard.read();
      for (var item of items) {
        for (var type of item.types) {
          if (type.startsWith('image/')) {
            var blob = await item.getType(type);
            var file = new File([blob], 'overlay-screenshot.png', { type: type });

            var dt;
            try { dt = new DataTransfer(); dt.items.add(file); }
            catch(e) {
              dt = {
                files: [file], types: ['Files'],
                items: { length:1, 0:{ kind:'file', type:type, getAsFile:()=>file }, add:()=>{}, clear:()=>{} },
                getData:()=>'', setData:()=>false
              };
            }

            var ev;
            try {
              ev = new ClipboardEvent('paste', { bubbles:true, cancelable:true, clipboardData:dt });
            } catch(e) {
              ev = new Event('paste', { bubbles:true, cancelable:true });
              Object.defineProperty(ev, 'clipboardData', { value:dt });
            }

            target.dispatchEvent(ev);
            if (window.console) console.log('CEFOV: pasted image from clipboard to', target.tagName);
            return 'pasted:' + target.tagName;
          }
        }
      }
      return 'no-image-in-clipboard';
    } catch(e) {
      if (window.console) console.log('CEFOV: clipboard read failed:', e.message);
      return 'clipboard-error:' + e.message;
    }
  }

  return pasteClipboardImage();
})();
