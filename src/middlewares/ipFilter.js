function ipFilter(req, res, next) {
  const allowedList = process.env.ADMIN_ALLOWED_IPS;
  if (!allowedList || allowedList.trim() === '') {
    return next();
  }

  const clientIp = (req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const ips = allowedList.split(',').map(ip => ip.trim());

  if (!ips.includes(clientIp)) {
    console.warn(`[SECURITY] Accès /admin bloqué pour IP non autorisée : ${clientIp}`);
    return res.status(403).send('Accès restreint.');
  }

  next();
}

module.exports = ipFilter;
