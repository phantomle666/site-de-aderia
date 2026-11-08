const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { hashLicenseKey } = require('../utils/crypto');

// GET /trpc/servers.list
router.get('/servers.list', async (req, res) => {
  try {
    // Récupérer les serveurs enregistrés
    const [rows] = await pool.query(`
      SELECT li.id, li.server_name AS serverName, li.ip_address, li.last_seen_at AS lastSeenAt,
             l.expires_at AS expiresAt, l.product
      FROM license_ips li
      JOIN licenses l ON li.license_id = l.id
      ORDER BY li.id DESC
    `);

    const servers = rows.map(s => ({
      id: String(s.id),
      serverName: s.serverName || 'Mon Serveur FiveM',
      expiresAt: s.expiresAt || new Date(Date.now() + 365*24*3600*1000).toISOString(),
      isOnline: true,
      playerCount: 0,
      maxSlots: 64,
      isOwner: true,
      logo: null
    }));

    // Format réponse tRPC batch
    res.json([{
      result: {
        type: 'data',
        data: servers
      }
    }]);
  } catch (err) {
    console.error('[TRPC_SERVERS_LIST_ERROR]', err);
    res.json([{
      result: {
        type: 'data',
        data: []
      }
    }]);
  }
});

// POST /trpc/licenses.redeem
router.post('/licenses.redeem', async (req, res) => {
  try {
    // Support batch tRPC ou corps direct
    let input = req.body;
    if (req.body['0']) {
      input = req.body['0'];
    }

    const { licenseKey, serverOption, existingServerId } = input || {};

    if (!licenseKey || typeof licenseKey !== 'string') {
      return res.status(400).json([{
        error: {
          message: 'Veuillez renseigner une clé de licence valide.',
          code: -32600,
          data: { code: 'BAD_REQUEST', httpStatus: 400 }
        }
      }]);
    }

    const keyHash = hashLicenseKey(licenseKey);

    const [licenses] = await pool.query(
      'SELECT id, product, type, status, expires_at, max_servers FROM licenses WHERE license_hash = ?',
      [keyHash]
    );

    if (licenses.length === 0) {
      return res.status(400).json([{
        error: {
          message: 'Clé de licence invalide ou introuvable.',
          code: -32600,
          data: { code: 'BAD_REQUEST', httpStatus: 400 }
        }
      }]);
    }

    const lic = licenses[0];

    if (lic.status === 'revoked') {
      return res.status(400).json([{
        error: {
          message: 'Cette clé de licence a été révoquée par un administrateur.',
          code: -32600,
          data: { code: 'BAD_REQUEST', httpStatus: 400 }
        }
      }]);
    }

    if (lic.expires_at && new Date(lic.expires_at) <= new Date()) {
      return res.status(400).json([{
        error: {
          message: 'Cette clé de licence a expiré.',
          code: -32600,
          data: { code: 'BAD_REQUEST', httpStatus: 400 }
        }
      }]);
    }

    const clientIp = (req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1').replace(/^::ffff:/, '');

    // Créer ou rattacher un serveur
    const [ins] = await pool.query(
      'INSERT INTO license_ips (license_id, ip_address, server_name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_seen_at = NOW()',
      [lic.id, clientIp, 'Serveur ' + lic.product]
    );

    const serverId = ins.insertId || lic.id;

    // Réponse de succès tRPC batch
    return res.json([{
      result: {
        type: 'data',
        data: {
          message: `Licence ${lic.product} activée avec succès !`,
          serverId: String(serverId)
        }
      }
    }]);

  } catch (err) {
    console.error('[TRPC_REDEEM_ERROR]', err);
    return res.status(500).json([{
      error: {
        message: 'Erreur lors de l’activation de la clé.',
        code: -32603,
        data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 }
      }
    }]);
  }
});

module.exports = router;
