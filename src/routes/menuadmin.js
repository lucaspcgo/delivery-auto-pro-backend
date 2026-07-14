const express = require('express');
const pool = require('../db/postgres');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { requireCapability, requireActiveUser } = require('../middleware/planGuard');
const ifoodAPI = require('../services/ifood-api-complete');
const ifoodDistributed = require('../services/ifood-distributed');
const food99 = require('../services/food99');
const menu99food = require('../services/menu99food');
const router = express.Router();

// Cache do cardápio CRU por restaurante (preenchido no "Buscar cardápio").
// Usado no "Copiar" para montar o envio sem re-buscar (evita o rate-limit do 99Food).
const rawMenuCache = new Map(); // `${restaurant_id}:99food` -> { raw, at }

// GET /api/v1/admin/menu/restaurants
router.get('/restaurants', authenticateToken, requireActiveUser, requireAdmin, async (req, res) => {
  try {
    const restaurants = await pool.query(
      `SELECT r.id, r.name, r.user_id,
              json_agg(json_build_object('platform', rp.platform, 'platform_id', rp.platform_store_id, 'status', rp.status)) as integrations
       FROM restaurants r
       LEFT JOIN restaurant_platforms rp ON r.id = rp.restaurant_id
       WHERE r.user_id = $1 AND r.active = true
       GROUP BY r.id, r.name, r.user_id
       ORDER BY r.name`,
      [req.user.id]
    );
    res.json(restaurants.rows || []);
  } catch (err) {
    console.error('[menu restaurants] erro:', err.message);
    res.status(500).json({ error: 'Erro ao buscar restaurantes', details: err.message });
  }
});

