/*
 * Emergency, SSH-only recovery for the single DiveDeep root owner.
 * The password is read from the terminal and is never accepted as an argument.
 */
const bcrypt = require('bcryptjs');
const { loadEnv } = require('../config');
const { createPool } = require('./pool');
const { validPassword, verifyPassword } = require('../services/adminUsers');
const { promptSecret } = require('./setUserPassword');

const BCRYPT_ROUNDS = 12;

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]).trim() : '';
}

async function resolveRootOwner(pool, requestedUsername = '') {
  const params = [];
  let where = "role = 'admin'";
  if (requestedUsername) {
    where += ' AND username = ?';
    params.push(requestedUsername);
  }
  const [owners] = await pool.query(
    `SELECT id, username FROM admin_users WHERE ${where} ORDER BY created_at ASC LIMIT 2`,
    params
  );
  if (owners.length !== 1) {
    throw new Error(requestedUsername
      ? 'A matching DiveDeep root owner was not found uniquely'
      : 'Expected exactly one DiveDeep root owner. Supply --username only if recovery requires it.');
  }
  return owners[0];
}

async function main() {
  loadEnv();
  const pool = createPool();
  try {
    const owner = await resolveRootOwner(pool, argument('username'));
    const password = await promptSecret('New root-owner password (12+ characters): ');
    const confirmation = await promptSecret('Confirm new root-owner password: ');
    if (password !== confirmation) throw new Error('Passwords do not match');
    validPassword(password);

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const [result] = await pool.query(
      "UPDATE admin_users SET password_hash = ? WHERE id = ? AND role = 'admin'",
      [passwordHash, owner.id]
    );
    if (Number(result.affectedRows) !== 1) throw new Error('Root-owner password update did not modify exactly one account');

    const verified = await verifyPassword(owner.username, password, pool);
    if (!verified || verified.id !== owner.id || verified.principalType !== 'root') {
      throw new Error('Post-reset root-owner login verification failed');
    }
    console.log('DiveDeep root-owner password reset and login verification completed.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const safeMessage = String(error.message || 'ROOT_OWNER_RESET_FAILED').replace(/[\r\n]/g, ' ').slice(0, 240);
    console.error(`Root-owner recovery failed: ${safeMessage}`);
    process.exitCode = 1;
  });
}

module.exports = { argument, resolveRootOwner };
