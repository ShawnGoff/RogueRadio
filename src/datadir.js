// Where the app keeps its data (login tokens, .env, settings, lyrics cache).
// Earlier versions used ~/.azeroth-radio; if only that exists, move it to the new
// location so the saved login and credentials carry over.
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEGACY_DIR = path.join(os.homedir(), '.azeroth-radio');
const DEFAULT_DIR = path.join(os.homedir(), '.rogue-radio-overlay');
const DATA_DIR = process.env.DATA_DIR || DEFAULT_DIR;

if (!process.env.DATA_DIR && !fs.existsSync(DEFAULT_DIR) && fs.existsSync(LEGACY_DIR)) {
  try {
    fs.renameSync(LEGACY_DIR, DEFAULT_DIR);
    console.log(`Moved data from ${LEGACY_DIR} to ${DEFAULT_DIR}`);
  } catch (error) {
    console.error('Could not move legacy data folder:', error.message);
  }
}

module.exports = { DATA_DIR };
