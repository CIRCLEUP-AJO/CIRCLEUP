import * as fs from "fs";
import * as path from "path";
import { pool } from "./pool";

export async function runMigrations() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log("[migrate] Schema applied successfully");
  } finally {
    client.release();
  }
}

// Run directly
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate] Error:", err);
      process.exit(1);
    });
}
