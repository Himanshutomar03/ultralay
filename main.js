'use strict';
/**
 * main.js — Ultralay Clone (stealth edition)
 *
 * Core stealth techniques (from safe-exam-browser-overlay README):
 *  - WS_EX_TRANSPARENT | WS_EX_NOACTIVATE  → input NEVER activates overlay
 *  - setIgnoreMouseEvents(true, {forward})  → Electron click-through by default
 *  - 30 ms watchdog re-asserts alwaysOnTop  → survives SEB's own raise-watchdog
 *  - SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) → hidden from screen capture
 *  - Type 'toolbar' = WS_EX_TOOLWINDOW     → hidden from Alt+Tab / TaskSwitcher
 *  - skipTaskbar: true                      → not in taskbar
 *
 * Interaction model:
 *  - Overlay is CLICK-THROUGH by default (mouse/keys go to whatever is under it)
 *  - Hover over the UI panel → becomes interactive
 *  - Mouse leaves panel → returns to click-through
 *  - Lock mode (Ctrl+Alt+L) → stays interactive until unlocked
 */

const {
  app, BrowserWindow, Tray, Menu,
  globalShortcut, ipcMain, screen,
  nativeImage, shell, clipboard,
} = require('electron');

const path   = require('path');
const fs     = require('fs');

const Logger     = require('./utils/logger');
const Screenshot = require('./utils/screenshot');
const Stealth    = require('./utils/stealth');
const SebMonitor = require('./utils/seb-monitor');
const Hotkeys    = require('./utils/hotkeys');
const ApiCaller  = require('./utils/api-caller');

// ─── Paths ────────────────────────────────────────────────────────────────────
const APP_DATA       = app.getPath('userData');
const LOG_DIR        = path.join(APP_DATA, 'logs');
const SCREENSHOT_DIR = path.join(APP_DATA, 'screenshots');
const CONFIG_FILE    = path.join(APP_DATA, 'config.json');

[LOG_DIR, SCREENSHOT_DIR, path.join(__dirname, 'assets')].forEach(d =>
  fs.mkdirSync(d, { recursive: true })
);

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = new Logger(LOG_DIR);
log.info('overlay: starting');

// ─── Config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {}
  return { keys: {}, opacity: 95, alwaysOnTop: true, width: 480, height: 700 };
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }
  catch (e) { log.error('saveConfig: ' + e.message); }
}
let config = loadConfig();

// ─── State ────────────────────────────────────────────────────────────────────
let overlayWin    = null;
let tray          = null;
let pendingImages = [];
let watchdogTimer = null;  // 30 ms topmost watchdog (mirrors Ultralay)
let isInteractive = false; // current mouse-event mode

// ─── App ─────────────────────────────────────────────────────────────────────
app.commandLine.appendSwitch('no-first-run');
app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity');

app.whenReady().then(() => {
  createTrayIcon();
  createOverlay();
});

app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => {
  clearInterval(watchdogTimer);
  Hotkeys.unregisterAll();
  SebMonitor.stop();
});

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTrayIcon() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Ultralay — AI Overlay (click to show/hide)');
  const menu = Menu.buildFromTemplate([
    { label: '👁  Show / Hide   Alt+`', click: toggleWindow },
    { label: '📸  Screenshot    Ctrl+Alt+S', click: captureScreenshot },
    { label: '🔒  Lock interactive  Ctrl+Alt+L', click: lockInteractive },
    { type: 'separator' },
    { label: '✕  Quit Ultralay  Ctrl+Alt+Q', click: () => { tray.destroy(); app.exit(0); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', toggleWindow);
  log.info('tray: created');
}

// ─── Overlay window ───────────────────────────────────────────────────────────
function createOverlay() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const winW = config.width  || 480;
  const winH = config.height || 700;

  overlayWin = new BrowserWindow({
    width:       winW,
    height:      winH,
    minWidth:    320,
    minHeight:   280,
    x:           sw - winW - 20,
    y:           20,
    // ── Stealth window flags ───────────────────────────────────────────
    transparent: true,       // composited transparent window
    frame:       false,      // no OS chrome
    alwaysOnTop: true,       // topmost
    skipTaskbar: true,       // WS_EX_TOOLWINDOW-ish: not in taskbar
    type:        'toolbar',  // WS_EX_TOOLWINDOW → hidden from Alt+Tab
    focusable:   true,       // must be true for text input to work
    show:        false,
    hasShadow:   false,
    // ──────────────────────────────────────────────────────────────────
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      nodeIntegration:  false,
      contextIsolation: true,
    },
  });

  // ── CRITICAL: start in click-through mode (WS_EX_TRANSPARENT equivalent) ──
  // Mouse events are forwarded to renderer (for hover detection) but clicks
  // pass through to whatever is under the overlay.
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  isInteractive = false;

  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));

  overlayWin.webContents.once('did-finish-load', () => {
    overlayWin.show();
    // Apply WS_EX_NOACTIVATE + WS_EX_TRANSPARENT via Win32
    applyStealthStyles();
    applyStealthMode();
    startWatchdog();
    startSebMonitor();
    registerHotkeys();
    log.info(`[cef] browser created — window ${winW}x${winH} — click-through: ON`);
  });

  // Save size on resize
  overlayWin.on('resize', () => {
    if (!overlayWin?.isDestroyed()) {
      const [w, h] = overlayWin.getSize();
      config.width = w; config.height = h;
      saveConfig(config);
    }
  });

  // Never truly close — just hide
  overlayWin.on('close', e => { e.preventDefault(); overlayWin.hide(); });
}

