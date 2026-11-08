const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { requireAdmin } = require('../middlewares/auth');

router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    // 1. Statistiques globales
    const [counts] = await pool.query(`
      SELECT 
        COUNT(CASE WHEN status = 'active' AND (expires_at IS NULL OR expires_at > NOW()) THEN 1 END) AS active_count,
        COUNT(CASE WHEN status = 'revoked' THEN 1 END) AS revoked_count,
        COUNT(CASE WHEN status = 'active' AND expires_at <= NOW() THEN 1 END) AS expired_count
      FROM licenses
    `);

    // 2. Alertes sécurité : licences actives utilisées sur plus d'IPs que leur max_servers
    const [alerts] = await pool.query(`
      SELECT l.id, l.masked_key, l.product, l.max_servers, COUNT(DISTINCT li.ip_address) AS actual_ips
      FROM licenses l
      JOIN license_ips li ON l.id = li.license_id
      WHERE l.status = 'active'
      GROUP BY l.id, l.masked_key, l.product, l.max_servers
      HAVING actual_ips > l.max_servers
    `);

    // 3. Dernières activations / IP enregistrées
    const [recentActivations] = await pool.query(`
      SELECT li.ip_address, li.server_name, li.last_seen_at, l.masked_key, l.product
      FROM license_ips li
      JOIN licenses l ON li.license_id = l.id
      ORDER BY li.last_seen_at DESC
      LIMIT 10
    `);

    res.render('dashboard', {
      admin: req.session.admin,
      stats: counts[0] || { active_count: 0, revoked_count: 0, expired_count: 0 },
      alerts,
      recentActivations
    });
  } catch (err) {
    console.error('[DASHBOARD_ERROR]', err);
    res.status(500).send('Erreur lors du chargement du dashboard');
  }
});

// GET /admin/audit-logs
router.get('/audit-logs', requireAdmin, async (req, res) => {
  try {
    const [logs] = await pool.query(`
      SELECT id, admin_username, action, target_type, target_id, ip_address, before_state, after_state, created_at
      FROM audit_logs
      ORDER BY id DESC
      LIMIT 100
    `);

    res.render('audit', {
      admin: req.session.admin,
      logs
    });
  } catch (err) {
    console.error('[AUDIT_PAGE_ERROR]', err);
    res.status(500).send('Erreur lors du chargement des logs d\'audit');
  }
});

module.exports = router;
