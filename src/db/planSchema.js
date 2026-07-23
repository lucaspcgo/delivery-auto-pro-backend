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
      // A trava antiga de billing_period recusava períodos válidos (semanal,
      // único, gratuito) e quebrava o "salvar plano". Recria aceitando os 5
      // valores canônicos que o painel usa.
      await pool.query(`ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_billing_period_check`);
      await pool.query(
        `ALTER TABLE plans ADD CONSTRAINT plans_billing_period_check
           CHECK (billing_period IN ('weekly','monthly','yearly','one_time','free'))`
      );
      // A trava antiga de role só aceitava 'user'/'admin' e recusava o novo
      // perfil 'gerente' (erro 500 ao salvar). Recria aceitando os 3 perfis.
      // Isolado num try: se houver algum valor legado fora da lista, apenas
      // registra e segue (não derruba o resto da migração).
      try {
        await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
        await pool.query(
          `ALTER TABLE users ADD CONSTRAINT users_role_check
             CHECK (role IN ('user','gerente','admin'))`
        );
      } catch (e) {
        console.error('[planSchema] não foi possível atualizar users_role_check:', e.message);
      }
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