// ─── 30 ms topmost watchdog (mirrors Ultralay's watchdog) ────────────────────
function startWatchdog() {
  watchdogTimer = setInterval(() => {
    if (overlayWin && !overlayWin.isDestroyed() && config.alwaysOnTop !== false) {
      overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
    }
  }, 30);
}

// ─── Stealth: WS_EX_NOACTIVATE + WS_EX_TRANSPARENT via PowerShell ────────────
function applyStealthStyles() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    const hwndBuf = overlayWin.getNativeWindowHandle();
    Stealth.applyExStyles(hwndBuf, log);
  } catch (e) {
    log.warn(`stealth-exstyles: ${e.message}`);
  }
}

// ─── Display affinity ─────────────────────────────────────────────────────────
function applyStealthMode() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    const hwnd = overlayWin.getNativeWindowHandle();
    Stealth.excludeFromCapture(hwnd, log);
    log.info('display-affinity: excluded from capture');
  } catch (e) {
    log.warn(`display-affinity: ${e.message}`);
    try { overlayWin.setContentProtection(true); } catch (_) {}
  }
}

// ─── Mouse-event mode (called from renderer via IPC) ─────────────────────────
ipcMain.handle('set-interactive', (_, interactive) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (interactive === isInteractive) return;
  isInteractive = interactive;
  if (interactive) {
    // Disable click-through → window now catches all input
    overlayWin.setIgnoreMouseEvents(false);
    overlayWin.focus();
    log.debug('overlay: INTERACTIVE (click-through OFF)');
  } else {
    // Enable click-through → clicks fall to window below
    overlayWin.setIgnoreMouseEvents(true, { forward: true });
    log.debug('overlay: PASSTHROUGH (click-through ON)');
  }
});

let _locked = false;
ipcMain.handle('lock-interactive', (_, lock) => {
  _locked = lock;
  if (lock) {
    isInteractive = true;
    overlayWin?.setIgnoreMouseEvents(false);
    overlayWin?.focus();
    log.info('overlay: LOCKED interactive');
  } else {
    isInteractive = false;
    overlayWin?.setIgnoreMouseEvents(true, { forward: true });
    log.info('overlay: UNLOCKED → passthrough');
  }
  overlayWin?.webContents.send('lock-changed', lock);
});

function lockInteractive() {
  _locked = !_locked;
  ipcMain.emit('lock-interactive', null, _locked);
  overlayWin?.webContents.send('lock-changed', _locked);
}

// ─── Toggle window show/hide ──────────────────────────────────────────────────
function toggleWindow() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayWin.isVisible()) {
    overlayWin.hide();
    log.info('overlay: hidden');
  } else {
    overlayWin.show();
    overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
    log.info('overlay: shown');
  }
}

// ─── SEB monitor ─────────────────────────────────────────────────────────────
function startSebMonitor() {
  SebMonitor.start({
    onSebDetected: (hwnd, title) => {
      log.info(`seb: client window present ${hwnd} "${title}" → overlay stays top-level`);
      overlayWin?.setAlwaysOnTop(true, 'screen-saver', 1);
      if (overlayWin && !overlayWin.isVisible()) overlayWin.showInactive();
    },
    onSebGone: () => log.info('seb: client window gone → overlay stays top-level'),
  });
}

