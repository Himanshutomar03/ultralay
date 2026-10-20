'use strict';
/**
 * utils/stealth.js  —  Win32 stealth window styles
 *
 * Uses two strategies:
 *  1. koffi (fast FFI, zero-build) — direct user32.dll calls, no PowerShell
 *  2. PowerShell inline (fallback) — single -Command string, no script file
 *
 * Win32 flags applied:
 *   WS_EX_TRANSPARENT  0x00000020  clicks pass through to window below
 *   WS_EX_NOACTIVATE   0x08000000  clicking never activates/focuses window
 *   WS_EX_TOOLWINDOW   0x00000080  hidden from Alt+Tab / task switcher
 *
 * SetWindowDisplayAffinity:
 *   WDA_NONE                 0x00  — visible in capture
 *   WDA_MONITOR              0x01  — black in capture (Win7+)
 *   WDA_EXCLUDEFROMCAPTURE   0x11  — invisible in capture (Win10 2004+)
 */

const { execSync } = require('child_process');

let koffi = null, user32 = null;
let GetWindowLongPtrW, SetWindowLongPtrW, SetWindowDisplayAffinity;

// Try to load koffi for direct FFI (fastest, no PowerShell)
try {
  koffi = require('koffi');
  user32 = koffi.load('user32.dll');
  GetWindowLongPtrW      = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr', ['void *', 'int']);
  SetWindowLongPtrW      = user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr', ['void *', 'int', 'intptr']);
  SetWindowDisplayAffinity = user32.func('__stdcall', 'SetWindowDisplayAffinity', 'bool', ['void *', 'uint32']);
} catch (_) {
  koffi = null;
}

const GWL_EXSTYLE         = -20;
const WS_EX_TRANSPARENT   = 0x00000020;
const WS_EX_NOACTIVATE    = 0x08000000;
const WS_EX_TOOLWINDOW    = 0x00000080;
const WDA_NONE            = 0x00;
const WDA_MONITOR         = 0x01;
const WDA_EXCLUDEFROMCAPTURE = 0x11;

// ─── applyExStyles ────────────────────────────────────────────────────────────
function applyExStyles(hwndBuf, log) {
  const hwnd = _readHwnd(hwndBuf);

  // Try koffi (direct FFI)
  if (koffi) {
    try {
      const hwndPtr = _hwndToPtr(hwndBuf);
      const cur  = GetWindowLongPtrW(hwndPtr, GWL_EXSTYLE);
      const next = cur | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
      SetWindowLongPtrW(hwndPtr, GWL_EXSTYLE, next);
      log.info('[stealth] koffi: WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW applied');
      return;
    } catch (e) {
      log.warn(`[stealth] koffi exstyle failed: ${e.message}`);
    }
  }

  // Fallback: PowerShell inline (no script file, much faster)
  try {
    const addStyles = 0x080000A0; // TRANSPARENT | NOACTIVATE | TOOLWINDOW
    const ps = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class W { 
  [DllImport("user32")] public static extern int GetWindowLong(IntPtr h, int n);
  [DllImport("user32")] public static extern int SetWindowLong(IntPtr h, int n, int v);
}
"@ -Language CSharp;
$h=[IntPtr]${hwnd};
$cur=[W]::GetWindowLong($h,-20);
[W]::SetWindowLong($h,-20,$cur -bor ${addStyles});
Write-Output OK`;
    execSync(`powershell -NonInteractive -WindowStyle Hidden -Command "${ps.replace(/\n/g, ' ')}"`,
      { timeout: 8000, stdio: 'pipe' });
    log.info('[stealth] PS-inline: exstyles applied');
  } catch (e) {
    log.warn(`[stealth] exstyles all methods failed: ${e.message}`);
  }
}

// ─── excludeFromCapture ───────────────────────────────────────────────────────
function excludeFromCapture(hwndBuf, log) {
  const hwndPtr = _hwndToPtr(hwndBuf);
  const hwnd    = _readHwnd(hwndBuf);

  // Try koffi → WDA_EXCLUDEFROMCAPTURE
  if (koffi) {
    try {
      if (SetWindowDisplayAffinity(hwndPtr, WDA_EXCLUDEFROMCAPTURE)) {
        log.info('[affinity] koffi: WDA_EXCLUDEFROMCAPTURE → OK');
        return;
      }
    } catch (_) {}
    // Fallback within koffi: WDA_MONITOR
    try {
      if (SetWindowDisplayAffinity(hwndPtr, WDA_MONITOR)) {
        log.info('[affinity] koffi: WDA_MONITOR fallback → OK');
        return;
      }
    } catch (_) {}
  }

  // PowerShell inline fallback
  _psAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE, log) ||
  _psAffinity(hwnd, WDA_MONITOR, log) ||
  log.warn('[affinity] all methods failed — using Electron setContentProtection');
}

// ─── removeFromCapture ────────────────────────────────────────────────────────
function removeFromCapture(hwndBuf, log) {
  const hwndPtr = _hwndToPtr(hwndBuf);
  const hwnd    = _readHwnd(hwndBuf);

  if (koffi) {
    try {
      SetWindowDisplayAffinity(hwndPtr, WDA_NONE);
      log.info('[affinity] koffi: WDA_NONE → capture re-enabled');
      return;
    } catch (_) {}
  }
  _psAffinity(hwnd, WDA_NONE, log);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _psAffinity(hwnd, flag, log) {
  try {
    const ps = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class W2 { [DllImport("user32")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint f); }
"@ -Language CSharp;
if([W2]::SetWindowDisplayAffinity([IntPtr]${hwnd},${flag})){Write-Output OK}else{Write-Output FAIL}`;
    const out = execSync(
      `powershell -NonInteractive -WindowStyle Hidden -Command "${ps.replace(/\n/g,' ')}"`,
      { timeout: 8000, stdio: 'pipe', encoding: 'utf8' }
    );
    if (out.includes('OK')) { log.info(`[affinity] PS-inline flag=${flag} → OK`); return true; }
  } catch (_) {}
  return false;
}

function _readHwnd(buf) {
  try { return buf.readBigUInt64LE(0).toString(); }
  catch (_) { return buf.readUInt32LE(0).toString(); }
}

function _hwndToPtr(buf) {
  if (koffi) {
    try {
      const big = buf.readBigUInt64LE(0);
      return koffi.decode(buf, 'void *');
    } catch (_) {
      return buf;
    }
  }
  return buf;
}

module.exports = { applyExStyles, excludeFromCapture, removeFromCapture };
