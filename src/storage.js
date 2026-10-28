const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./datadir');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const LRC_CACHE_FILE = path.join(DATA_DIR, 'lrclib-cache.json');

// Ensure data directory exists
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function getTokens() {
  try {
    ensureDataDir();
    if (!fs.existsSync(TOKENS_FILE)) {
      return null;
    }
    const data = fs.readFileSync(TOKENS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading tokens:', error.message);
    return null;
  }
}

function saveTokens(tokens) {
  try {
    ensureDataDir();
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    fs.chmodSync(TOKENS_FILE, 0o600); // mode above is ignored if the file already existed
  } catch (error) {
    console.error('Error saving tokens:', error.message);
  }
}

function clearTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      fs.unlinkSync(TOKENS_FILE);
    }
  } catch (error) {
    console.error('Error clearing tokens:', error.message);
  }
}

function getLrcCache() {
  try {
    ensureDataDir();
    return fs.existsSync(LRC_CACHE_FILE) ? JSON.parse(fs.readFileSync(LRC_CACHE_FILE, 'utf-8')) : {};
  } catch (error) {
    console.error('Error reading lyrics cache:', error.message);
    return {};
  }
}

function saveLrcCache(cache) {
  try {
    ensureDataDir();
    fs.writeFileSync(LRC_CACHE_FILE, JSON.stringify(cache));
  } catch (error) {
    console.error('Error saving lyrics cache:', error.message);
  }
}

module.exports = {
  getLrcCache,
  saveLrcCache,
  getTokens,
  saveTokens,
  clearTokens,
  ensureDataDir
};
