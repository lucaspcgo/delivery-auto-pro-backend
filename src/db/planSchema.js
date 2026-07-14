const pool = require('./postgres');

let ready = null;
// Migração idempotente: garante capabilities/limites em plans.
function ensurePlanSchema() {
  if (!ready) {
    ready = (async () => {
      await pool.query(
        `ALTER TABLE plans ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}'::jsonb`
      );
      await pool.query(
        `ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_restaurants INTEGER NOT NULL DEFAULT 0`
      );
      await pool.query(
        `ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_orders_month INTEGER NOT NULL DEFAULT 0`
      );
      // Garante que o plano free (padrão de trial/downgrade) exista.
      await pool.query(
        `INSERT INTO plans (slug, name, price, billing_period, is_free, active, capabilities, max_restaurants, max_orders_month)
         VALUES ('free', 'Free', 0, 'monthly', true, true, '{}'::jsonb, 1, 100)
         ON CONFLICT (slug) DO NOTHING`
      );
    })().catch(err => { ready = null; throw err; });
  }
  return ready;
}
module.exports = { ensurePlanSchema };
