const pool = require('../db/postgres');
const { attachItemImages } = require('../services/orderImages');
const { extractOrderExtras } = require('../services/orderExtras');

// Handler de DEPURAÇÃO: devolve, por pedido, os campos BRUTOS recebidos da
// plataforma (raw_payload) lado a lado com o MAPEAMENTO que o backend entrega
// ao KDS. Serve pra conferir se cada webhook está sendo mapeado corretamente.
//
// Escopo: só os pedidos do próprio usuário autenticado (isolamento por conta).
// Retorna dados do cliente — é o dono da conta vendo os próprios pedidos.
function makeDebugHandler(platform) {
  return async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 10, 50);
      const result = await pool.query(
        `SELECT id, platform, platform_order_id, app_shop_id, status, customer_name,
                customer_phone, delivery_address, items, total_price, raw_payload,
                created_at, updated_at
           FROM orders
          WHERE platform = $1 AND user_id = $2
          ORDER BY created_at DESC
          LIMIT $3`,
        [platform, req.user.id, limit]
      );

      // Anexa as fotos como no KDS real, pra conferir o casamento de imagem
      const withImages = await attachItemImages(result.rows, platform, req.user.id);

      const out = withImages.map((o) => {
        let raw = o.raw_payload;
        if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { /* deixa string */ } }
        const extras = extractOrderExtras(o.raw_payload, platform);
        return {
          // Identificação
          id: o.id,
          platform_order_id: o.platform_order_id,
          status: o.status,
          created_at: o.created_at,
          // O que o KDS recebe (campos já mapeados)
          mapped: {
            customer_name: o.customer_name,
            customer_phone: o.customer_phone,
            delivery_address: o.delivery_address,
            total_price: o.total_price,
            items: o.items,
            ...extras,
          },
          // Lista das chaves de topo do payload cru (visão rápida do que chegou)
          raw_keys: raw && typeof raw === 'object' ? Object.keys(raw) : [],
          // Payload BRUTO completo, exatamente como recebido da plataforma
          raw,
        };
      });

      return res.json({ platform, count: out.length, orders: out });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao carregar depuração de pedidos', details: err.message });
    }
  };
}

module.exports = { makeDebugHandler };
