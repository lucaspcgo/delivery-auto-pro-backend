const express = require('express');
const pool = require('../db/postgres');
const { tryAutoAccept, ensureAutomationSchema } = require('../services/autoAccept');
const { authenticateToken } = require('../middleware/auth');
const { requireCapability, requireActiveUser } = require('../middleware/planGuard');
const router = express.Router();

// Aplicar autenticação em todas as rotas
router.use(authenticateToken);
router.use(requireActiveUser);

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM automation_rules WHERE user_id = $1 ORDER BY created_at ASC',
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('[automations] erro:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar automações' });
  }
});

router.put('/:id', requireCapability('auto_accept'), async (req, res) => {
  const { id } = req.params;
  const { enabled, delay_seconds, accept_delay_seconds } = req.body;
  try {
    await ensureAutomationSchema();

    // Validar ownership
    const check = await pool.query(
      'SELECT * FROM automation_rules WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (check.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    // Aceita número OU texto ("30") — o front costuma mandar como string
    const asNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const asBool = (v) => (typeof v === 'boolean' ? v : (v === 'true' ? true : (v === 'false' ? false : null)));
    // Trava os atrasos em faixas seguras: nada de negativo (quebraria o timer)
    // nem valores absurdos. accept: até 15 min (trava de impressão); pronto: até 2h.
    const clamp = (v, max) => Math.min(Math.max(Math.round(asNum(v)), 0), max);

    const fields = [];
    const values = [];
    let idx = 1;
    const enabledVal = asBool(enabled);
    if (enabledVal !== null) { fields.push(`enabled = $${idx++}`); values.push(enabledVal); }
    if (delay_seconds != null && asNum(delay_seconds) != null) { fields.push(`delay_seconds = $${idx++}`); values.push(clamp(delay_seconds, 7200)); }
    if (accept_delay_seconds != null && asNum(accept_delay_seconds) != null) { fields.push(`accept_delay_seconds = $${idx++}`); values.push(clamp(accept_delay_seconds, 900)); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
    fields.push(`updated_at = now()`);
    values.push(id);
    values.push(req.user.id);
    const result = await pool.query(
      `UPDATE automation_rules SET ${fields.join(', ')} WHERE id = $${idx} AND user_id = $${idx + 1} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Regra não encontrada' });
    const rule = result.rows[0];
    console.log(`[automations] regra ${id} atualizada: enabled=${rule.enabled}, aceite=${rule.accept_delay_seconds}s, pronto=${rule.delay_seconds}s`);

    // Se acabou de ativar, aceitar todos os pedidos NOVOS pendentes
    if (enabledVal === true && rule.action === 'auto_accept') {
      const platforms = rule.platform === 'all'
        ? ['ifood', '99food', 'keeta']
        : [rule.platform];

      const pendentes = await pool.query(
        `SELECT platform, platform_order_id, app_shop_id
         FROM orders
         WHERE status = '100' AND platform = ANY($1) AND user_id = $2`,
        [platforms, req.user.id]
      );

      console.log(`[automations] encontrou ${pendentes.rows.length} pedidos pendentes para auto-aceite`);

      for (const pedido of pendentes.rows) {
        tryAutoAccept(pedido.platform, pedido.platform_order_id, pedido.app_shop_id, req.user.id);
      }
    }

    return res.json(rule);
  } catch (err) {
    console.error('[automations] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;