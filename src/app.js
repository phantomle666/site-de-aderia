const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
require('dotenv').config();

const ipFilter = require('./middlewares/ipFilter');
const csrfProtection = require('./middlewares/csrf');
const adminAuthRoutes = require('./routes/adminAuth');
const adminDashboardRoutes = require('./routes/adminDashboard');
const adminLicensesRoutes = require('./routes/adminLicenses');
const apiFivemRoutes = require('./routes/apiFivem');
const apiManageRoutes = require('./routes/apiManage');
const trpcRoutes = require('./routes/trpc');

const app = express();

// 1. Headers de sécurité stricts (Helmet) avec support Cartographie & CDNs
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://unpkg.com", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://api-images.aderia.fr', 'https://raw.githubusercontent.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      connectSrc: ["'self'", 'https://raw.githubusercontent.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      frameAncestors: ["'none'"]
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  referrerPolicy: { policy: 'same-origin' }
}));

// 2. Parsers de corps de requêtes
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

// 3. Fichiers statiques existants
app.use(express.static(path.join(__dirname, '../public')));
app.use('/styles', express.static(path.join(__dirname, '../styles')));
app.use('/images', express.static(path.join(__dirname, '../images')));
app.use('/scripts', express.static(path.join(__dirname, '../scripts')));
app.use('/pages', express.static(path.join(__dirname, '../pages')));

// Alias Next.js static paths → fichiers locaux
// Les HTML générés par Next.js référencent /_next/static/chunks/... etc.
app.use('/_next/static/chunks', express.static(path.join(__dirname, '../scripts')));
app.use('/_next/static/css', express.static(path.join(__dirname, '../styles')));
app.use('/_next/static/media', express.static(path.join(__dirname, '../images')));
// Alias supplémentaire pour les chunks dans des sous-dossiers (app/layout etc.)
app.use('/_next/static/chunks/app', express.static(path.join(__dirname, '../scripts')));
app.use('/_next/static/chunks/pages', express.static(path.join(__dirname, '../scripts')));

// 4. Moteur de rendu sécurisé EJS (anti-XSS natif avec <%= %>)
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// 5. Configuration stricte des sessions de cookies
const isSecure = process.env.NODE_ENV === 'production' && (process.env.APP_URL || '').startsWith('https');
app.use(session({
  name: isSecure ? '__Secure-sid' : 'admin_sid',
  secret: process.env.SESSION_SECRET || 'fallback-secret-for-dev-mode-only-1234567890',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isSecure, // Activé uniquement si servi sur un domaine HTTPS
    sameSite: 'lax',
    maxAge: 2 * 60 * 60 * 1000 // 2 heures
  }
}));

// Protection CSRF globale pour les formulaires web
app.use(csrfProtection);

// Routes d'authentification publiques (Login, Register, Google, Verify-2FA, Logout, Settings API)
app.use('/', adminAuthRoutes);

// Redirection de la session client
function requireClientAuth(req, res, next) {
  if (req.session?.admin?.authenticated && req.session?.admin?.totpVerified) {
    return next();
  }
  return res.redirect('/login');
}

// Pages client (FiveM player dashboard & redeem)
app.get('/dashboard', requireClientAuth, (req, res) => res.sendFile(path.join(__dirname, '../pages/redeem.html')));
app.get('/dashboard/server/:id', requireClientAuth, (req, res) => res.sendFile(path.join(__dirname, '../pages/server-management.html')));
app.get('/server-manage', requireClientAuth, (req, res) => res.sendFile(path.join(__dirname, '../pages/server-management.html')));
app.get('/dashboard/redeem', requireClientAuth, (req, res) => res.sendFile(path.join(__dirname, '../pages/redeem.html')));
app.get('/pages/redeem.html', requireClientAuth, (req, res) => res.sendFile(path.join(__dirname, '../pages/redeem.html')));
app.get('/pages/dashboard.html', requireClientAuth, (req, res) => res.sendFile(path.join(__dirname, '../pages/redeem.html')));
app.get('/redeem', requireClientAuth, (req, res) => res.sendFile(path.join(__dirname, '../pages/redeem.html')));

// Session client simulée pour débloquer l'interface redeem
app.get('/api/auth/get-session', (req, res) => {
  res.json({
    user: {
      id: String(req.session?.admin?.id || "1"),
      name: req.session?.admin?.username || "pentagone",
      email: req.session?.admin?.email || "pentagone@discord.gg",
      image: "/images/5c34c4d1e2e1fdb9c0f7fd37ac081df2.png"
    },
    session: {
      id: "session-active-local",
      userId: String(req.session?.admin?.id || "1")
    }
  });
});

// 6. Routes publiques FiveM API, Management & tRPC (pas de session admin requise)
app.use('/api/licenses', apiFivemRoutes);
app.use('/api/manage', apiManageRoutes);
app.use('/trpc', trpcRoutes);

// 7. Routes Admin (avec filtrage IP optionnel)
app.use('/admin', ipFilter);
app.use('/admin', adminDashboardRoutes);
app.use('/admin', adminLicensesRoutes);

// Redirection accueil vers /login
app.get('/', (req, res) => res.redirect('/login'));

// 8. Gestionnaire 404
app.use((req, res) => {
  res.status(404).send('Page non trouvée.');
});

// 9. Gestionnaire d'erreur global (aucun stack trace exposé)
app.use((err, req, res, next) => {
  console.error('[UNHANDLED_ERROR]', err);
  res.status(500).json({ error: 'Une erreur interne est survenue.' });
});

const autoInitDb = require('./config/initDb');

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`[SECURE_PANEL] Serveur démarré sur http://localhost:${PORT}`);
    // Auto-initialisation des tables BDD au démarrage
    await autoInitDb();
  });
}

module.exports = app;
