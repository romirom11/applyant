import { defineConfig } from 'drizzle-kit';

// Only `drizzle-kit generate` (never `push`): later custom migrations add virtual tables
// and triggers that a live-database diff would try to drop.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
});
