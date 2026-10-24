'use strict';

function validationError(message, status = 400, code = 'PLATFORM_CATALOG_SCHEMA_VALIDATION') {
  return Object.assign(new Error(message), { status, code });
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(expected, value) {
  const options = Array.isArray(expected) ? expected : [expected];
  const actual = valueType(value);
  return options.some((type) => type === actual || (type === 'number' && (actual === 'number' || actual === 'integer')));
}

/**
 * Dependency-free validator for the catalog's intentionally small JSON Schema
 * subset. This is not a general JSON Schema implementation.
 */
function validateAgainstSchema(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw validationError('Stored metadata schema is invalid', 500, 'PLATFORM_CATALOG_SCHEMA_INVALID');
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    throw validationError(`${path} must be ${Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type}`);
  }
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    throw validationError(`${path} must be one of the declared values`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < Number(schema.minLength)) throw validationError(`${path} is too short`);
    if (schema.maxLength != null && value.length > Number(schema.maxLength)) throw validationError(`${path} is too long`);
    if (schema.pattern) {
      let pattern;
      try { pattern = new RegExp(schema.pattern); }
      catch { throw validationError('Stored metadata schema contains an invalid pattern', 500, 'PLATFORM_CATALOG_SCHEMA_INVALID'); }
      if (!pattern.test(value)) throw validationError(`${path} does not match the required format`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < Number(schema.minimum)) throw validationError(`${path} is below the minimum`);
    if (schema.maximum != null && value > Number(schema.maximum)) throw validationError(`${path} exceeds the maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < Number(schema.minItems)) throw validationError(`${path} has too few items`);
    if (schema.maxItems != null && value.length > Number(schema.maxItems)) throw validationError(`${path} has too many items`);
    if (schema.uniqueItems) {
      const keys = value.map((item) => JSON.stringify(item));
      if (new Set(keys).size !== keys.length) throw validationError(`${path} must contain unique items`);
    }
    if (schema.items) value.forEach((item, index) => validateAgainstSchema(schema.items, item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw validationError(`${path}.${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) validateAgainstSchema(properties[key], item, `${path}.${key}`);
      else if (schema.additionalProperties === false) throw validationError(`${path}.${key} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateAgainstSchema(schema.additionalProperties, item, `${path}.${key}`);
    }
  }
  return true;
}

module.exports = { validateAgainstSchema };
