const express = require('express');
const router = express.Router();
const argon2 = require('argon2');
const crypto = require('crypto');
const pool = require('../config/database');
const { generateSecret, verifyToken, getQRCodeDataURL } = require('../utils/totp');
const { loginLimiter } = require('../middlewares/rateLimiter');

// Helper pour enregistrer un log d'audit d'authentification
async function logAuth(adminId, username, action, status, req, details = null) {
  try {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1').replace(/^::ffff:/, '');
    const userAgent = req.headers['user-agent']?.substring(0, 255) || 'Unknown';
    await pool.query(
      'INSERT INTO auth_logs (admin_id, username, action, provider, ip_address, user_agent, status, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [adminId || null, username, action, 'local', ip, userAgent, status, details]
    );
  } catch (err) {
    console.error('[AUTH_LOG_ERROR]', err);
  }
}

// ==========================================
// 1. PAGE DE CONNEXION (GET /login)
// ==========================================
router.get(['/login', '/admin/login'], (req, res) => {
  if (req.session?.admin?.authenticated && req.session?.admin?.totpVerified) {
    if (req.session.admin.role === 'admin' || req.session.admin.role === 'superadmin') {
      return res.redirect('/dashboard/server/6');
    }
    return res.redirect('/dashboard/redeem');
  }
  const error = req.query.error || null;
  const success = req.query.registered ? 'Votre compte a été créé avec succès ! Vous pouvez vous connecter.' : null;
  res.render('login', { error, success });
});

// ==========================================
// 2. SOUMISSION CONNEXION (POST /login)
// ==========================================
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const genericError = 'Identifiants invalides ou compte temporairement verrouillé.';

  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).render('login', { error: 'Veuillez remplir tous les champs.' });
  }

  const cleanUser = username.trim();

  try {
    // Recherche par username ou email
    const [rows] = await pool.query(
      'SELECT id, username, email, password_hash, totp_secret, is_totp_enabled, role, failed_attempts, locked_until FROM admins WHERE username = ? OR email = ?',
      [cleanUser, cleanUser]
    );

    if (rows.length === 0) {
      await argon2.hash('fake-defense-timing-attack');
      await logAuth(null, cleanUser, 'LOGIN_FAILED', 'FAILED', req, 'Utilisateur inexistant');
      return res.status(401).render('login', { error: genericError });
    }

    const admin = rows[0];

    // Vérification du verrouillage temporaire (5 essais / 15 minutes)
    if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
      await logAuth(admin.id, admin.username, 'LOGIN_FAILED', 'FAILED', req, 'Compte verrouillé temporairement');
      return res.status(403).render('login', { error: 'Compte temporairement verrouillé suite à trop d’échecs. Réessayez dans 15 minutes.' });
    }

    const isValid = await argon2.verify(admin.password_hash, password);

    if (!isValid) {
      const attempts = (admin.failed_attempts || 0) + 1;
      let lockSql = 'UPDATE admins SET failed_attempts = ? WHERE id = ?';
      let lockParams = [attempts, admin.id];

      if (attempts >= 5) {
        lockSql = 'UPDATE admins SET failed_attempts = 0, locked_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?';
        lockParams = [admin.id];
      }
      await pool.query(lockSql, lockParams);

      await logAuth(admin.id, admin.username, 'LOGIN_FAILED', 'FAILED', req, `Mot de passe incorrect (${attempts}/5)`);
      return res.status(401).render('login', { error: genericError });
    }

    // Réinitialisation des tentatives échouées
    await pool.query('UPDATE admins SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [admin.id]);

    // Régénération de la session (Anti Session Fixation)
    req.session.regenerate(async (err) => {
      if (err) return res.status(500).render('login', { error: 'Erreur interne de session.' });

      const has2FA = admin.is_totp_enabled == 1 && !!admin.totp_secret;

      req.session.admin = {
        id: admin.id,
        username: admin.username,
        email: admin.email,
        role: admin.role,
        totpSecret: admin.totp_secret,
        has2FA: has2FA,
        authenticated: true,
        totpVerified: !has2FA // Si 2FA inactif, accès direct accordé
      };

      if (has2FA) {
        req.session.save(() => {
          return res.redirect('/verify-2fa');
        });
      } else {
        await logAuth(admin.id, admin.username, 'LOGIN_SUCCESS', 'SUCCESS', req, 'Connexion directe sans 2FA');
        req.session.save(() => {
          // Si l'utilisateur est admin ou superadmin, redirection directe sur le panel de gestion serveur
          if (admin.role === 'admin' || admin.role === 'superadmin') {
            return res.redirect('/dashboard/server/6');
          }
          return res.redirect('/dashboard/redeem');
        });
      }
    });

  } catch (err) {
    console.error('[LOGIN_ERROR]', err);
    return res.status(500).render('login', { error: 'Erreur technique serveur.' });
  }
});

