'use strict';
/**
 * utils/logger.js
 * Dual-file logging: overlay.log + cef.log (mirrors Ultralay's log system)
 */

const fs   = require('fs');
const path = require('path');

class Logger {
  constructor(logDir) {
    this.logDir    = logDir;
    this.overlayLog = path.join(logDir, 'overlay.log');
    this.cefLog     = path.join(logDir, 'cef.log');
    this._write(this.overlayLog, `\n${'='.repeat(60)}\n[${new Date().toISOString()}] overlay started\n`);
  }

  _ts() {
    return new Date().toISOString();
  }

  _write(file, line) {
    try {
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch (_) {}
  }

  _fmt(level, msg) {
    return `[${this._ts()}] [${level.padEnd(5)}] ${msg}`;
  }

  info(msg) {
    const line = this._fmt('INFO', msg);
    console.log(line);
    this._write(this.overlayLog, line);
  }

  warn(msg) {
    const line = this._fmt('WARN', msg);
    console.warn(line);
    this._write(this.overlayLog, line);
  }

  error(msg) {
    const line = this._fmt('ERROR', msg);
    console.error(line);
    this._write(this.overlayLog, line);
  }

  /** Write to cef.log (CEF internal events) */
  cef(msg) {
    const line = this._fmt('CEF', msg);
    this._write(this.cefLog, line);
    this._write(this.overlayLog, line);
  }

  debug(msg) {
    if (process.argv.includes('--dev')) {
      const line = this._fmt('DEBUG', msg);
      console.debug(line);
      this._write(this.overlayLog, line);
    }
  }
}

module.exports = Logger;
