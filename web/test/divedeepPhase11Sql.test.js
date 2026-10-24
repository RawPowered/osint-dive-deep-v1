'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');

function insertBlock(table) {
  const pattern = new RegExp(`INSERT IGNORE INTO ${table}\\s*\\(([^)]*)\\)\\s*VALUES\\s*([\\s\\S]*?);`);
  const match = sql.match(pattern);
  assert.ok(match, `Missing seed block for ${table}`);
  return {
    columns: match[1].split(',').map((value) => value.trim()),
    values: match[2].trim(),
  };
}

function parseRows(source) {
  const rows = [];
  let current = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "'" && quoted && next === "'") {
      current += "''";
      i += 1;
      continue;
    }
    if (char === "'") quoted = !quoted;
    if (!quoted && char === '(') {
      if (depth > 0) current += char;
      depth += 1;
      continue;
    }
    if (!quoted && char === ')') {
      depth -= 1;
      if (depth === 0) {
        rows.push(current);
        current = '';
        continue;
      }
    }
    if (depth > 0) current += char;
  }
  return rows;
}

function splitFields(source) {
  const fields = [];
  let current = '';
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "'" && quoted && next === "'") {
      current += "''";
      i += 1;
      continue;
    }
    if (char === "'") quoted = !quoted;
    if (!quoted && char === '(') depth += 1;
    if (!quoted && char === ')') depth -= 1;
    if (!quoted && depth === 0 && char === ',') {
      fields.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current.trim());
  return fields;
}

function sqlString(value) {
  assert.ok(value.startsWith("'") && value.endsWith("'"), `Expected SQL string, received ${value}`);
  return value.slice(1, -1).replace(/''/g, "'");
}

const profileSeed = insertBlock('divedeep_image_analysis_profile_versions');
const rows = parseRows(profileSeed.values);
assert.equal(rows.length, 4);
for (const rowSource of rows) {
  const fields = splitFields(rowSource);
  assert.equal(fields.length, profileSeed.columns.length, `Profile seed column/value mismatch: ${fields.length}/${profileSeed.columns.length}`);
  const record = Object.fromEntries(profileSeed.columns.map((column, index) => [column, fields[index]]));
  const operations = JSON.parse(sqlString(record.operations_json));
  const review = JSON.parse(sqlString(record.review_policy_json));
  const retention = JSON.parse(sqlString(record.retention_policy_json));
  assert.equal(operations.useCollections, false);
  assert.equal(review.humanReviewRequired, true);
  assert.equal(review.autoConfirm, false);
  assert.equal(review.blurUntilDisposition, true);
  assert.equal(retention.nonmatchHours, 24);
  assert.equal(retention.pendingReviewDays, 30);
}

const packageLinks = insertBlock('divedeep_package_image_analysis_links');
assert.equal(parseRows(packageLinks.values).length, 4);
assert.match(sql, /provider_result_enc\s+LONGTEXT\s+NOT NULL/);
assert.doesNotMatch(sql, /provider_result_json\s+LONGTEXT/);

console.log('DiveDeep Phase 1.1 SQL seed and retention checks passed');
