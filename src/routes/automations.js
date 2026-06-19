const express = require('express');
const pool = require('../db/postgres');
const router = express.Router();

// GET /api/v1/automations — lista todas as regras
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM automation_rules ORDER BY created_at ASC');
    return res.json(result.rows);
  } catch (err) {
    console.error('[automations] erro:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar automações' });
  }
});

// PUT /api/v1/automations/:id — atualizar regra (ativar/desativar, mudar delay)
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { enabled, delay_seconds } = req.body;
  try {
    const fields = [];
    const values = [];
    let idx = 1;
    if (typeof enabled === 'boolean') { fields.push(`enabled = $${idx++}`); values.push(enabled); }
    if (typeof delay_seconds === 'number') { fields.push(`delay_seconds = $${idx++}`); values.push(delay_seconds); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
    fields.push(`updated_at = now()`);
    values.push(id);
    const result = await pool.query(
      `UPDATE automation_rules SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Regra não encontrada' });
    console.log(`[automations] regra ${id} atualizada: enabled=${enabled}, delay=${delay_seconds}`);
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[automations] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
