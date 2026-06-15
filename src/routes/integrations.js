const express = require('express');
const pool = require('../db/postgres');

const router = express.Router();

const PLATAFORMAS_VALIDAS = ['ifood', '99food', 'keeta'];

/**
 * GET /api/v1/integrations
 * Retorna o status das 3 integrações (iFood, 99Food, Keeta)
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, platform, name, description, status, orders_count,
              last_sync_at, api_status, created_at, updated_at
       FROM integrations
       ORDER BY
         CASE platform
           WHEN 'ifood' THEN 1
           WHEN 'keeta' THEN 2
           WHEN '99food' THEN 3
         END`
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('[GET /integrations] erro:', err);
    return res.status(500).json({ error: 'Erro ao buscar integrações' });
  }
});

/**
 * POST /api/v1/integrations/:platform/connect
 * Marca a integração como conectada
 */
router.post('/:platform/connect', async (req, res) => {
  const { platform } = req.params;

  if (!PLATAFORMAS_VALIDAS.includes(platform)) {
    return res.status(400).json({ error: 'Plataforma inválida' });
  }

  try {
    const result = await pool.query(
      `UPDATE integrations
       SET status = 'connected',
           api_status = 'online',
           last_sync_at = now(),
           updated_at = now()
       WHERE platform = $1
       RETURNING id, platform, name, description, status, orders_count,
                 last_sync_at, api_status, created_at, updated_at`,
      [platform]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Integração não encontrada' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[POST /integrations/:platform/connect] erro:', err);
    return res.status(500).json({ error: 'Erro ao conectar integração' });
  }
});

/**
 * POST /api/v1/integrations/:platform/disconnect
 * Marca a integração como desconectada
 */
router.post('/:platform/disconnect', async (req, res) => {
  const { platform } = req.params;

  if (!PLATAFORMAS_VALIDAS.includes(platform)) {
    return res.status(400).json({ error: 'Plataforma inválida' });
  }

  try {
    const result = await pool.query(
      `UPDATE integrations
       SET status = 'disconnected',
           api_status = 'offline',
           updated_at = now()
       WHERE platform = $1
       RETURNING id, platform, name, description, status, orders_count,
                 last_sync_at, api_status, created_at, updated_at`,
      [platform]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Integração não encontrada' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[POST /integrations/:platform/disconnect] erro:', err);
    return res.status(500).json({ error: 'Erro ao desconectar integração' });
  }
});

module.exports = router;
