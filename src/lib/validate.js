import fs from 'fs';
import path from 'path';
import { buildAjv } from './ajv.js';

const ajv = buildAjv();

export function loadSchemas(dirAbsPath) {
  const files = fs.readdirSync(dirAbsPath).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const schema = JSON.parse(fs.readFileSync(path.join(dirAbsPath, file), 'utf-8'));
    if (!schema.$id) throw new Error(`Schema missing $id: ${file}`);
    ajv.addSchema(schema, schema.$id);
  }
}

export function validateBody(schemaId) {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`Schema not found: ${schemaId}`);
  return (req, res, next) => {
    const ok = validate(req.body);
    if (ok) return next();
    return res.status(400).json({
      ok: false,
      error: {
        code: 'invalid_payload',
        message: 'Request body does not match schema',
        schema_id: schemaId,
        details: (validate.errors || []).map((e) => ({
          instancePath: e.instancePath,
          schemaPath: e.schemaPath,
          keyword: e.keyword,
          message: e.message
        }))
      }
    });
  };
}

export function validateResponse(schemaId, payload) {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`Schema not found: ${schemaId}`);
  const ok = validate(payload);
  if (!ok) {
    const err = new Error('Response does not match schema');
    err.validationErrors = validate.errors;
    throw err;
  }
}
