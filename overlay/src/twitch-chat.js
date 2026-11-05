'use strict';
// Reads a Twitch channel's chat over IRC as an anonymous viewer ("justinfan" logins can read but not
// write), so no Twitch login is needed just to listen. Emits 'message' for each chat line.
const tls = require('node:tls');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const HOST = 'irc.chat.twitch.tv';
const PORT = 6697;

// Accepts "name", "#name", "@name" or a twitch.tv link; returns the lowercase login or null.
function normalizeChannel(input) {
  const raw = String(input || '').trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').replace(/^[#@]/, '').replace(/[/?#].*$/, '');
  return /^[a-z0-9_]{1,25}$/.test(raw) ? raw : null;
}

const TAG_ESCAPES = { ':': ';', s: ' ', r: '\r', n: '\n', '\\': '\\' };
const unescapeTag = v => v.replace(/\\(.)/g, (_m, c) => (c in TAG_ESCAPES ? TAG_ESCAPES[c] : c));

// "@tags :nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :hello" -> { tags, prefix, command, params, trailing }
function parseLine(line) {
  let rest = String(line);
  const tags = {};
  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ');
    if (space < 0) return null;
    for (const part of rest.slice(1, space).split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) tags[part] = '';
      else tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1));
    }
    rest = rest.slice(space + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ');
    if (space < 0) return null;
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }
  let trailing = null;
  const t = rest.indexOf(' :');
  if (t >= 0) { trailing = rest.slice(t + 2); rest = rest.slice(0, t); }
  const parts = rest.split(' ').filter(Boolean);
  const command = parts.shift();
  if (!command) return null;
  return { tags, prefix, command, params: parts, trailing };
}

// "subscriber/12,moderator/1" -> { subscriber: '12', moderator: '1' }
function parseBadges(value) {
  const out = {};
  for (const item of String(value || '').split(',')) {
    const [name, version] = item.split('/');
    if (name) out[name] = version ?? '';
  }
  return out;
}

// A PRIVMSG line, reduced to what the song-request rules need.
function toChatter(msg) {
  if (!msg || msg.command !== 'PRIVMSG' || msg.trailing == null) return null;
  const login = msg.prefix.split('!')[0].toLowerCase();
  const badges = parseBadges(msg.tags.badges);
  let text = msg.trailing;
  if (text.startsWith('\u0001ACTION')) return null;                 // "/me" lines are never commands
  return {
    login,
    name: msg.tags['display-name'] || login,
    id: msg.tags['user-id'] || null,
    text,
    isBroadcaster: 'broadcaster' in badges,
    isMod: msg.tags.mod === '1' || 'moderator' in badges,
    isVip: 'vip' in badges,
    isSub: msg.tags.subscriber === '1' || 'subscriber' in badges || 'founder' in badges,
  };
}

class TwitchChat extends EventEmitter {
  // `secure: false` and a custom host/port exist so tests can use a plain local socket.
  constructor({ channel, host = HOST, port = PORT, secure = true } = {}) {
    super();
    this.channel = channel;
    this.host = host; this.port = port; this.secure = secure;
    this.socket = null;
    this.stopped = true;
    this.backoff = 1000;
    this.timer = null;
    this.buffer = '';
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.socket) { this.socket.removeAllListeners(); this.socket.on('error', () => {}); this.socket.destroy(); this.socket = null; }
    this.emit('status', 'stopped');
  }

  connect() {
    this.emit('status', 'connecting');
    this.buffer = '';
    const nick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
    const onReady = () => {
      this.write('CAP REQ :twitch.tv/tags twitch.tv/commands');
      this.write('PASS SCHMOOZE');
      this.write(`NICK ${nick}`);
      this.write(`JOIN #${this.channel}`);
    };
    const socket = this.secure
      ? tls.connect({ host: this.host, port: this.port, servername: this.host }, onReady)
      : net.connect({ host: this.host, port: this.port }, onReady);
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(6 * 60 * 1000);                                // Twitch pings every ~5 minutes; silence longer than that means a dead link
    socket.on('timeout', () => socket.destroy());
    socket.on('data', chunk => this.onData(chunk));
    socket.on('error', err => this.emit('error-message', err.message));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      this.emit('status', 'reconnecting');
      this.timer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60000);
    });
  }

  write(line) {
    if (this.socket && !this.socket.destroyed) this.socket.write(line + '\r\n');
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 64 * 1024) this.buffer = '';           // a runaway line, drop it
    let i;
    while ((i = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 2);
      if (line) this.onLine(line);
    }
  }

  onLine(line) {
    const msg = parseLine(line);
    if (!msg) return;
    switch (msg.command) {
      case 'PING': this.write('PONG :' + (msg.trailing || 'tmi.twitch.tv')); break;
      case 'RECONNECT': this.socket?.destroy(); break;
      case '001': this.backoff = 1000; break;
      case 'JOIN': this.emit('status', 'listening'); break;
      case 'PRIVMSG': {
        const chatter = toChatter(msg);
        if (chatter) this.emit('message', chatter);
        break;
      }
      default: break;
    }
  }
}

module.exports = { TwitchChat, normalizeChannel, parseLine, parseBadges, toChatter };
