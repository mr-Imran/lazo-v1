import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads <project root>/.env into process.env using Node's built-in loader.
 *
 * This lives in its own module, and must stay the first import of main.ts:
 * ESM evaluates imported modules before the importing module's body, and
 * AppModule reads process.env while it is being evaluated. Loading the file
 * from main.ts itself would therefore happen too late.
 */
const envPath = join(import.meta.dirname, '..', '.env');

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
