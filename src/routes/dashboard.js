const express = require('express');
const pool = require('../db/postgres');
const router = express.Router();

// GET /api/v1/dashboard/summary
router.get('/summary', async (req, res) => {
  try {
    // Pedidos hoje
    const hoje = await pool.query(
      `SELECT COUNT(*) as total,
              COALESCE(SUM(total_price), 0) as faturamento,
              COALESCE(AVG(total_price), 0) as ticket_medio
       FROM orders
       WHERE created_at >= CURRENT_DATE`
    );

    // Pedidos ontem (para comparação)
    const ontem = await pool.query(
      `SELECT COUNT(*) as total,
              COALESCE(SUM(total_price), 0) as faturamento
       FROM orders
       WHERE created_at >= CURRENT_DATE - INTERVAL '1 day'
         AND created_at < CURRENT_DATE`
    );

    // Pendentes (status 100)
    const pendentes = await pool.query(
      `SELECT COUNT(*) as total FROM orders WHERE status = '100'`
    );

    // Cancelados hoje
    const cancelados = await pool.query(
      `SELECT COUNT(*) as total FROM orders
       WHERE status = 'cancelled' AND created_at >= CURRENT_DATE`
    );

    // Cancelados ontem
    const canceladosOntem = await pool.query(
      `SELECT COUNT(*) as total FROM orders
       WHERE status = 'cancelled'
         AND created_at >= CURRENT_DATE - INTERVAL '1 day'
         AND created_at < CURRENT_DATE`
    );

    // Pedidos por plataforma hoje
    const porPlataforma = await pool.query(
      `SELECT platform, COUNT(*) as total
       FROM orders
       WHERE created_at >= CURRENT_DATE
       GROUP BY platform`
    );

    // Faturamento últimos 7 dias
    const ultimos7dias = await pool.query(
      `SELECT DATE(created_at) as dia,
              COALESCE(SUM(total_price), 0) as faturamento,
              COUNT(*) as pedidos
       FROM orders
       WHERE created_at >= CURRENT_DATE - INTERVAL '6 days'
       GROUP BY DATE(created_at)
       ORDER BY dia ASC`
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
