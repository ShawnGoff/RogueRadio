const express = require('express');
const path = require('path');
const { DATA_DIR } = require('./datadir');
// First file found wins for each variable: user data dir, then next to the code (dev)
require('dotenv').config({ path: [path.join(DATA_DIR, '.env'), path.join(__dirname, '.env')] });
const config = require('./config');
const routes = require('./routes');
const spotifyClient = require('./spotify');

const app = express();

// Middleware
// No CORS: only the local bridge talks to this server. Browsers attach an Origin
// header to cross-origin requests, so reject those (blocks websites from firing
// POST /api/next etc.), and reject unexpected Host headers (DNS rebinding).
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (req.headers.origin || !['127.0.0.1', 'localhost'].includes(host)) {
    return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
  }
  next();
});
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Mount all routes
app.use('/api', routes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    code: err.code || 'INTERNAL_ERROR'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
});

// Start server
const PORT = process.env.PORT || 3333;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Rogue Radio Overlay companion server running on http://127.0.0.1:${PORT}`);
  console.log(`Spotify authenticated: ${spotifyClient.isAuthenticated()}`);
});
