// src/index.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import { loadSchemas } from "./lib/validate.js";
import { migrate } from "./lib/migrate.js";
import { logger } from "./lib/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));

// 1) Load schemas first (IMPORTANT)
loadSchemas(path.join(__dirname, "schemas", "v2"));

// 2) Migrate on boot (if enabled)
const MIGRATE_ON_BOOT = (process.env.MIGRATE_ON_BOOT || "").toLowerCase() === "true";
if (MIGRATE_ON_BOOT) {
  migrate().catch((err) => {
    logger.error({ err }, "migration failed on boot");
    process.exit(1);
  });
}

// 3) Health
app.get("/health", (req, res) => res.json({ ok: true, service: "innovia360-api-v2" }));

// 4) Import routes AFTER schemas are loaded (ESM-safe)
const { default: v2Router } = await import("./routes/v2/index.js");
app.use("/v2", v2Router);

// 5) Start
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => logger.info({ port: PORT }, "server started"));
