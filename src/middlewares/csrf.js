const crypto = require('crypto');

function csrfProtection(req, res, next) {
  if (!req.session) {
    return next();
  }

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  
  res.locals.csrfToken = req.session.csrfToken;

  // Méthodes sans mutation
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Exemptions : première soumission login, routes API publiques FiveM et activation directe
  if (req.path === '/login' || req.path.startsWith('/api/licenses') || req.path.startsWith('/trpc')) {
    return next();
  }

  const clientToken = req.body?._csrf || req.headers['x-csrf-token'];

  if (!clientToken || typeof clientToken !== 'string') {
    return res.status(403).json({ error: 'Token CSRF manquant ou invalide' });
  }

  const tokenBuffer = Buffer.from(req.session.csrfToken);
  const clientBuffer = Buffer.from(clientToken);

  if (tokenBuffer.length !== clientBuffer.length || !crypto.timingSafeEqual(tokenBuffer, clientBuffer)) {
    return res.status(403).json({ error: 'Échec de la validation CSRF' });
  }

  next();
}

module.exports = csrfProtection;