// ==========================================
// 3. PAGE D'INSCRIPTION (GET /register)
// ==========================================
router.get('/register', (req, res) => {
  if (req.session?.admin?.authenticated && req.session?.admin?.totpVerified) {
    return res.redirect('/dashboard/redeem');
  }
  res.render('register', { error: null });
});

// ==========================================
// 4. SOUMISSION INSCRIPTION (POST /register)
// ==========================================
router.post('/register', loginLimiter, async (req, res) => {
  const { username, email, password, confirm_password } = req.body;

  if (!username || !email || !password || !confirm_password) {
    return res.status(400).render('register', { error: 'Tous les champs sont requis.' });
  }

  const cleanUser = username.trim();
  const cleanEmail = email.trim().toLowerCase();

  // Validations strictes de sécurité
  if (cleanUser.length < 3 || cleanUser.length > 30 || !/^[a-zA-Z0-9_-]+$/.test(cleanUser)) {
    return res.status(400).render('register', { error: 'L’identifiant doit contenir entre 3 et 30 caractères alphanumériques (tirets autorisés).' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).render('register', { error: 'Adresse email invalide.' });
  }

  if (password.length < 8) {
    return res.status(400).render('register', { error: 'Le mot de passe doit comporter au moins 8 caractères.' });
  }

  if (password !== confirm_password) {
    return res.status(400).render('register', { error: 'Les mots de passe ne correspondent pas.' });
  }

  try {
    // Vérification unicité username et email
    const [existing] = await pool.query(
      'SELECT id, username, email FROM admins WHERE username = ? OR email = ?',
      [cleanUser, cleanEmail]
    );

    if (existing.length > 0) {
      const match = existing[0];
      if (match.username.toLowerCase() === cleanUser.toLowerCase()) {
        return res.status(409).render('register', { error: 'Cet identifiant est déjà utilisé.' });
      }
      return res.status(409).render('register', { error: 'Cette adresse email est déjà associée à un compte.' });
    }

    // Hachage ultra-sécurisé avec Argon2id
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4
    });

    const [result] = await pool.query(
      'INSERT INTO admins (username, email, password_hash, role, is_totp_enabled, auth_provider) VALUES (?, ?, ?, ?, 0, "local")',
      [cleanUser, cleanEmail, passwordHash, 'admin']
    );

    const newAdminId = result.insertId;
    await logAuth(newAdminId, cleanUser, 'REGISTER', 'SUCCESS', req, 'Création de compte réussie');

    return res.redirect('/login?registered=1');
  } catch (err) {
    console.error('[REGISTER_ERROR]', err);
    return res.status(500).render('register', { error: 'Erreur technique lors de la création du compte.' });
  }
});

// ==========================================
// 5. VÉRIFICATION 2FA (GET & POST /verify-2fa)
// ==========================================
router.get('/verify-2fa', (req, res) => {
  if (!req.session?.admin?.authenticated) {
    return res.redirect('/login');
  }
  if (req.session.admin.totpVerified) {
    return res.redirect('/dashboard/redeem');
  }
  res.render('totp', { error: null });
});

router.post('/verify-2fa', loginLimiter, async (req, res) => {
  if (!req.session?.admin?.authenticated) {
    return res.redirect('/login');
  }

  const { token } = req.body;
  if (!token || !/^\d{6}$/.test(token.trim())) {
    return res.status(400).render('totp', { error: 'Code 2FA invalide (6 chiffres requis).' });
  }

  const isValid = verifyToken(token.trim(), req.session.admin.totpSecret);
  if (!isValid) {
    await logAuth(req.session.admin.id, req.session.admin.username, '2FA_FAILED', 'FAILED', req, 'Code TOTP erroné');
    return res.status(401).render('totp', { error: 'Code 2FA incorrect ou expiré. Vérifiez l’heure de votre téléphone.' });
  }

  req.session.admin.totpVerified = true;
  delete req.session.admin.totpSecret;

  await logAuth(req.session.admin.id, req.session.admin.username, '2FA_SUCCESS', 'SUCCESS', req, 'Validation 2FA réussie');

  req.session.save(() => {
    if (req.session.admin.role === 'admin' || req.session.admin.role === 'superadmin') {
      return res.redirect('/dashboard/server/6');
    }
    return res.redirect('/dashboard/redeem');
  });
});

