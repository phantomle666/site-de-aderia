const mysql = require('mysql2/promise');
require('dotenv').config();

const fivemPool = mysql.createPool({
  host: process.env.FIVEM_DB_HOST || process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.FIVEM_DB_PORT || process.env.DB_PORT || '3306', 10),
  user: process.env.FIVEM_DB_USER || process.env.DB_USER || 'root',
  password: process.env.FIVEM_DB_PASSWORD || process.env.DB_PASSWORD || '',
  database: process.env.FIVEM_DB_NAME || 'es_extended',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 5000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  charset: 'utf8mb4'
});

module.exports = fivemPool;
