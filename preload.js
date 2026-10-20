'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ultralay', {
  // ── Stealth / mouse-event mode ──────────────────────────────────────────────
  setInteractive:      (v) => ipcRenderer.invoke('set-interactive', v),
  lockInteractive:     (v) => ipcRenderer.invoke('lock-interactive', v),
  setScreenshareHide:  (v) => ipcRenderer.invoke('set-screenshare-hide', v),

  // ── Window controls ──────────────────────────────────────────────────────────
  minimize: ()    => ipcRenderer.invoke('window-minimize'),
  hide:     ()    => ipcRenderer.invoke('window-hide'),
  toggle:   ()    => ipcRenderer.invoke('window-toggle'),
  close:    ()    => ipcRenderer.invoke('window-close'),
  togglePin:()    => ipcRenderer.invoke('toggle-pin'),

  // ── Config ───────────────────────────────────────────────────────────────────
  getConfig:  ()  => ipcRenderer.invoke('get-config'),
  saveConfig: (c) => ipcRenderer.invoke('save-config', c),

  // ── AI API ───────────────────────────────────────────────────────────────────
  apiChat: (opts) => ipcRenderer.invoke('api-chat', opts),

  // ── Screenshot ───────────────────────────────────────────────────────────────
  screenshot:  ()  => ipcRenderer.invoke('screenshot'),
  getPending:  ()  => ipcRenderer.invoke('get-pending-images'),

  // ── Shell ────────────────────────────────────────────────────────────────────
  openScreenshots: () => ipcRenderer.invoke('open-screenshots'),
  openLogs:        () => ipcRenderer.invoke('open-logs'),

  // ── JS inject ────────────────────────────────────────────────────────────────
  injectJs: (code) => ipcRenderer.invoke('inject-js', code),

  // ── Events from main → renderer ──────────────────────────────────────────────
  on: (channel, cb) => {
    const valid = ['screenshot-captured','toggle-settings','pin-changed','lock-changed'];
    if (valid.includes(channel)) ipcRenderer.on(channel, (_, ...args) => cb(...args));
  },
});
