const express = require('express');
const pool = require('../db/postgres');
const router = express.Router();

// GET /api/v1/reports/summary — relatório geral
router.get('/summary', async (req, res) => {
  try {
    const { start_date, end_date, platform, restaurant_id } = req.query;
    const startDate = start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = end_date || new Date().toISOString().split('T')[0];

    let platformFilter = '';
    let restaurantFilter = '';
    const params = [startDate, endDate];
    let idx = 3;
    if (platform && platform !== 'all') { platformFilter = ` AND o.platform = $${idx++}`; params.push(platform); }
    if (restaurant_id) { restaurantFilter = ` AND o.app_shop_id IN (SELECT COALESCE(platform_merchant_id, app_shop_id) FROM restaurant_platforms WHERE restaurant_id = $${idx++})`; params.push(restaurant_id); }

    const dateFilter = `DATE(o.created_at AT TIME ZONE 'America/Sao_Paulo') >= $1 AND DATE(o.created_at AT TIME ZONE 'America/Sao_Paulo') <= $2`;

    // Métricas gerais
    const geral = await pool.query(
      `SELECT COUNT(*) as total_pedidos, COALESCE(SUM(total_price),0) as faturamento_total,
              COALESCE(AVG(total_price),0) as ticket_medio,
              COUNT(CASE WHEN status='confirmed' OR status='ready' THEN 1 END) as aceitos,
              COUNT(CASE WHEN status='cancelled' THEN 1 END) as cancelados,
              COUNT(CASE WHEN status='100' THEN 1 END) as pendentes
       FROM orders o WHERE ${dateFilter}${platformFilter}${restaurantFilter}`, params
    );

    // Por plataforma
    const porPlataforma = await pool.query(
      `SELECT platform, COUNT(*) as pedidos, COALESCE(SUM(total_price),0) as faturamento,
              COALESCE(AVG(total_price),0) as ticket_medio
       FROM orders o WHERE ${dateFilter}${platformFilter}${restaurantFilter}
       GROUP BY platform ORDER BY pedidos DESC`, params
    );

    // Por dia
    const porDia = await pool.query(
      `SELECT DATE(o.created_at AT TIME ZONE 'America/Sao_Paulo') as dia,
              COUNT(*) as pedidos, COALESCE(SUM(total_price),0) as faturamento
       FROM orders o WHERE ${dateFilter}${platformFilter}${restaurantFilter}
       GROUP BY DATE(o.created_at AT TIME ZONE 'America/Sao_Paulo') ORDER BY dia ASC`, params
    );

    // Por status
    const porStatus = await pool.query(
      `SELECT status, COUNT(*) as total FROM orders o
       WHERE ${dateFilter}${platformFilter}${restaurantFilter}
       GROUP BY status ORDER BY total DESC`, params
    );

    // Top itens mais pedidos
    const topItens = await pool.query(
      `SELECT item->>'name' as nome, SUM((item->>'amount')::int) as quantidade,
              SUM((item->>'total_price')::numeric / 100) as valor_total
       FROM orders o, jsonb_array_elements(items) as item
       WHERE ${dateFilter}${platformFilter}${restaurantFilter}
       GROUP BY item->>'name' ORDER BY quantidade DESC LIMIT 10`, params
    );

    // Por hora do dia
    const porHora = await pool.query(
      `SELECT EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'America/Sao_Paulo') as hora,
              COUNT(*) as pedidos, COALESCE(SUM(total_price),0) as faturamento
       FROM orders o WHERE ${dateFilter}${platformFilter}${restaurantFilter}
       GROUP BY hora ORDER BY hora ASC`, params
    );

    // Por restaurante
    const porRestaurante = await pool.query(
      `SELECT r.name as restaurante, o.app_shop_id, o.platform,
              COUNT(*) as pedidos, COALESCE(SUM(o.total_price),0) as faturamento
       FROM orders o
       LEFT JOIN restaurant_platforms rp ON (rp.platform_merchant_id = o.app_shop_id OR rp.app_shop_id = o.app_shop_id) AND rp.platform = o.platform
       LEFT JOIN restaurants r ON r.id = rp.restaurant_id
       WHERE ${dateFilter}${platformFilter}${restaurantFilter}
       GROUP BY r.name, o.app_shop_id, o.platform ORDER BY pedidos DESC`, params
    );

    const g = geral.rows[0];
    const taxaAceite = parseInt(g.total_pedidos) > 0
      ? Math.round((parseInt(g.aceitos) / parseInt(g.total_pedidos)) * 100) : 0;
    const taxaCancelamento = parseInt(g.total_pedidos) > 0
      ? Math.round((parseInt(g.cancelados) / parseInt(g.total_pedidos)) * 100) : 0;

    return res.json({
      periodo: { inicio: startDate, fim: endDate },
      resumo: {
        total_pedidos: parseInt(g.total_pedidos),
        faturamento_total: parseFloat(parseFloat(g.faturamento_total).toFixed(2)),
        ticket_medio: parseFloat(parseFloat(g.ticket_medio).toFixed(2)),
        aceitos: parseInt(g.aceitos),
        cancelados: parseInt(g.cancelados),
        pendentes: parseInt(g.pendentes),
        taxa_aceite: taxaAceite,
        taxa_cancelamento: taxaCancelamento
      },
      por_plataforma: porPlataforma.rows.map(r => ({
        platform: r.platform,
        pedidos: parseInt(r.pedidos),
        faturamento: parseFloat(parseFloat(r.faturamento).toFixed(2)),
        ticket_medio: parseFloat(parseFloat(r.ticket_medio).toFixed(2))
      })),
      por_dia: porDia.rows.map(r => ({
        dia: r.dia,
        pedidos: parseInt(r.pedidos),
        faturamento: parseFloat(r.faturamento)
      })),
      por_status: porStatus.rows.map(r => ({
        status: r.status,
        total: parseInt(r.total)
      })),
      top_itens: topItens.rows.map(r => ({
        nome: r.nome,
        quantidade: parseInt(r.quantidade),
        valor_total: parseFloat(parseFloat(r.valor_total).toFixed(2))
      })),
      por_hora: porHora.rows.map(r => ({
        hora: parseInt(r.hora),
        pedidos: parseInt(r.pedidos),
        faturamento: parseFloat(r.faturamento)
      })),
      por_restaurante: porRestaurante.rows.map(r => ({
        restaurante: r.restaurante || r.app_shop_id || 'Não identificado',
        platform: r.platform,
        pedidos: parseInt(r.pedidos),
        faturamento: parseFloat(parseFloat(r.faturamento).toFixed(2))
      }))
    });
  } catch (err) {
    console.error('[reports] erro:', err.message);
    return res.status(500).json({ error: 'Erro ao gerar relatório' });
  }
});

module.exports = router;
