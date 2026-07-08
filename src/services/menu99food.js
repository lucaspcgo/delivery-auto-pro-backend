const https = require('https');

// Puxa o cardápio de uma loja no 99Food (endpoint "Get Store Menu Details").
// Doc: GET https://openapi.99food.com/v3/item/item/list?auth_token=...
// Resposta: { errno, data: { menus, categories, items, modifier_groups } }
async function getMenuItems(appShopId, authToken) {
  const path = `/v3/item/item/list?auth_token=${encodeURIComponent(authToken)}`;
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'openapi.99food.com', path }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errno !== 0) {
            // NÃO engolir o erro: repassa o motivo real (token expirado, loja não vinculada, etc.)
            console.log(`[99food menu] loja ${appShopId}: ${parsed.errmsg} (errno ${parsed.errno})`);
            return reject(new Error(`99Food recusou a busca do cardápio: ${parsed.errmsg} (errno ${parsed.errno})`));
          }
          const d = parsed.data || {};
          const categories = Array.isArray(d.categories) ? d.categories : [];
          const rawItems = Array.isArray(d.items) ? d.items : [];

          // Mapa item -> categoria (a categoria lista os ids dos seus itens em app_item_id[])
          const itemCategory = {};
          for (const c of categories) {
            for (const iid of (c.app_item_id || [])) {
              itemCategory[iid] = c.category_name;
            }
          }

          let rawLogged = false;
          const items = rawItems.map((item) => {
            if (!rawLogged) {
              console.log('[99food menu] exemplo de item cru:', JSON.stringify(item).slice(0, 500));
              rawLogged = true;
            }
            const priceRaw = item.price ?? item.activies_price ?? 0;
            return {
              id: item.app_item_id,
              name: item.item_name,
              description: item.short_desc || '',
              price: Number(priceRaw) / 100, // 99Food envia preço em centavos
              category: itemCategory[item.app_item_id] || 'Sem categoria',
              image: item.head_img || null,
              available: item.status !== 0,
              sku: item.app_external_id || null,
              productId: item.app_item_id
            };
          });

          console.log(`[99food menu] loja ${appShopId}: ${items.length} item(ns)`);
          resolve(items);
        } catch (err) {
          console.error('[99food menu] erro ao parsear:', err.message, '| resposta:', data.slice(0, 300));
          reject(new Error('99Food retornou resposta inválida'));
        }
      });
    }).on('error', (err) => {
      console.error('[99food menu] erro de rede:', err.message);
      reject(new Error('Falha de rede ao buscar cardápio no 99Food: ' + err.message));
    });
  });
}

module.exports = { getMenuItems };
