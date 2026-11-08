const pool = require('../src/config/database');

async function migrate() {
  console.log('[MIGRATION] Démarrage de la mise à jour BDD...');

  // 1. Ajouter les colonnes nécessaires à la table admins si elles n'existent pas
  const [cols] = await pool.query('SHOW COLUMNS FROM admins');
  const existingCols = cols.map(c => c.Field);

  if (!existingCols.includes('email')) {
    await pool.query('ALTER TABLE admins ADD COLUMN email VARCHAR(191) NULL UNIQUE AFTER username');
    console.log('[MIGRATION] Colonne `email` ajoutée à `admins`.');
  }

  if (!existingCols.includes('is_totp_enabled')) {
    await pool.query('ALTER TABLE admins ADD COLUMN is_totp_enabled TINYINT(1) DEFAULT 0 AFTER totp_secret');
    console.log('[MIGRATION] Colonne `is_totp_enabled` ajoutée à `admins`.');
  }

  if (!existingCols.includes('google_id')) {
    await pool.query('ALTER TABLE admins ADD COLUMN google_id VARCHAR(100) NULL UNIQUE AFTER is_totp_enabled');
    console.log('[MIGRATION] Colonne `google_id` ajoutée à `admins`.');
  }

  if (!existingCols.includes('auth_provider')) {
    await pool.query("ALTER TABLE admins ADD COLUMN auth_provider ENUM('local', 'google') DEFAULT 'local' AFTER google_id");
    console.log('[MIGRATION] Colonne `auth_provider` ajoutée à `admins`.');
  }

  if (!existingCols.includes('avatar_url')) {
    await pool.query('ALTER TABLE admins ADD COLUMN avatar_url VARCHAR(255) NULL AFTER auth_provider');
    console.log('[MIGRATION] Colonne `avatar_url` ajoutée à `admins`.');
  }

  // Si pentagone a déjà un totp_secret, on active son TOTP par défaut
  await pool.query("UPDATE admins SET is_totp_enabled = 1 WHERE username = 'pentagone' AND totp_secret IS NOT NULL AND totp_secret != ''");

  // 2. Création de la table auth_logs pour tracer chaque connexion & inscription (audit sécurité)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_logs (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      admin_id INT UNSIGNED NULL,
      username VARCHAR(100) NOT NULL,
      action ENUM('LOGIN_SUCCESS', 'LOGIN_FAILED', 'REGISTER', 'LOGOUT', '2FA_SUCCESS', '2FA_FAILED', '2FA_ENABLED', '2FA_DISABLED', 'PASSWORD_CHANGE') NOT NULL,
      provider VARCHAR(20) DEFAULT 'local',
      ip_address VARCHAR(45) NOT NULL,
      user_agent VARCHAR(255) NULL,
      status ENUM('SUCCESS', 'FAILED') DEFAULT 'SUCCESS',
      details TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_auth_username (username),
      INDEX idx_auth_ip (ip_address),
      INDEX idx_auth_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('[MIGRATION] Table `auth_logs` créée avec succès.');

  console.log('[MIGRATION] Migration BDD terminée à 100% !');
  process.exit(0);
}

migrate().catch(err => {
  console.error('[MIGRATION_ERROR]', err);
  process.exit(1);
});
