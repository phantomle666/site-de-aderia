function requireAdmin(req, res, next) {
  if (!req.session || !req.session.admin || !req.session.admin.authenticated) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Non authentifié' });
    }
    return res.redirect('/admin/login');
  }

  // Vérification stricte des permissions : seuls les rôles admin ou superadmin peuvent accéder
  if (req.session.admin.role !== 'admin' && req.session.admin.role !== 'superadmin') {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: 'Accès interdit : privilèges administrateur requis.' });
    }
    return res.status(403).send('Accès refusé : votre compte n’a pas les permissions administrateur.');
  }

  if (!req.session.admin.totpVerified) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: '2FA non validé' });
    }
    return res.redirect('/verify-2fa');
  }

  next();
}

function requireRole(requiredRole) {
  return (req, res, next) => {
    requireAdmin(req, res, () => {
      if (req.session.admin.role !== requiredRole && req.session.admin.role !== 'superadmin') {
        return res.status(403).json({ error: 'Permissions insuffisantes' });
      }
      next();
    });
  };
}

module.exports = { requireAdmin, requireRole };
