const http = require('http');

const FIVEM_HOST = process.env.FIVEM_HOST || '127.0.0.1';
const FIVEM_PORT = parseInt(process.env.FIVEM_PORT || '30120', 10);
const BRIDGE_SECRET = process.env.FIVEM_BRIDGE_SECRET || 'live_secret_key_zk_panel_2026';

/**
 * Envoie une commande de synchronisation en direct au serveur FiveM
 * @param {string} action - 'update_player_economy' | 'update_player_job' | 'update_player_group' | 'refresh_jobs' | 'reload_heists' | 'broadcast_announcement'
 * @param {object} payload - Données spécifiques à l'action
 * @returns {Promise<{ delivered: boolean, onlinePlayer?: boolean }>}
 */
async function sendToFiveM(action, payload = {}) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      secret: BRIDGE_SECRET,
      action,
      ...payload
    });

    const options = {
      hostname: FIVEM_HOST,
      port: FIVEM_PORT,
      path: '/zk_auth/live-sync',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BRIDGE_SECRET}`,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 1500 // Timeout rapide : n'attend pas si le serveur FiveM est éteint
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ delivered: true, onlinePlayer: parsed.onlinePlayer || false });
        } catch {
          resolve({ delivered: true });
        }
      });
    });

    req.on('error', () => {
      // Serveur FiveM éteint : tout a été persisté en SQL
      resolve({ delivered: false, error: 'FiveM_Offline' });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ delivered: false, error: 'FiveM_Timeout' });
    });

    req.write(postData);
    req.end();
  });
}

module.exports = {
  sendToFiveM
};
