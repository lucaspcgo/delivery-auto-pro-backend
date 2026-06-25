const express = require('express');
const pool = require('../db/postgres');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

// Aplicar autenticação em todas as rotas
router.use(authenticateToken);

router.get('/summary', async (req, res) => {
  try {
    const { date, platform } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];
    const hasPlatform = platform && platform !== 'all';
    const userId = req.user.id;

    // Helper para montar queries com filtros opcionais
    function buildQuery(baseQuery, useDate, usePlatform) {
      const params = [userId]; // Sempre adicionar user_id primeiro
      const conditions = ['user_id = $1'];
      let idx = 2;
      if (useDate) { conditions.push(`DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = $${idx++}`); params.push(targetDate); }
      if (usePlatform && hasPlatform) { conditions.push(`platform = $${idx++}`); params.push(platform); }
      const where = conditions.join(' AND ');
      return { query: baseQuery.replace('__WHERE__', where), params };
    }

    // Pedidos do dia selecionado
    const q1 = buildQuery(`SELECT COUNT(*) as total, COALESCE(SUM(total_price),0) as faturamento, COALESCE(AVG(total_price),0) as ticket_medio FROM orders WHERE __WHERE__`, true, true);
    const hoje = await pool.query(q1.query, q1.params);

    // Pedidos do dia anterior
    const ontemParams = [userId];
    let ontemIdx = 2;
    let ontemWhere = `user_id = $1 AND DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = ($${ontemIdx++}::date - INTERVAL '1 day')::date`;
    ontemParams.push(targetDate);
    if (hasPlatform) { ontemWhere += ` AND platform = $${ontemIdx++}`; ontemParams.push(platform); }
    const ontem = await pool.query(`SELECT COUNT(*) as total, COALESCE(SUM(total_price),0) as faturamento FROM orders WHERE ${ontemWhere}`, ontemParams);

    // Pendentes
    const pendParams = [userId];
    let pendIdx = 2;
    let pendWhere = `user_id = $1 AND status = '100'`;
    if (hasPlatform) { pendWhere += ` AND platform = $${pendIdx++}`; pendParams.push(platform); }
    const pendentes = await pool.query(`SELECT COUNT(*) as total FROM orders WHERE ${pendWhere}`, pendParams);

    // Cancelados do dia
    const q4 = buildQuery(`SELECT COUNT(*) as total FROM orders WHERE status = 'cancelled' AND __WHERE__`, true, true);
    const cancelados = await pool.query(q4.query, q4.params);

    // Cancelados do dia anterior
    const cancOntemParams = [userId];
    let cancOntemIdx = 2;
    let cancOntemWhere = `user_id = $1 AND status = 'cancelled' AND DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = ($${cancOntemIdx++}::date - INTERVAL '1 day')::date`;
    cancOntemParams.push(targetDate);
    if (hasPlatform) { cancOntemWhere += ` AND platform = $${cancOntemIdx++}`; cancOntemParams.push(platform); }
    const canceladosOntem = await pool.query(`SELECT COUNT(*) as total FROM orders WHERE ${cancOntemWhere}`, cancOntemParams);

    // Por plataforma no dia
    const porPlataforma = await pool.query(
      `SELECT platform, COUNT(*) as total FROM orders WHERE user_id = $1 AND DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = $2 GROUP BY platform`,
      [userId, targetDate]
    );

    // Últimos 7 dias
    const u7Params = [userId, targetDate];
    let u7Idx = 3;
    let u7Extra = '';
    if (hasPlatform) { u7Extra = ` AND platform = $${u7Idx++}`; u7Params.push(platform); }
    const ultimos7dias = await pool.query(
      `SELECT DATE(created_at AT TIME ZONE 'America/Sao_Paulo') as dia, COALESCE(SUM(total_price),0) as faturamento, COUNT(*) as pedidos
       FROM orders WHERE user_id = $1 AND DATE(created_at AT TIME ZONE 'America/Sao_Paulo') >= ($2::date - INTERVAL '6 days')::date AND DATE(created_at AT TIME ZONE 'America/Sao_Paulo') <= $2::date${u7Extra}
       GROUP BY DATE(created_at AT TIME ZONE 'America/Sao_Paulo') ORDER BY dia ASC`,
      u7Params
    );

    const hojeTotal = parseInt(hoje.rows[0].total);
    const ontemTotal = parseInt(ontem.rows[0].total);
    const hojeFat = parseFloat(hoje.rows[0].faturamento);
    const ontemFat = parseFloat(ontem.rows[0].faturamento);

    return res.json({
      date: targetDate,
      pedidos_hoje: hojeTotal,
      var_pedidos: ontemTotal > 0 ? Math.round(((hojeTotal - ontemTotal) / ontemTotal) * 100) : 0,
      pendentes: parseInt(pendentes.rows[0].total),
      cancelados: parseInt(cancelados.rows[0].total),
      var_cancelados: parseInt(canceladosOntem.rows[0].total) > 0
        ? Math.round(((parseInt(cancelados.rows[0].total) - parseInt(canceladosOntem.rows[0].total)) / parseInt(canceladosOntem.rows[0].total)) * 100) : 0,
      ticket_medio: parseFloat(parseFloat(hoje.rows[0].ticket_medio).toFixed(2)),
      faturamento: parseFloat(hojeFat.toFixed(2)),
      var_faturamento: ontemFat > 0 ? Math.round(((hojeFat - ontemFat) / ontemFat) * 100) : 0,
      por_plataforma: porPlataforma.rows.map(r => ({ platform: r.platform, total: parseInt(r.total) })),
      ultimos_7_dias: ultimos7dias.rows.map(r => ({ dia: r.dia, faturamento: parseFloat(r.faturamento), pedidos: parseInt(r.pedidos) }))
    });
  } catch (err) {
    console.error('[dashboard] erro:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar métricas' });
  }
});

module.exports = router;