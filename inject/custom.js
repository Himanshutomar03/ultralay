/**
 * inject/custom.js
 * Place your custom JavaScript here.
 * Press Ctrl+Shift+J to execute this script in the loaded page.
 *
 * This script runs in the context of the webpage (e.g. chatgpt.com).
 * Return a value to see it in the toast notification.
 *
 * Examples:
 *   document.title = 'Ultralay Test';
 *   return document.title;
 *
 *   // Type text into ChatGPT input:
 *   var t = document.querySelector('#prompt-textarea');
 *   if (t) { t.value = 'Hello!'; t.dispatchEvent(new Event('input')); }
 *   return t ? 'typed' : 'not found';
 */

// Default: log page info
(function() {
  var info = {
    url:   location.href,
    title: document.title,
    inputs: document.querySelectorAll('textarea, [contenteditable]').length,
  };
  if (window.console) console.log('CEFOV: custom inject ran', info);
  return JSON.stringify(info);
})();