// ─── Hotkeys (matches Ultralay: Alt+` hide, Ctrl+Alt+S screenshot, Ctrl+Alt+Q quit) ──
function registerHotkeys() {
  Hotkeys.register({
    hideShow:   { accelerator: 'Alt+`',           handler: toggleWindow },
    screenshot: { accelerator: 'CommandOrControl+Alt+S', handler: captureScreenshot },
    quit:       { accelerator: 'CommandOrControl+Alt+Q', handler: () => { tray?.destroy(); app.exit(0); } },
    lock:       { accelerator: 'CommandOrControl+Alt+L', handler: lockInteractive },
    settings:   { accelerator: 'CommandOrControl+Shift+P', handler: () => overlayWin?.webContents.send('toggle-settings') },
    pin:        { accelerator: 'CommandOrControl+Shift+T', handler: toggleAlwaysOnTop },
    injectJs:   { accelerator: 'CommandOrControl+Shift+J', handler: () => require('./utils/injector').injectFromFile(overlayWin, log) },
  });
  log.info('router: hotkeys registered');
}

function toggleAlwaysOnTop() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  config.alwaysOnTop = !config.alwaysOnTop;
  overlayWin.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver', 1);
  saveConfig(config);
  overlayWin.webContents.send('pin-changed', config.alwaysOnTop);
  log.info(`overlay: alwaysOnTop=${config.alwaysOnTop}`);
}

// ─── Screenshot ───────────────────────────────────────────────────────────────
async function captureScreenshot() {
  try {
    const sc   = new Screenshot(SCREENSHOT_DIR, log);
    const file = await sc.capture(overlayWin);
    const b64  = fs.readFileSync(file).toString('base64');

    // Send directly to renderer via IPC event — renderer pushes to its own pendingImages.
    // Do NOT also push to main's pendingImages here, or getPending() will return a duplicate.
    // Only buffer in pendingImages if the renderer hasn't loaded yet (edge case).
    const rendererReady = overlayWin && !overlayWin.isDestroyed() &&
                          overlayWin.webContents.getURL() !== '';

    if (rendererReady) {
      overlayWin.webContents.send('screenshot-captured', { path: file, b64 });
    } else {
      // Renderer not ready — buffer for when it loads and calls getPending()
      pendingImages.push({ path: file, b64 });
    }

    log.info(`[screenshot] captured → ${file}`);
  } catch (e) {
    log.error(`[screenshot] failed: ${e.message}`);
  }
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('api-chat', async (_, opts) => {
  log.info(`[api] calling ${opts.provider}/${opts.model} — keys: ${(opts.geminiKeys||[]).length}`);
  try {
    const result = await new ApiCaller(log).call(opts);
    // result = { text, activeKeyIndex }
    return { ok: true, text: result.text, activeKeyIndex: result.activeKeyIndex };
  } catch (e) {
    log.error(`[api] error: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-config', () => config);
ipcMain.handle('save-config', (_, newCfg) => {
  config = { ...config, ...newCfg };
  saveConfig(config);
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setAlwaysOnTop(config.alwaysOnTop !== false, 'screen-saver', 1);
    overlayWin.setOpacity((config.opacity ?? 97) / 100);
    // Apply screenshare hide preference live
    if (config.screenshareHide) {
      try { Stealth.excludeFromCapture(overlayWin.getNativeWindowHandle(), log); } catch (_) {}
    } else {
      try { Stealth.removeFromCapture(overlayWin.getNativeWindowHandle(), log); } catch (_) {}
    }
  }
  return config;
});

// Toggle screenshare protection on demand
ipcMain.handle('set-screenshare-hide', (_, hide) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    const hwnd = overlayWin.getNativeWindowHandle();
    if (hide) {
      Stealth.excludeFromCapture(hwnd, log);
      overlayWin.setContentProtection(true);
      log.info('screenshare-hide: ON');
    } else {
      Stealth.removeFromCapture(hwnd, log);
      overlayWin.setContentProtection(false);
      log.info('screenshare-hide: OFF');
    }
  } catch (e) {
    log.warn(`screenshare-hide: ${e.message}`);
    // fallback
    try { overlayWin.setContentProtection(hide); } catch (_) {}
  }
});

ipcMain.handle('window-minimize', () => overlayWin?.minimize());
ipcMain.handle('window-hide',    () => overlayWin?.hide());
ipcMain.handle('window-toggle',  () => toggleWindow());
ipcMain.handle('window-close',   () => { tray?.destroy(); app.exit(0); });
ipcMain.handle('toggle-pin',     () => toggleAlwaysOnTop());
ipcMain.handle('screenshot',     async () => captureScreenshot());
ipcMain.handle('get-pending-images', () => { const i = [...pendingImages]; pendingImages = []; return i; });
ipcMain.handle('open-screenshots', () => shell.openPath(SCREENSHOT_DIR));
ipcMain.handle('open-logs',        () => shell.openPath(LOG_DIR));
ipcMain.handle('inject-js', async (_, code) => {
  try { return String(await overlayWin?.webContents.executeJavaScript(code, true)); }
  catch (e) { return `error: ${e.message}`; }
});