// POST /api/v1/admin/menu/fetch — Buscar cardápio via API real
router.post('/fetch', authenticateToken, requireActiveUser, requireCapability('menu_sync'), async (req, res) => {
  try {
    const { restaurant_id, platform } = req.body;

    if (!restaurant_id || !platform) {
      return res.status(400).json({ error: 'restaurant_id e platform são obrigatórios' });
    }

    const ownsRestaurant = await pool.query(
      `SELECT 1 FROM restaurants WHERE id = $1 AND user_id = $2`,
      [restaurant_id, req.user.id]
    );
    if (ownsRestaurant.rows.length === 0) {
      return res.status(403).json({ error: 'forbidden' });
    }

    console.log(`[menu fetch] Buscando cardápio: restaurante=${restaurant_id}, plataforma=${platform}`);

    // Buscar dados de acesso da plataforma
    const platData = await pool.query(
      `SELECT rp.platform_store_id, rp.platform_merchant_id, rp.app_shop_id
       FROM restaurant_platforms rp
       WHERE rp.restaurant_id = $1 AND rp.platform = $2`,
      [restaurant_id, platform]
    );

    if (platData.rows.length === 0) {
      console.log('[menu fetch] Plataforma não configurada');
      return res.json({ platform, items: [], items_count: 0, message: 'Nenhuma integração configurada' });
    }

    const { platform_merchant_id, platform_store_id, app_shop_id } = platData.rows[0];
    let items = [];

    // Buscar via API REAL do iFood (usando o token da loja autorizada — modelo distribuído)
    if (platform === 'ifood') {
      try {
        const token = await ifoodDistributed.getAccessToken(req.user.id);
        const merchantId = platform_merchant_id || platform_store_id;
        console.log(`[menu fetch] usando merchantId=${merchantId}`);
        items = await ifoodAPI.getMenuItems(merchantId, token);
        console.log(`[menu fetch] ${items.length} items obtidos do iFood via API`);
      } catch (err) {
        console.error('[menu fetch] erro ao buscar do iFood:', err.message);
        return res.status(500).json({ error: 'Erro ao buscar cardápio do iFood', details: err.message });
      }
    } else if (platform === '99food') {
      const shopId = app_shop_id || platform_store_id;
      if (!shopId) {
        return res.json({ platform, items: [], items_count: 0, message: 'Loja 99Food sem app_shop_id configurado' });
      }
      try {
        const authToken = await food99.getValidToken(shopId);
        const raw = await menu99food.fetchRawMenu(authToken);
        rawMenuCache.set(`${restaurant_id}:99food`, { raw, at: Date.now() });
        items = menu99food.simplifyItems(raw, shopId);
        console.log(`[menu fetch] ${items.length} items obtidos do 99Food via API`);
      } catch (err) {
        console.error('[menu fetch] erro ao buscar do 99Food:', err.message);
        // O 99Food limita a busca do cardápio (2x a cada 120s). Se recusar, devolve o
        // último cardápio salvo no banco em vez de dar erro na tela.
        const cached = await pool.query(
          `SELECT items_data FROM menu_items WHERE restaurant_id = $1 AND platform = $2`,
          [restaurant_id, platform]
        );
        const raw = cached.rows[0]?.items_data;
        if (raw) {
          const cachedItems = typeof raw === 'string' ? JSON.parse(raw) : raw;
          console.log(`[menu fetch] usando cardápio salvo (${cachedItems.length} itens) — motivo: ${err.message}`);
          return res.json({
            platform, items: cachedItems, items_count: cachedItems.length, cached: true,
            message: 'Cardápio do último carregamento (99Food limita atualização; tente de novo em ~1 min).'
          });
        }
        return res.status(500).json({ error: 'Erro ao buscar cardápio do 99Food', details: err.message });
      }
    }

    // Junta itens com o MESMO código (id) numa linha só — evita mostrar duplicados
    // e o problema de "marquei 1 e selecionou 2" na tela.
    if (items.length > 0) {
      const vistos = new Set();
      const antes = items.length;
      items = items.filter(it => {
        const k = String(it.id ?? it.productId ?? '');
        if (!k) return true;
        if (vistos.has(k)) return false;
        vistos.add(k);
        return true;
      });
      if (items.length !== antes) {
        console.log(`[menu fetch] ${antes - items.length} item(ns) com código repetido ocultado(s) (mostrando ${items.length})`);
      }
    }

    // Salvar items no banco
    if (items.length > 0) {
      const itemsJson = JSON.stringify(items);
      await pool.query(
        `INSERT INTO menu_items (restaurant_id, platform, platform_store_id, items_data, updated_at, created_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (restaurant_id, platform) DO UPDATE SET
           items_data = EXCLUDED.items_data,
           updated_at = NOW()`,
        [restaurant_id, platform, platform_merchant_id || platform_store_id || app_shop_id, itemsJson]
      );
    }

    console.log(`[menu fetch] Retornando ${items.length} itens`);
    res.json({ platform, items, items_count: items.length });
  } catch (err) {
    console.error('[menu fetch] erro:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao buscar cardápio', details: err.message });
  }
});

