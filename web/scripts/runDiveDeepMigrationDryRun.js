#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEnv, ROOT, getDbConfig, SCHEMA_VERSION } = require('../src/config');

function statements(sql) {
  return sql.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n').split(';').map((part) => part.trim()).filter(Boolean);
}
function arg(name) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

(async () => {
  const shadowDb = arg('shadow-db');
  if (shadowDb) loadEnv();
  const schemaPath = path.join(ROOT, 'sql', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const plan = statements(sql);
  const createTables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  const duplicates = createTables.filter((name, index) => createTables.indexOf(name) !== index);
  const staticResult = {
    schemaVersion: Number(SCHEMA_VERSION),
    statements: plan.length,
    createTables: createTables.length,
    duplicateTables: [...new Set(duplicates)],
    balancedParentheses: (sql.match(/\(/g) || []).length === (sql.match(/\)/g) || []).length,
  };
  staticResult.ok = staticResult.duplicateTables.length === 0 && staticResult.balancedParentheses && plan.length > 100;

  if (!shadowDb) {
    console.log(JSON.stringify({ mode: 'static', ...staticResult }, null, 2));
    if (!staticResult.ok) process.exitCode = 1;
    return;
  }
  if (!/(shadow|dryrun|staging)/i.test(shadowDb)) throw new Error('Shadow database name must contain shadow, dryrun, or staging');
  const current = getDbConfig();
  if (shadowDb === current.database) throw new Error('Shadow database cannot be the configured application database');
  if (process.env.DEPLOYMENT_ENV === 'production' && process.env.DIVEDEEP_MIGRATION_DRY_RUN_ACK !== 'DIVEDEEP_SHADOW_DATABASE') {
    throw new Error('Production migration dry run requires DIVEDEEP_MIGRATION_DRY_RUN_ACK=DIVEDEEP_SHADOW_DATABASE');
  }
  const mysql = require('mysql2/promise');
  const admin = await mysql.createConnection({ host: current.host, port: current.port, user: current.user, password: current.password, multipleStatements: false });
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${shadowDb.replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const shadow = await mysql.createConnection({ host: current.host, port: current.port, user: current.user, password: current.password, database: shadowDb, multipleStatements: false });
  try {
    for (const statement of plan) await shadow.query(statement);
    const [tables] = await shadow.query(`SELECT COUNT(*) total FROM information_schema.tables WHERE table_schema=?`, [shadowDb]);
    const [columns] = await shadow.query(`SELECT COUNT(*) total FROM information_schema.columns WHERE table_schema=?`, [shadowDb]);
    console.log(JSON.stringify({ mode: 'shadow', ...staticResult, shadowDatabase: shadowDb, tables: Number(tables[0].total), columns: Number(columns[0].total), ok: staticResult.ok && Number(tables[0].total) === createTables.length }, null, 2));
  } finally {
    await shadow.end();
    if (process.argv.includes('--drop-shadow')) await admin.query(`DROP DATABASE \`${shadowDb.replace(/`/g, '')}\``);
    await admin.end();
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
