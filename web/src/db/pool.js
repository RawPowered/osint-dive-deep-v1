const mysql = require('mysql2/promise');
const { getDbConfig } = require('../config');

let pool = null;
let workPool = null;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function poolOptions(configOverrides = {}, workload = false) {
  const cfg = getDbConfig(configOverrides);
  if (!cfg.user || !cfg.database) throw new Error('Database configuration incomplete');

  const connectionLimit = workload
    ? boundedInteger(process.env.DB_WORK_POOL_SIZE, 2, 1, 8)
    : boundedInteger(process.env.DB_POOL_SIZE, 10, 2, 50);
  const queueLimit = workload
    ? boundedInteger(process.env.DB_WORK_POOL_QUEUE_LIMIT, 12, 1, 100)
    : boundedInteger(process.env.DB_POOL_QUEUE_LIMIT, 40, 1, 500);

  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit,
    maxIdle: connectionLimit,
    idleTimeout: boundedInteger(process.env.DB_POOL_IDLE_TIMEOUT_MS, 60000, 10000, 600000),
    queueLimit,
    connectTimeout: boundedInteger(process.env.DB_CONNECT_TIMEOUT_MS, 10000, 3000, 60000),
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    namedPlaceholders: false,
    dateStrings: true,
  };
}

function createPool(configOverrides = {}) {
  return mysql.createPool(poolOptions(configOverrides, false));
}

function createWorkPool(configOverrides = {}) {
  return mysql.createPool(poolOptions(configOverrides, true));
}

function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

function getWorkPool() {
  if (!workPool) workPool = createWorkPool();
  return workPool;
}

function setPool(newPool) {
  pool = newPool;
}

async function closePool() {
  const active = [pool, workPool].filter(Boolean);
  pool = null;
  workPool = null;
  await Promise.allSettled(active.map((item) => item.end()));
}

/** Test credentials without requiring an existing database (optional create). */
async function testConnection({ host, port, user, password, database, createDatabase = false }) {
  const conn = await mysql.createConnection({
    host: host || '127.0.0.1',
    port: Number(port || 3306),
    user,
    password: password || '',
    multipleStatements: true,
    connectTimeout: boundedInteger(process.env.DB_CONNECT_TIMEOUT_MS, 10000, 3000, 60000),
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
  try {
    await conn.query('SELECT 1');
    if (database) {
      if (createDatabase) {
        await conn.query(
          `CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
      }
      await conn.query(`USE \`${database.replace(/`/g, '')}\``);
      await conn.query('SELECT 1');
    }
    return { ok: true };
  } finally {
    await conn.end();
  }
}

module.exports = {
  createPool,
  createWorkPool,
  getPool,
  getWorkPool,
  setPool,
  closePool,
  testConnection,
};
