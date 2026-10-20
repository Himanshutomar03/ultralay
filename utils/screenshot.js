'use strict';
/**
 * utils/screenshot.js
 *
 * Screenshot capture with 3-tier method chain (matching original Ultralay):
 *
 *  1. PrintWindow  (primary)   — Win32 GDI + PW_RENDERFULLCONTENT via PowerShell
 *                                Captures SEB-protected / WDA_EXCLUDEFROMCAPTURE windows.
 *                                Same method used by the original Ultralay C++ binary.
 *
 *  2. desktopCapturer (fallback) — Electron Chromium API.
 *                                Works on most screens but misses protected windows.
 *
 *  3. clipboard image (last)   — If user has something in the clipboard already.
 *
 * All methods save as timestamped PNG: overlay-YYYYMMDD-HHMMSS.png
 */

const { desktopCapturer, clipboard, screen } = require('electron');
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const PW_SCRIPT = path.join(__dirname, '..', 'scripts', 'printwindow-capture.ps1');

class Screenshot {
  /**
   * @param {string} screenshotDir
   * @param {Logger} log
   */
  constructor(screenshotDir, log) {
    this.dir = screenshotDir;
    this.log = log;
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  /**
   * Capture the screen and save to a PNG file.
   * @param {BrowserWindow} overlayWin - Temporarily hidden during capture.
   * @returns {Promise<string>} Absolute path to saved PNG.
   */
  async capture(overlayWin) {
    const outPath = this._buildPath();
    const { width, height } = screen.getPrimaryDisplay().size;
    this.log.info(`[screenshot] starting capture ${width}x${height} → ${path.basename(outPath)}`);

    // Hide overlay so it doesn't appear in the screenshot
    const wasVisible = overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible();
    if (wasVisible) {
      overlayWin.hide();
      await this._sleep(100); // wait for compositor to redraw without our window
    }

    let success = false;
    try {
      // ── Method 1: PrintWindow (PW_RENDERFULLCONTENT) ──────────────────────
      success = await this._captureViaPrintWindow(outPath, width, height);

      // ── Method 2: desktopCapturer fallback ───────────────────────────────
      if (!success) {
        this.log.warn('[screenshot] PrintWindow failed — trying desktopCapturer');
        success = await this._captureViaDesktopCapturer(outPath, width, height);
      }

      if (!success) throw new Error('all capture methods failed');

      // Copy to clipboard
      try {
        const { nativeImage } = require('electron');
        const img = nativeImage.createFromPath(outPath);
        clipboard.writeImage(img);
        this.log.info(`[screenshot] saved → ${outPath} (clipboard: yes)`);
      } catch (_) {
        this.log.info(`[screenshot] saved → ${outPath} (clipboard: no)`);
      }

    } finally {
      if (wasVisible && overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.show();
        overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
      }
    }

    return outPath;
  }

  // ─── Method 1: PrintWindow via PowerShell C# ──────────────────────────────
  async _captureViaPrintWindow(outPath, width, height) {
    return new Promise(resolve => {
      try {
        // Escape path for PowerShell (wrap in quotes, escape internal quotes)
        const safePath = outPath.replace(/'/g, "''");
        const cmd = [
          'powershell',
          '-NonInteractive',
          '-WindowStyle', 'Hidden',
          '-File', `"${PW_SCRIPT}"`,
          '-OutputPath', `"${safePath}"`,
        ].join(' ');

        const output = execSync(cmd, {
          timeout: 15000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (output.includes('OK:') && fs.existsSync(outPath)) {
          const size = fs.statSync(outPath).size;
          this.log.info(
            `[screenshot] PrintWindow(PW_RENDERFULLCONTENT) → ${outPath} (${size} bytes)`
          );
          resolve(true);
        } else {
          this.log.warn(`[screenshot] PrintWindow output: ${output.trim()}`);
          resolve(false);
        }
      } catch (e) {
        this.log.warn(`[screenshot] PrintWindow exception: ${e.message}`);
        resolve(false);
      }
    });
  }

  // ─── Method 2: Electron desktopCapturer fallback ──────────────────────────
  async _captureViaDesktopCapturer(outPath, width, height) {
    try {
      const sources = await desktopCapturer.getSources({
        types:         ['screen'],
        thumbnailSize: { width, height },
        fetchWindowIcons: false,
      });

      const src = sources.find(s =>
        s.name === 'Entire Screen' || s.name === 'Screen 1' || s.id.startsWith('screen:')
      ) || sources[0];

      if (!src) {
        this.log.warn('[screenshot] desktopCapturer: no screen source found');
        return false;
      }

      const img = src.thumbnail;
      if (!img || img.isEmpty()) {
        this.log.warn('[screenshot] desktopCapturer: empty thumbnail (capture-protected)');
        return false;
      }

      const buf = img.toPNG();
      fs.writeFileSync(outPath, buf);
      this.log.info(`[screenshot] desktopCapturer → ${outPath} (${buf.length} bytes)`);
      return true;
    } catch (e) {
      this.log.warn(`[screenshot] desktopCapturer exception: ${e.message}`);
      return false;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  _buildPath() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return path.join(this.dir, `overlay-${date}-${time}.png`);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = Screenshot;
