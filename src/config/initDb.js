const pool = require('./database');

async function autoInitDb() {
  try {
    console.log('[AUTO_INIT_DB] Vérification des tables de la base de données...');

    // 1. Table admins
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        email VARCHAR(191) NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        totp_secret VARCHAR(64) NULL,
        is_totp_enabled TINYINT(1) DEFAULT 0,
        google_id VARCHAR(100) NULL UNIQUE,
        auth_provider ENUM('local', 'google') DEFAULT 'local',
        avatar_url VARCHAR(255) NULL,
        role ENUM('client','admin','superadmin') DEFAULT 'client',
        failed_attempts INT UNSIGNED DEFAULT 0,
        locked_until DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Migration du rôle pour autoriser 'client' si la table existait déjà
    try {
      await pool.query("ALTER TABLE admins MODIFY COLUMN role ENUM('client','admin','superadmin') DEFAULT 'client'");
    } catch (_) {}

    // Initialisation ou synchronisation forcée du superadmin par défaut "pentagone"
    try {
      const argon2 = require('argon2');
      const defaultAdminHash = await argon2.hash('admin12345678', {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4
      });

      const [existingPentagone] = await pool.query("SELECT id FROM admins WHERE username = 'pentagone'");
      if (existingPentagone.length === 0) {
        await pool.query(
          "INSERT INTO admins (username, email, password_hash, role, is_totp_enabled, auth_provider, failed_attempts, locked_until) VALUES (?, ?, ?, 'superadmin', 0, 'local', 0, NULL)",
          ['pentagone', 'pentagone@aderia.fr', defaultAdminHash]
        );
        console.log('[AUTO_INIT_DB] Compte superadmin "pentagone" créé.');
      } else {
        // Réinitialise le mot de passe sur admin12345678, déverrouille le compte et retire le blocage 2FA pour repartir sur une base saine
        await pool.query(
          "UPDATE admins SET password_hash = ?, role = 'superadmin', failed_attempts = 0, locked_until = NULL, is_totp_enabled = 0 WHERE username = 'pentagone'",
          [defaultAdminHash]
        );
        console.log('[AUTO_INIT_DB] Compte superadmin "pentagone" déverrouillé et synchronisé.');
      }
    } catch (eAdmin) {
      console.warn('[AUTO_INIT_DB] Note admin init:', eAdmin.message);
    }

    // 2. Table auth_logs
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

    // 3. Table aderia_blips
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aderia_blips (
        id VARCHAR(50) PRIMARY KEY,
        label VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL,
        x FLOAT NOT NULL,
        y FLOAT NOT NULL,
        z FLOAT NOT NULL,
        sprite INT DEFAULT 1,
        color INT DEFAULT 0,
        scale FLOAT DEFAULT 0.8,
        is_active TINYINT(1) DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_blip_category (category),
        INDEX idx_blip_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. Tables de gestion FiveM (licences & audit)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        license_hash CHAR(64) NULL UNIQUE,
        encrypted_key TEXT NULL,
        license_key VARCHAR(128) NULL UNIQUE,
        masked_key VARCHAR(32) NOT NULL,
        product VARCHAR(64) NOT NULL,
        type ENUM('standard', 'lifetime', 'gift') DEFAULT 'standard',
        customer_email VARCHAR(191) NULL,
        customer_discord VARCHAR(64) NULL,
        max_servers INT UNSIGNED DEFAULT 1,
        status ENUM('active','suspended','revoked','expired') DEFAULT 'active',
        note VARCHAR(255) NULL,
        source VARCHAR(32) DEFAULT 'manual',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Migration progressive de la table licenses avec ALTER TABLE compatible MySQL standard
    const licenseColumns = [
      "ALTER TABLE licenses ADD COLUMN license_hash CHAR(64) NULL",
      "ALTER TABLE licenses ADD COLUMN encrypted_key TEXT NULL",
      "ALTER TABLE licenses ADD COLUMN type ENUM('standard', 'lifetime', 'gift') DEFAULT 'standard'",
      "ALTER TABLE licenses ADD COLUMN note VARCHAR(255) NULL",
      "ALTER TABLE licenses ADD COLUMN source VARCHAR(32) DEFAULT 'manual'",
      "ALTER TABLE licenses MODIFY COLUMN license_key VARCHAR(128) NULL",
      "ALTER TABLE licenses MODIFY COLUMN customer_email VARCHAR(191) NULL",
      "ALTER TABLE licenses MODIFY COLUMN status ENUM('active','suspended','revoked','expired') DEFAULT 'active'"
    ];
    for (const sql of licenseColumns) {
      try {
        await pool.query(sql);
      } catch (err) {
        // Ignore si la colonne existe déjà (code ER_DUP_FIELDNAME)
      }
    }

    // 5. Table audit_logs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        admin_id INT UNSIGNED NULL,
        admin_username VARCHAR(50) NOT NULL,
        action VARCHAR(64) NOT NULL,
        target_type VARCHAR(32) NOT NULL,
        target_id VARCHAR(64) NULL,
        ip_address VARCHAR(45) NOT NULL,
        before_state JSON NULL,
        after_state JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS license_ips (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        license_id INT UNSIGNED NOT NULL,
        ip_address VARCHAR(45) NOT NULL,
        server_name VARCHAR(128) NULL,
        last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_lic_ip (license_id, ip_address)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('[AUTO_INIT_DB] Toutes les tables BDD sont prêtes et opérationnelles !');
  } catch (err) {
    console.error('[AUTO_INIT_DB_ERROR] Impossible d’initialiser les tables BDD:', err.message);
  }
}

module.exports = autoInitDb;
