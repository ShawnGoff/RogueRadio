// Validate required environment variables
const required = [
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REDIRECT_URI'
];

const missing = required.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.warn(`Warning: Missing environment variables: ${missing.join(', ')}`);
  console.warn('Please create a .env file with the required credentials.');
  console.warn('See .env.example for reference.');
}

module.exports = {
  port: process.env.PORT || 3333,
  nodeEnv: process.env.NODE_ENV || 'development',
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI
  },
  // Update frequency: every 2 seconds
  updateInterval: 2000,
  // Token refresh buffer: 5 minutes before expiry
  tokenRefreshBuffer: 5 * 60 * 1000
};
