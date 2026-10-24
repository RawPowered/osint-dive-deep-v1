const GENERIC_IDENTITIES = new Set(['admin', 'system', 'unknown', 'anonymous', 'none', 'null']);

function clean(value, maxLength) {
  if (value == null) return null;
  const result = String(value).trim();
  return result ? result.slice(0, maxLength) : null;
}

function isGeneric(value) {
  const normalized = clean(value, 128);
  return normalized ? GENERIC_IDENTITIES.has(normalized.toLowerCase()) : false;
}

async function resolveTelemetryIdentity(pool, input = {}) {
  const locationId = clean(input.locationId, 128);
  const suppliedUserId = clean(input.userId, 128);
  const suppliedUsername = clean(input.username, 128);
  const suppliedEmail = clean(input.email, 255);
  if (!locationId) {
    return {
      resolved: false,
      userId: isGeneric(suppliedUserId) ? null : suppliedUserId,
      username: isGeneric(suppliedUsername) ? null : suppliedUsername,
      email: suppliedEmail,
    };
  }

  let row = null;
  let matchedBy = null;
  if (suppliedUserId && !isGeneric(suppliedUserId)) {
    const [rows] = await pool.query(
      `SELECT id, username, crmUserName, email
       FROM users WHERE id = ? AND locationId = ? LIMIT 1`,
      [suppliedUserId, locationId]
    );
    row = rows[0] || null;
    if (row) matchedBy = 'userId';
  }

  if (!row && suppliedUsername && !isGeneric(suppliedUsername)) {
    const [rows] = await pool.query(
      `SELECT id, username, crmUserName, email
       FROM users WHERE LOWER(username) = LOWER(?) AND locationId = ? LIMIT 1`,
      [suppliedUsername, locationId]
    );
    row = rows[0] || null;
    if (row) matchedBy = 'username';
  }

  if (!row && suppliedEmail) {
    const [rows] = await pool.query(
      `SELECT id, username, crmUserName, email
       FROM users WHERE LOWER(email) = LOWER(?) AND locationId = ? LIMIT 1`,
      [suppliedEmail, locationId]
    );
    row = rows[0] || null;
    if (row) matchedBy = 'email';
  }

  if (!row) {
    return {
      resolved: false,
      matchedBy: null,
      userId: isGeneric(suppliedUserId) ? null : suppliedUserId,
      username: isGeneric(suppliedUsername) ? null : suppliedUsername,
      email: suppliedEmail,
    };
  }

  return {
    resolved: true,
    matchedBy,
    userId: row.id,
    username: row.username || row.crmUserName || suppliedUsername || null,
    email: row.email || suppliedEmail || null,
  };
}

module.exports = { resolveTelemetryIdentity, isGeneric };
