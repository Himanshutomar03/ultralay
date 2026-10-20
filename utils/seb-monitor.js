'use strict';
/**
 * utils/seb-monitor.js
 * Monitors for Safe Exam Browser windows via Win32 EnumWindows (PowerShell).
 * - Fires onSebDetected when SEB is found
 * - Fires onSebGone when SEB disappears
 * - Keeps overlay always-on-top while SEB is running
 */

const { execSync } = require('child_process');

// PowerShell script to find SEB windows by title/class
const FIND_SEB_PS = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    public static List<string[]> FindSEB() {
        var results = new List<string[]>();
        EnumWindows((hWnd, lp) => {
            if (!IsWindowVisible(hWnd)) return true;
            var title = new StringBuilder(256);
            GetWindowText(hWnd, title, 256);
            var cls   = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            var t = title.ToString().ToLower();
            var c = cls.ToString().ToLower();
            if (t.Contains("safe exam") || t.Contains("safeexam") || t.Contains("seb") ||
                c.Contains("seb") || c.Contains("safeexam")) {
                results.Add(new string[] { hWnd.ToString(), title.ToString(), cls.ToString(), pid.ToString() });
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }
}
"@ -Language CSharp -ErrorAction SilentlyContinue
$wins = [WinEnum]::FindSEB()
foreach ($w in $wins) { Write-Output "$($w[0])|$($w[1])|$($w[2])|$($w[3])" }
`;

let _interval  = null;
let _sebActive = false;
let _callbacks = {};

/**
 * Start monitoring for SEB windows.
 * @param {{ onSebDetected: Function, onSebGone: Function }} callbacks
 * @param {number} [intervalMs=2000] - How often to poll
 */
function start(callbacks, intervalMs = 2000) {
  _callbacks = callbacks || {};
  _sebActive = false;

  _interval = setInterval(() => {
    try {
      const output = execSync(
        `powershell -NonInteractive -WindowStyle Hidden -Command "${FIND_SEB_PS.replace(/"/g, '\\"')}"`,
        { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();

      const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
      const found = lines.length > 0;

      if (found && !_sebActive) {
        _sebActive = true;
        lines.forEach(line => {
          const [hwnd, title] = line.split('|');
          if (_callbacks.onSebDetected) _callbacks.onSebDetected(hwnd, title);
        });
      } else if (!found && _sebActive) {
        _sebActive = false;
        if (_callbacks.onSebGone) _callbacks.onSebGone();
      }
    } catch (_) {
      // Ignore errors (PowerShell may occasionally fail) — keep monitoring
    }
  }, intervalMs);
}

/**
 * Stop the SEB monitor.
 */
function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

/**
 * Check if SEB is currently detected.
 */
function isSebActive() {
  return _sebActive;
}

module.exports = { start, stop, isSebActive };
