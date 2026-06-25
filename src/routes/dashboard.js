const express = require('express');
const pool = require('../db/postgres');
const router = express.Router();

router.get('/summary', async (req, res) => {
  try {
    const { date, platform } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    let platformFilter = '';
    const params = [targetDate];
    if (platform && platform !== 'all') {
      platformFilter = ` AND platform = $2`;
      params.push(platform);
    }

    const hoje = await pool.query(
      `SELECT COUNT(*) as total,
              COALESCE(SUM(total_price), 0) as faturamento,
              COALESCE(AVG(total_price), 0) as ticket_medio
       FROM orders
       WHERE DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = $1${platformFilter}`,
      params
    );

    const ontemParams = [targetDate];
    if (platform && platform !== 'all') ontemParams.push(platform);
    const ontem = await pool.query(
      `SELECT COUNT(*) as total,
              COALESCE(SUM(total_price), 0) as faturamento
       FROM orders
       WHERE DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = ($1::date - INTERVAL '1 day')::date${platformFilter}`,
      ontemParams
    );

    const pendentes = await pool.query(
      `SELECT COUNT(*) as total FROM orders WHERE status = '100'${platformFilter}`,
      platform && platform !== 'all' ? [platform] : []
    );

    const canceladosParams = [targetDate];
    if (platform && platform !== 'all') canceladosParams.push(platform);
    const cancelados = await pool.query(
      `SELECT COUNT(*) as total FROM orders
       WHERE status = 'cancelled' AND DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = $1${platformFilter}`,
      canceladosParams
    );

    const canceladosOntemParams = [targetDate];
    if (platform && platform !== 'all') canceladosOntemParams.push(platform);
    const canceladosOntem = await pool.query(
      `SELECT COUNT(*) as total FROM orders
       WHERE status = 'cancelled'
         AND DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = ($1::date - INTERVAL '1 day')::date${platformFilter}`,
      canceladosOntemParams
    );

    const porPlataforma = await pool.query(
      `SELECT platform, COUNT(*) as total
       FROM orders
       WHERE DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = $1
       GROUP BY platform`,
      [targetDate]
    );

    const ultimos7dias = await pool.query(
      `SELECT DATE(created_at AT TIME ZONE 'America/Sao_Paulo') as dia,
              COALESCE(SUM(total_price), 0) as faturamento,
              COUNT(*) as pedidos
       FROM orders
       WHERE DATE(created_at AT TIME ZONE 'America/Sao_Paulo') >= ($1::date - INTERVAL '6 days')::date
         AND DATE(created_at AT TIME ZONE 'America/Sao_Paulo') <= $1::date${platformFilter}
       GROUP BY DATE(created_at AT TIME ZONE 'America/Sao_Paulo')
       ORDER BY dia ASC`,
      params
    );

    const hojeTotal = parseInt(hoje.rows[0].total);
    const ontemTotal = parseInt(ontem.rows[0].total);
    const hojeFat = parseFloat(hoje.rows[0].faturamento);
    const ontemFat = parseFloat(ontem.rows[0].faturamento);

    const varPedidos = ontemTotal > 0 ? Math.round(((hojeTotal - ontemTotal) / ontemTotal) * 100) : 0;
    const varFaturamento = ontemFat > 0 ? Math.round(((hojeFat - ontemFat) / ontemFat) * 100) : 0;
    const varCancelados = parseInt(canceladosOntem.rows[0].total) > 0
      ? Math.round(((parseInt(cancelados.rows[0].total) - parseInt(canceladosOntem.rows[0].total)) / parseInt(canceladosOntem.rows[0].total)) * 100)
      : 0;

    return res.json({
      date: targetDate,
      pedidos_hoje: hojeTotal,
      var_pedidos: varPedidos,
      pendentes: parseInt(pendentes.rows[0].total),
      cancelados: parseInt(cancelados.rows[0].total),
      var_cancelados: varCancelados,
      ticket_medio: parseFloat(parseFloat(hoje.rows[0].ticket_medio).toFixed(2)),
      faturamento: parseFloat(hojeFat.toFixed(2)),
      var_faturamento: varFaturamento,
      por_plataforma: porPlataforma.rows.map(r => ({
        platform: r.platform,
        total: parseInt(r.total)
      })),
      ultimos_7_dias: ultimos7dias.rows.map(r => ({
        dia: r.dia,
        faturamento: parseFloat(r.faturamento),
        pedidos: parseInt(r.pedidos)
      }))
    });
  } catch (err) {
    console.error('[dashboard] erro:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar métricas' });
  }
});

module.exports = router;
