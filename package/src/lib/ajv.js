// Use the 2020-12 Ajv build so schemas declaring
// "$schema": "https://json-schema.org/draft/2020-12/schema"
// can be loaded/validated without missing meta-schema errors.
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export function buildAjv() {
  const ajv = new Ajv({
    strict: true,
    allErrors: true,
    removeAdditional: false,
    useDefaults: false,
    coerceTypes: false
  });
  addFormats(ajv);
  return ajv;
}
