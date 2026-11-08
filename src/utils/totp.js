const { authenticator } = require('otplib');
const qrcode = require('qrcode');

authenticator.options = {
  window: 1 // Autorise un léger décalage de 30 secondes
};

function generateSecret() {
  return authenticator.generateSecret();
}

function verifyToken(token, secret) {
  return authenticator.verify({ token: String(token).trim(), secret });
}

async function getQRCodeDataURL(username, secret, issuer = 'FiveM License Panel') {
  const otpauth = authenticator.keyuri(username, issuer, secret);
  return qrcode.toDataURL(otpauth);
}

module.exports = {
  generateSecret,
  verifyToken,
  getQRCodeDataURL
};
