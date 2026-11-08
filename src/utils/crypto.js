const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recommandé pour GCM
const TAG_LENGTH = 16; // 128 bits auth tag

function getEncryptionKey() {
  const hexKey = process.env.LICENSE_ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error('LICENSE_ENCRYPTION_KEY invalide ou absente du .env (doit faire 64 caractères hex / 32 octets)');
  }
  return Buffer.from(hexKey, 'hex');
}

/**
 * Génère une clé au format sCORE-XXXX-XXXX-XXXX-XXXX
 */
function generateLicenseKey(prefix = 'sCORE') {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push(crypto.randomBytes(2).toString('hex').toUpperCase());
  }
  return `${prefix}-${parts.join('-')}`;
}

/**
 * Hash SHA-256 de la clé pour recherche directe en base
 */
function hashLicenseKey(plainKey) {
  return crypto.createHash('sha256').update(plainKey.trim()).digest('hex');
}

/**
 * Masque une clé pour l'affichage (ex: sCORE-A1B2-****-****-C3D4)
 */
function maskLicenseKey(plainKey) {
  const parts = plainKey.split('-');
  if (parts.length >= 4) {
    return `${parts[0]}-${parts[1]}-****-****-${parts[parts.length - 1]}`;
  }
  return plainKey.slice(0, 4) + '****' + plainKey.slice(-4);
}

/**
 * Chiffre une chaîne en AES-256-GCM
 */
function encryptText(plainText) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  
  // Format stocké : iv:tag:encrypted
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Déchiffre une chaîne chiffrée en AES-256-GCM
 */
function decryptText(cipherText) {
  const key = getEncryptionKey();
  const [ivHex, tagHex, encryptedHex] = cipherText.split(':');
  if (!ivHex || !tagHex || !encryptedHex) {
    throw new Error('Format de texte chiffré invalide');
  }
  
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = {
  generateLicenseKey,
  hashLicenseKey,
  maskLicenseKey,
  encryptText,
  decryptText
};
