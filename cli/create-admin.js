const readline = require('readline');
const argon2 = require('argon2');
const pool = require('../src/config/database');
const { generateSecret, getQRCodeDataURL } = require('../src/utils/totp');
require('dotenv').config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('\n=============================================');
  console.log('   CRÉATION SÉCURISÉE D’UN ADMINISTRATEUR    ');
  console.log('=============================================\n');

  const username = await ask('Nom d\'utilisateur : ');
  if (!username || username.length < 3) {
    console.error('❌ Erreur : Nom d\'utilisateur trop court (min 3 caractères).');
    process.exit(1);
  }

  const password = await ask('Mot de passe (min 12 caractères) : ');
  if (!password || password.length < 12) {
    console.error('❌ Erreur : Le mot de passe doit comporter au moins 12 caractères.');
    process.exit(1);
  }

  const roleInput = await ask('Rôle (admin / superadmin) [défaut: superadmin] : ');
  const role = roleInput === 'admin' ? 'admin' : 'superadmin';

  try {
    const [exists] = await pool.query('SELECT id FROM admins WHERE username = ?', [username]);
    if (exists.length > 0) {
      console.error('❌ Erreur : Cet administrateur existe déjà.');
      process.exit(1);
    }

    console.log('\n⏳ [1/3] Hachage avec Argon2id...');
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1
    });

    console.log('⏳ [2/3] Génération du secret 2FA TOTP...');
    const totpSecret = generateSecret();

    console.log('⏳ [3/3] Enregistrement en base de données...');
    await pool.query(
      'INSERT INTO admins (username, password_hash, totp_secret, role) VALUES (?, ?, ?, ?)',
      [username, passwordHash, totpSecret, role]
    );

    console.log('\n=============================================');
    console.log('✅ ADMINISTRATEUR CRÉÉ AVEC SUCCÈS !');
    console.log('=============================================');
    console.log(`Nom d'utilisateur : ${username}`);
    console.log(`Rôle              : ${role}`);
    console.log(`Secret 2FA (clé)  : ${totpSecret}`);
    console.log('\n➡️  Ajoutez cette clé dans Google Authenticator ou 1Password.');
    
    const qrData = await getQRCodeDataURL(username, totpSecret);
    console.log('\nLien QRCode 2FA (Data URL à copier dans le navigateur si besoin) :\n');
    console.log(qrData.slice(0, 100) + '... (QR Code prêt)');

    process.exit(0);
  } catch (err) {
    console.error('\n❌ Erreur :', err.message);
    process.exit(1);
  }
}

main();