// POST /api/v1/admin/menu/copy
router.post('/copy', authenticateToken, requireActiveUser, requireCapability('menu_sync'), async (req, res) => {
  try {
    const { from_restaurant_id, to_restaurant_id, from_platform, to_platform, selected_items } = req.body;

    if (!from_restaurant_id || !to_restaurant_id) {
      return res.status(400).json({ error: 'Restaurantes de origem e destino são obrigatórios' });
    }

    const ownership = await pool.query(
      `SELECT id FROM restaurants WHERE id = ANY($1::int[]) AND user_id = $2`,
      [[from_restaurant_id, to_restaurant_id], req.user.id]
    );
    if (ownership.rows.length < 2) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const itemsCount = selected_items?.length || 0;
    console.log(`[menu copy] Copiando ${itemsCount} itens (${from_platform} -> ${to_platform})`);

    // ── Copiar para o 99Food — modo ITEM POR ITEM ("Update One Item") ──
    //    Mexe só nos itens escolhidos; NUNCA sobrescreve nem apaga o resto da loja.
    let copyReport = null;
    if (to_platform === '99food') {
      // 1) Precisa do cardápio cru da origem (carregado no "Buscar cardápio")
      const cached = rawMenuCache.get(`${from_restaurant_id}:99food`);
      if (!cached) {
        return res.status(400).json({ error: 'Clique em "Buscar cardápio" na loja de origem antes de copiar.' });
      }

      // 2) Loja de destino no 99Food
      const destPlat = await pool.query(
        `SELECT app_shop_id, platform_store_id FROM restaurant_platforms
         WHERE restaurant_id = $1 AND platform = '99food'`,
        [to_restaurant_id]
      );
      const destShop = destPlat.rows[0]?.app_shop_id || destPlat.rows[0]?.platform_store_id;
      if (!destShop) {
        return res.status(400).json({ error: 'A loja de destino não tem 99Food configurado.' });
      }

      // 3) Quais itens copiar (front manda cada item como texto ou objeto)
      const selectedIds = (selected_items || [])
        .map(i => (typeof i === 'string' || typeof i === 'number')
          ? String(i)
          : String(i?.id ?? i?.app_item_id ?? i?.productId ?? ''))
        .filter(Boolean);
      console.log('[menu copy] selectedIds:', selectedIds.join(', ') || '(todos)');

      // Filtra pelos selecionados e remove códigos repetidos (evita copiar o mesmo id 2x)
      const seenIds = new Set();
      const srcItems = (Array.isArray(cached.raw.items) ? cached.raw.items : [])
        .filter(it => it.app_item_id && (!selectedIds.length || selectedIds.includes(String(it.app_item_id))))
        .filter(it => { const k = String(it.app_item_id); if (seenIds.has(k)) return false; seenIds.add(k); return true; });
      if (!srcItems.length) {
        return res.status(400).json({ error: 'Nenhum item selecionado encontrado no cardápio de origem.' });
      }

      // 4) Copia UM item de cada vez — nunca toca nos outros itens da loja de destino
      const destToken = await food99.getValidToken(destShop);
      const ok = [], fail = [];
      for (const it of srcItems) {
        try {
          await menu99food.updateOneItem(destToken, it);
          ok.push(it.app_item_id);
          console.log(`[menu copy] item ${it.app_item_id} copiado para loja ${destShop}`);
        } catch (err) {
          fail.push({ id: it.app_item_id, error: err.message });
          console.error(`[menu copy] falha ao copiar item ${it.app_item_id}: ${err.message}`);
        }
      }
      copyReport = { ok: ok.length, fail: fail.length, failures: fail };
      console.log(`[menu copy] loja ${destShop}: ${ok.length} copiado(s), ${fail.length} falha(s)`);

      // Se NENHUM item foi copiado, devolve o erro (não registra sucesso falso)
      if (ok.length === 0) {
        return res.status(502).json({
          error: 'Nenhum item foi copiado. O 99Food recusou a atualização.',
          details: fail[0]?.error, failures: fail
        });
      }
    }

    // Registrar a cópia no banco (histórico)
    const result = await pool.query(
      `INSERT INTO menu_copies (from_restaurant_id, to_restaurant_id, from_platform, to_platform, items_copied, copied_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id`,
      [from_restaurant_id, to_restaurant_id, from_platform || '', to_platform || '', JSON.stringify(selected_items || [])]
    );

    console.log(`[menu copy] Cópia registrada com ID: ${result.rows[0]?.id}`);

    res.json({
      success: true,
      message: to_platform === '99food' && copyReport
        ? `Pronto! ${copyReport.ok} item(ns) copiado(s) para a loja de destino` +
          (copyReport.fail ? `, ${copyReport.fail} falharam.` : ', sem apagar nada do que já existia.') +
          ' Confira no painel da loja (pode levar 1–2 min para atualizar).'
        : `${itemsCount} itens registrados.`,
      copied_items: to_platform === '99food' && copyReport ? copyReport.ok : itemsCount,
      report: copyReport,
      copy_id: result.rows[0]?.id
    });
  } catch (err) {
    console.error('[menu copy] erro:', err.message);
    res.status(500).json({ error: 'Erro ao copiar cardápio', details: err.message });
  }
});

module.exports = router;
