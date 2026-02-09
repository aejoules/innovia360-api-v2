// src/lib/validate.js
import fs from "fs";
import path from "path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const ajv = new Ajv({
  strict: true,
  allErrors: true,
  validateSchema: true
});

addFormats(ajv);

export function loadSchemas(dirAbsPath) {
  const files = fs
    .readdirSync(dirAbsPath)
    .filter((f) => f.endsWith(".schema.json"));

  if (!files.length) {
    throw new Error(`No schemas found in: ${dirAbsPath}`);
  }

  for (const file of files) {
    const full = path.join(dirAbsPath, file);
    const schema = JSON.parse(fs.readFileSync(full, "utf8"));

    if (!schema.$id) {
      throw new Error(`Schema missing $id: ${file}`);
    }

    ajv.addSchema(schema, schema.$id);
  }

  console.log(`[schemas] loaded ${files.length} schemas from ${dirAbsPath}`);
}

export function validateBody(schemaId) {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`Schema not found: ${schemaId}`);

  return (req, res, next) => {
    const ok = validate(req.body);
    if (!ok) {
      return res.status(400).json({
        ok: false,
        error: {
          code: "invalid_payload",
          schema: schemaId,
          details: validate.errors
        }
      });
    }
    next();
  };
}
