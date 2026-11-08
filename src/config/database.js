const mysql = require('mysql2/promise');
require('dotenv').config();

// Support complet de MYSQL_URL / DATABASE_URL fournis par Railway ou variables séparées
const dbConfig = process.env.MYSQL_URL || process.env.DATABASE_URL
  ? {
      uri: process.env.MYSQL_URL || process.env.DATABASE_URL,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 10000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      charset: 'utf8mb4'
    }
  : {
      host: process.env.MYSQLHOST || process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.MYSQLPORT || process.env.DB_PORT || '3306', 10),
      user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
      password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
      database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'railway',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 10000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      charset: 'utf8mb4'
    };

const pool = mysql.createPool(dbConfig);

module.exports = pool;