// ==========================================
// 6. CONNEXION GOOGLE OAUTH (/auth/google)
// ==========================================
router.get('/auth/google', (req, res) => {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  if (!googleClientId || googleClientId.includes('YOUR_GOOGLE')) {
    // Si l'acheteur n'a pas encore configuré ses clés Google Cloud, on lui fournit une page explicative sécurisée
    return res.send(`
      <!DOCTYPE html>
      <html lang="fr" style="background:#08090c;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="background:#11141a;border:1px solid rgba(255,255,255,0.1);padding:2.5rem;border-radius:16px;max-width:480px;text-align:center;box-shadow:0 20px 40px rgba(0,0,0,0.7);">
          <div style="width:48px;height:48px;background:rgba(66,133,244,0.15);border-radius:12px;margin:0 auto 1.25rem;display:flex;align-items:center;justify-content:center;font-size:24px;">🔑</div>
          <h2 style="font-size:1.3rem;margin-bottom:0.5rem;">Configuration Google Sign-In</h2>
          <p style="font-size:0.875rem;color:rgba(255,255,255,0.6);line-height:1.5;margin-bottom:1.5rem;">
            Pour activer la connexion en 1 clic avec Google pour vos clients, renseignez vos identifiants dans le fichier <code>.env</code> :
          </p>
          <pre style="background:#000;padding:12px;border-radius:8px;font-size:11px;color:#4ade80;text-align:left;overflow-x:auto;margin-bottom:1.5rem;">GOOGLE_CLIENT_ID=votre-client-id.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=votre-secret</pre>
          <a href="/login" style="display:inline-block;padding:10px 20px;background:#ef4444;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:0.875rem;">← Retour à la Connexion</a>
        </div>
      </html>
    `);
  }

  // Redirection vers le portail officiel d'authentification Google
  const redirectUri = encodeURIComponent(`${req.protocol}://${req.get('host')}/auth/google/callback`);
  const scope = encodeURIComponent('openid email profile');
  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleClientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&prompt=select_account`;
  res.redirect(googleAuthUrl);
});

// ==========================================
// 7. DÉCONNEXION (GET & POST /logout)
// ==========================================
router.all('/logout', (req, res) => {
  if (req.session?.admin) {
    logAuth(req.session.admin.id, req.session.admin.username, 'LOGOUT', 'SUCCESS', req);
  }
  req.session.destroy(() => {
    res.clearCookie(process.env.NODE_ENV === 'production' ? '__Secure-sid' : 'admin_sid');
    res.redirect('/login');
  });
});

// ==========================================
// 8. API SETTINGS : GESTION A2F & SÉCURITÉ
// ==========================================

// GET /api/auth/settings/status
router.get('/api/auth/settings/status', async (req, res) => {
  if (!req.session?.admin?.authenticated) {
    return res.status(401).json({ success: false, error: 'Non authentifié.' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT id, username, email, is_totp_enabled, auth_provider, created_at FROM admins WHERE id = ?',
      [req.session.admin.id]
    );

    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Utilisateur introuvable.' });

    const admin = rows[0];
    res.json({
      success: true,
      user: {
        id: admin.id,
        username: admin.username,
        email: admin.email || 'Non renseigné',
        isTotpEnabled: admin.is_totp_enabled == 1,
        authProvider: admin.auth_provider,
        createdAt: admin.created_at
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
});

// POST /api/auth/settings/2fa/setup (Génère le secret + QR Code)
router.post('/api/auth/settings/2fa/setup', async (req, res) => {
  if (!req.session?.admin?.authenticated) {
    return res.status(401).json({ success: false, error: 'Non authentifié.' });
  }

  try {
    const secret = generateSecret();
    const qrCodeDataUrl = await getQRCodeDataURL(req.session.admin.username, secret, 'SpinPanel');

    // On stocke temporairement le secret dans la session en attente de validation
    req.session.tempTotpSecret = secret;

    res.json({
      success: true,
      secret,
      qrCode: qrCodeDataUrl
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur génération QR Code.' });
  }
});

// POST /api/auth/settings/2fa/confirm (Valide le premier code pour activer l'A2F)
router.post('/api/auth/settings/2fa/confirm', async (req, res) => {
  if (!req.session?.admin?.authenticated) {
    return res.status(401).json({ success: false, error: 'Non authentifié.' });
  }

  const { token } = req.body;
  const tempSecret = req.session.tempTotpSecret;

  if (!tempSecret) {
    return res.status(400).json({ success: false, error: 'Veuillez relancer la configuration A2F.' });
  }

  if (!token || !/^\d{6}$/.test(String(token).trim())) {
    return res.status(400).json({ success: false, error: 'Code à 6 chiffres requis.' });
  }

  const isValid = verifyToken(token.trim(), tempSecret);
  if (!isValid) {
    return res.status(400).json({ success: false, error: 'Code incorrect. Vérifiez l’heure de votre application.' });
  }

  try {
    await pool.query(
      'UPDATE admins SET totp_secret = ?, is_totp_enabled = 1 WHERE id = ?',
      [tempSecret, req.session.admin.id]
    );

    delete req.session.tempTotpSecret;
    req.session.admin.has2FA = true;
    req.session.admin.totpVerified = true;

    await logAuth(req.session.admin.id, req.session.admin.username, '2FA_ENABLED', 'SUCCESS', req, 'Activation A2F réussie');

    res.json({ success: true, message: 'Authentification à deux facteurs activée avec succès !' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur lors de la sauvegarde BDD.' });
  }
});

// POST /api/auth/settings/2fa/disable (Désactive l'A2F avec mot de passe)
router.post('/api/auth/settings/2fa/disable', async (req, res) => {
  if (!req.session?.admin?.authenticated) {
    return res.status(401).json({ success: false, error: 'Non authentifié.' });
  }

  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ success: false, error: 'Votre mot de passe actuel est requis pour désactiver l’A2F.' });
  }

  try {
    const [rows] = await pool.query('SELECT password_hash FROM admins WHERE id = ?', [req.session.admin.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Utilisateur introuvable.' });

    const isValid = await argon2.verify(rows[0].password_hash, password);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Mot de passe actuel incorrect.' });
    }

    await pool.query('UPDATE admins SET is_totp_enabled = 0, totp_secret = NULL WHERE id = ?', [req.session.admin.id]);
    req.session.admin.has2FA = false;

    await logAuth(req.session.admin.id, req.session.admin.username, '2FA_DISABLED', 'SUCCESS', req, 'Désactivation A2F');

    res.json({ success: true, message: 'L’A2F a été désactivée avec succès.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
});

// POST /api/auth/settings/password (Changement de mot de passe)
router.post('/api/auth/settings/password', async (req, res) => {
  if (!req.session?.admin?.authenticated) {
    return res.status(401).json({ success: false, error: 'Non authentifié.' });
  }

  const { old_password, new_password, confirm_password } = req.body;
  if (!old_password || !new_password || !confirm_password) {
    return res.status(400).json({ success: false, error: 'Tous les champs sont requis.' });
  }

  if (new_password.length < 8) {
    return res.status(400).json({ success: false, error: 'Le nouveau mot de passe doit comporter au moins 8 caractères.' });
  }

  if (new_password !== confirm_password) {
    return res.status(400).json({ success: false, error: 'Les nouveaux mots de passe ne correspondent pas.' });
  }

  try {
    const [rows] = await pool.query('SELECT password_hash FROM admins WHERE id = ?', [req.session.admin.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Utilisateur introuvable.' });

    const isValid = await argon2.verify(rows[0].password_hash, old_password);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'L’ancien mot de passe est incorrect.' });
    }

    const newHash = await argon2.hash(new_password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4
    });

    await pool.query('UPDATE admins SET password_hash = ? WHERE id = ?', [newHash, req.session.admin.id]);
    await logAuth(req.session.admin.id, req.session.admin.username, 'PASSWORD_CHANGE', 'SUCCESS', req, 'Modification mot de passe');

    res.json({ success: true, message: 'Mot de passe modifié avec succès !' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erreur lors de la mise à jour du mot de passe.' });
  }
});

// ==========================================
// 9. API STATS & AUDIT LOGS (Affichage dans le Panel)
// ==========================================
router.get('/api/auth/logs', async (req, res) => {
  if (!req.session?.admin?.authenticated) {
    return res.status(401).json({ success: false, error: 'Non authentifié.' });
  }

  try {
    // 1. Liste des utilisateurs enregistrés
    const [users] = await pool.query(`
      SELECT id, username, email, role, is_totp_enabled, auth_provider, created_at 
      FROM admins 
      ORDER BY id DESC
    `);

    // 2. Historique des dernières connexions et inscriptions
    const [logs] = await pool.query(`
      SELECT id, username, action, provider, ip_address, user_agent, status, details, created_at 
      FROM auth_logs 
      ORDER BY id DESC 
      LIMIT 50
    `);

    res.json({
      success: true,
      users,
      logs
    });
  } catch (err) {
    console.error('[AUTH_GET_LOGS_ERROR]', err);
    res.status(500).json({ success: false, error: 'Erreur récupération des logs.' });
  }
});

module.exports = router;
