const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { requireAdmin } = require('../middlewares/auth');
const { generateLicenseKey, hashLicenseKey, maskLicenseKey, encryptText, decryptText } = require('../utils/crypto');
const { logAudit } = require('../utils/logger');

// GET /admin/licenses - Liste avec pagination et filtres
router.get('/licenses', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = 20;
    const offset = (page - 1) * limit;

    const search = req.query.search ? `%${req.query.search.trim()}%` : null;
    const status = ['active', 'revoked', 'expired'].includes(req.query.status) ? req.query.status : null;
    const product = req.query.product ? req.query.product.trim() : null;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (search) {
      whereClause += ' AND (masked_key LIKE ? OR note LIKE ?)';
      params.push(search, search);
    }
    if (status) {
      whereClause += ' AND status = ?';
      params.push(status);
    }
    if (product) {
      whereClause += ' AND product = ?';
      params.push(product);
    }

    const [totalRows] = await pool.query(`SELECT COUNT(*) as count FROM licenses ${whereClause}`, params);
    const totalLicenses = totalRows[0].count;
    const totalPages = Math.ceil(totalLicenses / limit);

    const [licenses] = await pool.query(
      `SELECT l.*, COUNT(li.id) AS bound_ips
       FROM licenses l
       LEFT JOIN license_ips li ON l.id = li.license_id
       ${whereClause}
       GROUP BY l.id
       ORDER BY l.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Déchiffrement direct côté serveur pour un affichage instantané sans dépendre d'un fetch Ajax
    licenses.forEach(lic => {
      try {
        lic.decrypted_key = decryptText(lic.encrypted_key);
      } catch (e) {
        lic.decrypted_key = null;
      }
    });

    res.render('licenses', {
      admin: req.session.admin,
      licenses,
      currentPage: page,
      totalPages,
      query: req.query,
      createdKey: req.session.newlyCreatedKey || null
    });

    delete req.session.newlyCreatedKey; // Affichage unique
  } catch (err) {
    console.error('[LICENSES_LIST_ERROR]', err);
    res.status(500).send('Erreur serveur');
  }
});

// POST /admin/licenses/create
router.post('/licenses/create', requireAdmin, async (req, res) => {
  const { product, type, duration_days, max_servers, note } = req.body;

  if (!product || !['standard', 'lifetime', 'gift'].includes(type)) {
    return res.status(400).json({ error: 'Champs invalides' });
  }

  const serversLimit = Math.max(1, parseInt(max_servers || '1', 10));
  let expiresAt = null;

  if (type !== 'lifetime') {
    const days = parseInt(duration_days || '30', 10);
    if (isNaN(days) || days <= 0) {
      return res.status(400).json({ error: 'Durée en jours invalide' });
    }
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);
  }

  try {
    const plainKey = generateLicenseKey();
    const hash = hashLicenseKey(plainKey);
    const masked = maskLicenseKey(plainKey);
    const encrypted = encryptText(plainKey);

    const [result] = await pool.query(
      `INSERT INTO licenses (license_hash, encrypted_key, masked_key, license_key, product, type, status, expires_at, max_servers, note, source)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 'manual')`,
      [hash, encrypted, masked, plainKey, product.trim(), type, expiresAt, serversLimit, note ? note.trim() : null]
    );

    await logAudit(req, {
      action: 'LICENSE_CREATE',
      targetType: 'LICENSE',
      targetId: result.insertId,
      afterState: { product, type, expiresAt, max_servers: serversLimit, masked_key: masked }
    });

    req.session.newlyCreatedKey = {
      plainKey,
      product,
      id: result.insertId
    };

    res.redirect('/admin/licenses');
  } catch (err) {
    console.error('[LICENSE_CREATE_ERROR]', err);
    res.status(500).json({ error: 'Erreur lors de la création de la licence', details: err.message });
  }
});

// POST /admin/licenses/:id/revoke
router.post('/licenses/:id/revoke', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const [prev] = await pool.query('SELECT * FROM licenses WHERE id = ?', [id]);
    if (prev.length === 0) return res.status(404).json({ error: 'Licence introuvable' });

    await pool.query("UPDATE licenses SET status = 'revoked' WHERE id = ?", [id]);

    await logAudit(req, {
      action: 'LICENSE_REVOKE',
      targetType: 'LICENSE',
      targetId: id,
      beforeState: { status: prev[0].status },
      afterState: { status: 'revoked' }
    });

    res.redirect('/admin/licenses');
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /admin/licenses/:id/reactivate
router.post('/licenses/:id/reactivate', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const [prev] = await pool.query('SELECT * FROM licenses WHERE id = ?', [id]);
    if (prev.length === 0) return res.status(404).json({ error: 'Licence introuvable' });

    await pool.query("UPDATE licenses SET status = 'active' WHERE id = ?", [id]);

    await logAudit(req, {
      action: 'LICENSE_REACTIVATE',
      targetType: 'LICENSE',
      targetId: id,
      beforeState: { status: prev[0].status },
      afterState: { status: 'active' }
    });

    res.redirect('/admin/licenses');
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /admin/licenses/:id/extend
router.post('/licenses/:id/extend', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const days = parseInt(req.body.days || '30', 10);

  if (isNaN(days) || days <= 0) {
    return res.status(400).json({ error: 'Nombre de jours invalide' });
  }

  try {
    const [prev] = await pool.query('SELECT * FROM licenses WHERE id = ?', [id]);
    if (prev.length === 0) return res.status(404).json({ error: 'Licence introuvable' });

    let currentExpiry = prev[0].expires_at ? new Date(prev[0].expires_at) : new Date();
    if (currentExpiry < new Date()) currentExpiry = new Date();
    currentExpiry.setDate(currentExpiry.getDate() + days);

    await pool.query('UPDATE licenses SET expires_at = ? WHERE id = ?', [currentExpiry, id]);

    await logAudit(req, {
      action: 'LICENSE_EXTEND',
      targetType: 'LICENSE',
      targetId: id,
      beforeState: { expires_at: prev[0].expires_at },
      afterState: { expires_at: currentExpiry, added_days: days }
    });

    res.redirect('/admin/licenses');
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /admin/licenses/:id/reset-ips
router.post('/licenses/:id/reset-ips', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const [ips] = await pool.query('SELECT ip_address FROM license_ips WHERE license_id = ?', [id]);
    await pool.query('DELETE FROM license_ips WHERE license_id = ?', [id]);

    await logAudit(req, {
      action: 'LICENSE_RESET_IPS',
      targetType: 'LICENSE',
      targetId: id,
      beforeState: { ips: ips.map(i => i.ip_address) },
      afterState: { ips: [] }
    });

    res.redirect('/admin/licenses');
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /admin/licenses/:id/update (note et max_servers)
router.post('/licenses/:id/update', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { note, max_servers } = req.body;
  const serversLimit = Math.max(1, parseInt(max_servers || '1', 10));

  try {
    const [prev] = await pool.query('SELECT note, max_servers FROM licenses WHERE id = ?', [id]);
    if (prev.length === 0) return res.status(404).json({ error: 'Licence introuvable' });

    await pool.query('UPDATE licenses SET note = ?, max_servers = ? WHERE id = ?', [
      note ? String(note).slice(0, 255) : null,
      serversLimit,
      id
    ]);

    await logAudit(req, {
      action: 'LICENSE_UPDATE_META',
      targetType: 'LICENSE',
      targetId: id,
      beforeState: prev[0],
      afterState: { note, max_servers: serversLimit }
    });

    res.redirect('/admin/licenses');
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /admin/licenses/:id/reveal
router.post('/licenses/:id/reveal', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const [rows] = await pool.query('SELECT encrypted_key, masked_key FROM licenses WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Licence introuvable' });

    const plainKey = decryptText(rows[0].encrypted_key);

    await logAudit(req, {
      action: 'LICENSE_REVEAL_KEY',
      targetType: 'LICENSE',
      targetId: id
    });

    res.json({ plainKey });
  } catch (err) {
    console.error('[REVEAL_ERROR]', err);
    res.status(500).json({ error: 'Échec du déchiffrement' });
  }
});

module.exports = router;
