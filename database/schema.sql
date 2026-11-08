CREATE DATABASE IF NOT EXISTS `fivem_licenses` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `fivem_licenses`;

-- 1. Table des administrateurs
CREATE TABLE IF NOT EXISTS `admins` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(50) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `totp_secret` VARCHAR(64) NOT NULL,
  `role` ENUM('admin', 'superadmin') NOT NULL DEFAULT 'admin',
  `failed_attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `locked_until` DATETIME NULL DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Table des licences
CREATE TABLE IF NOT EXISTS `licenses` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `license_hash` CHAR(64) NOT NULL UNIQUE COMMENT 'Hash SHA-256 pour vérification ultra-rapide',
  `encrypted_key` TEXT NOT NULL COMMENT 'Clé chiffrée en AES-256-GCM',
  `masked_key` VARCHAR(32) NOT NULL COMMENT 'Affichage masqué pour logs et listes : sCORE-XXXX-****-XXXX',
  `product` VARCHAR(64) NOT NULL,
  `type` ENUM('standard', 'lifetime', 'gift') NOT NULL DEFAULT 'standard',
  `status` ENUM('active', 'revoked', 'expired') NOT NULL DEFAULT 'active',
  `expires_at` DATETIME NULL DEFAULT NULL COMMENT 'NULL = lifetime',
  `max_servers` INT UNSIGNED NOT NULL DEFAULT 1,
  `note` VARCHAR(255) NULL DEFAULT NULL,
  `source` VARCHAR(32) NOT NULL DEFAULT 'manual',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_license_hash` (`license_hash`),
  INDEX `idx_license_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Table des IP liées aux licences
CREATE TABLE IF NOT EXISTS `license_ips` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `license_id` INT UNSIGNED NOT NULL,
  `ip_address` VARCHAR(45) NOT NULL,
  `server_name` VARCHAR(100) NULL DEFAULT NULL,
  `last_seen_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uniq_license_ip` (`license_id`, `ip_address`),
  CONSTRAINT `fk_license_ip` FOREIGN KEY (`license_id`) REFERENCES `licenses`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Table du journal d'audit
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `admin_id` INT UNSIGNED NULL DEFAULT NULL,
  `admin_username` VARCHAR(50) NOT NULL,
  `action` VARCHAR(64) NOT NULL,
  `target_type` VARCHAR(32) NOT NULL,
  `target_id` VARCHAR(64) NULL DEFAULT NULL,
  `ip_address` VARCHAR(45) NOT NULL,
  `before_state` JSON NULL DEFAULT NULL,
  `after_state` JSON NULL DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_audit_admin` FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON DELETE SET NULL,
  INDEX `idx_audit_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
