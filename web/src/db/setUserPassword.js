const crypto = require('crypto');
const { loadEnv } = require('../config');
const { createPool } = require('./pool');
const { preparePasswordCredential, verifyUserCredentials } = require('../services/loginSecurity');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]).trim() : '';
}

function promptSecret(label) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('A protected interactive terminal is required'));
      return;
    }

    let value = '';
    let finished = false;
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      output.write('\n');
      resolve(value);
    };
    const abort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      output.write('\n');
      reject(new Error('Credential reset cancelled'));
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') return abort();
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (character >= ' ' && value.length < 1024) {
          value += character;
          output.write('*');
        }
      }
    };

    output.write(label);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function main() {
  const locationId = argument('location');
  const username = argument('username');
  if (!locationId || !username) {
    throw new Error('Usage: npm run user:set-password -- --location LOCATION_ID --username USERNAME');
  }

  const password = await promptSecret('New password (12+ characters): ');
  const confirmation = await promptSecret('Confirm new password: ');
  if (password !== confirmation) throw new Error('Passwords do not match');

  loadEnv();
  const pool = createPool();
  let connection;
  try {
    const credential = await preparePasswordCredential({ password, minLength: 12 });
    const [users] = await pool.query(
      `SELECT id, locationId, username FROM users
       WHERE locationId = ? AND username = ? ORDER BY id LIMIT 2`,
      [locationId, username]
    );
    if (users.length === 0) throw new Error('Exactly one Legacy user was not found for that location and username');
    if (users.length > 1) throw new Error('Multiple Legacy users matched; resolve the duplicate identity before resetting');

    const user = users[0];
    const requestId = crypto.randomUUID();
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.query(
      'UPDATE users SET passwordHash = ? WHERE id = ? AND locationId = ?',
      [credential.value, user.id, locationId]
    );
    if (Number(result.affectedRows) !== 1) throw new Error('Credential update did not modify exactly one Legacy user');
    const verification = await verifyUserCredentials({
      locationId: user.locationId,
      userId: user.id,
      password,
    }, connection);
    if (!verification.ok || verification.passwordScheme !== 'bcrypt') {
      throw new Error('Post-update verification failed; the transaction was rolled back');
    }
    await connection.query(
      `INSERT INTO api_login_events
        (event_type,outcome,username,user_id,location_id,user_agent,detail,request_id)
       VALUES ('password_reset','success',?,?,?,'server-cli','cli_password_updated_bcrypt',?)`,
      [user.username, user.id, user.locationId, requestId]
    );
    await connection.commit();
    console.log(`Legacy credential reset completed. scheme=bcrypt requestId=${requestId}`);
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch {}
    }
    throw error;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const safeCode = String(error.code || error.message || 'PASSWORD_RESET_FAILED')
      .replace(/[\r\n]/g, ' ').slice(0, 240);
    console.error(`Credential reset failed: ${safeCode}`);
    process.exitCode = 1;
  });
}

module.exports = { argument, promptSecret };
