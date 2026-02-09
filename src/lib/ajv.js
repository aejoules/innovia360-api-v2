import Ajv from 'ajv';
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
