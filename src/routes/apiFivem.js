const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { hashLicenseKey } = require('../utils/crypto');
const { apiLimiter } = require('../middlewares/rateLimiter');

router.post('/verify', apiLimiter, async (req, res) => {
  const { licenseKey, serverName } = req.body;

  if (!licenseKey || typeof licenseKey !== 'string') {
    return res.status(400).json({ valid: false, error: 'Format de clé invalide' });
  }

  const clientIp = (req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const keyHash = hashLicenseKey(licenseKey);

  try {
    const [licenses] = await pool.query(
      'SELECT id, product, type, status, expires_at, max_servers FROM licenses WHERE license_hash = ?',
      [keyHash]
    );

    if (licenses.length === 0) {
      return res.status(403).json({ valid: false, error: 'Licence introuvable' });
    }

    const lic = licenses[0];

    if (lic.status === 'revoked') {
      return res.status(403).json({ valid: false, error: 'Licence révoquée' });
    }

    if (lic.expires_at && new Date(lic.expires_at) <= new Date()) {
      return res.status(403).json({ valid: false, error: 'Licence expirée' });
    }

    // Gestion des adresses IP autorisées
    const [existingIps] = await pool.query('SELECT ip_address FROM license_ips WHERE license_id = ?', [lic.id]);
    const ipList = existingIps.map(r => r.ip_address);

    if (!ipList.includes(clientIp)) {
      if (ipList.length >= lic.max_servers) {
        return res.status(403).json({
          valid: false,
          error: `Nombre maximum de serveurs atteint (${lic.max_servers}). Contactez le support.`
        });
      }
      // Liaison de la nouvelle IP
      await pool.query(
        'INSERT INTO license_ips (license_id, ip_address, server_name) VALUES (?, ?, ?)',
        [lic.id, clientIp, serverName ? String(serverName).slice(0, 100) : 'FiveM Server']
      );
    } else {
      // Mise à jour de la dernière date de contact
      await pool.query(
        'UPDATE license_ips SET last_seen_at = NOW(), server_name = COALESCE(?, server_name) WHERE license_id = ? AND ip_address = ?',
        [serverName ? String(serverName).slice(0, 100) : null, lic.id, clientIp]
      );
    }

    return res.json({
      valid: true,
      product: lic.product,
      type: lic.type,
      expires_at: lic.expires_at
    });

  } catch (err) {
    console.error('[FIVEM_VERIFY_ERROR]', err);
    return res.status(500).json({ valid: false, error: 'Erreur interne de vérification' });
  }
});

module.exports = router;
