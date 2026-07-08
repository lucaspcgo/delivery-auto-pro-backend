const https = require('https');

const HOST = 'openapi.99food.com';

// ── Puxar o cardápio CRU de uma loja (endpoint "Get Store Menu Details") ──
// GET https://openapi.99food.com/v3/item/item/list?auth_token=...
// Resposta: { errno, data: { menus, categories, items, modifier_groups } }
// Retorna o objeto `data` cru (mantém preço em centavos e todos os campos).
function fetchRawMenu(authToken) {
  const path = `/v3/item/item/list?auth_token=${encodeURIComponent(authToken)}`;
  return new Promise((resolve, reject) => {
    https.get({ hostname: HOST, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errno !== 0) {
            // NÃO engolir o erro: repassa o motivo real (token expirado, rate-limit, etc.)
            console.log(`[99food menu] busca recusada: ${parsed.errmsg} (errno ${parsed.errno})`);
            return reject(new Error(`99Food recusou a busca do cardápio: ${parsed.errmsg} (errno ${parsed.errno})`));
          }
          resolve(parsed.data || {});
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

// ── Simplifica o cardápio cru para exibição no painel ──
function simplifyItems(rawData, appShopId) {
  const d = rawData || {};
  const categories = Array.isArray(d.categories) ? d.categories : [];
  const rawItems = Array.isArray(d.items) ? d.items : [];

  // Mapa item -> categoria (a categoria lista os ids dos seus itens em app_item_id[])
  const itemCategory = {};
  for (const c of categories) {
    for (const iid of (c.app_item_id || c.app_item_ids || [])) {
      itemCategory[iid] = c.category_name;
    }
  }

  const items = rawItems.map((item) => {
    const priceRaw = item.price ?? item.activity_price ?? item.activies_price ?? 0;
    return {
      id: item.app_item_id,
      name: item.item_name,
      description: item.short_desc || '',
      price: Number(priceRaw) / 100, // 99Food envia preço em centavos
      category: itemCategory[item.app_item_id] || 'Sem categoria',
      image: item.head_img || null,
      available: item.status !== 2,
      sku: item.app_external_id || null,
      productId: item.app_item_id
    };
  });

  console.log(`[99food menu] loja ${appShopId}: ${items.length} item(ns)`);
  return items;
}

// Compat: puxa e já simplifica (usado onde não precisamos do cru).
async function getMenuItems(appShopId, authToken) {
  const raw = await fetchRawMenu(authToken);
  return simplifyItems(raw, appShopId);
}

// ── Monta o corpo do "Upload Store Menu Details" a partir do cardápio cru ──
// selectedIds: array de app_item_id a copiar (null = todos).
// ATENÇÃO: o upload SOBRESCREVE o cardápio inteiro da loja de destino.
function buildUploadPayload(rawData, selectedIds) {
  const d = rawData || {};
  const rawItems = Array.isArray(d.items) ? d.items : [];
  const rawCats = Array.isArray(d.categories) ? d.categories : [];
  const rawMgs = Array.isArray(d.modifier_groups) ? d.modifier_groups : [];
  const idSet = selectedIds ? new Set(selectedIds.map(String)) : null;

  const slug = (s) => (String(s || 'cat').toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '').slice(0, 60) || 'cat');

  // 1) Itens selecionados, no formato do upload (preço já em centavos no cru)
  const items = rawItems
    .filter(it => it.app_item_id && (!idSet || idSet.has(String(it.app_item_id))))
    .map(it => {
      const o = {
        app_item_id: String(it.app_item_id),
        item_name: it.item_name || 'Item',
        short_desc: it.short_desc || '',
        price: Math.round(Number(it.price ?? it.activity_price ?? 0)),
        status: it.status === 2 ? 2 : 1,
        is_sold_separately: it.is_sold_separately !== false
      };
      if (it.head_img) o.head_img = it.head_img;
      if (Array.isArray(it.app_modifier_group_ids) && it.app_modifier_group_ids.length) {
        o.app_modifier_group_ids = it.app_modifier_group_ids;
      }
      return o;
    });

  const keepIds = new Set(items.map(i => i.app_item_id));

  // 2) Cada item precisa de uma categoria. Reaproveita as categorias do cru;
  //    itens sem categoria vão para "Geral".
  const itemToCat = {};
  for (const c of rawCats) {
    const cid = String(c.app_category_id || slug(c.category_name));
    const cname = c.category_name || 'Categoria';
    for (const iid of (c.app_item_id || c.app_item_ids || [])) {
      if (keepIds.has(String(iid))) itemToCat[String(iid)] = { id: cid, name: cname };
    }
  }
  const catMap = new Map();
  for (const it of items) {
    const cat = itemToCat[it.app_item_id] || { id: 'geral', name: 'Geral' };
    if (!catMap.has(cat.id)) {
      catMap.set(cat.id, {
        app_category_id: cat.id, category_name: cat.name,
        priority: catMap.size + 1, app_item_ids: []
      });
    }
    catMap.get(cat.id).app_item_ids.push(it.app_item_id);
  }
  const categories = Array.from(catMap.values());

  // 3) Um único menu com todas as categorias
  const menus = [{
    app_menu_id: 'menu_main',
    menu_name: 'Cardápio',
    app_category_ids: categories.map(c => c.app_category_id)
  }];

  // 4) Grupos de modificadores referenciados pelos itens (pass-through do cru)
  const refMg = new Set();
  for (const it of items) for (const g of (it.app_modifier_group_ids || [])) refMg.add(String(g));
  const modifier_groups = rawMgs.filter(mg => refMg.has(String(mg.app_modifier_group_id)));

  return { menus, categories, items, modifier_groups };
}

// ── Enviar (upload) cardápio para uma loja ──
// POST https://openapi.99food.com/v3/item/item/upload
// SOBRESCREVE o cardápio da loja. Retorna { taskId, status } (processa async).
function uploadMenu(authToken, payload) {
  const body = JSON.stringify({ auth_token: authToken, ...payload });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path: '/v3/item/item/upload', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errno !== 0) {
            console.log(`[99food upload] recusado: ${parsed.errmsg} (errno ${parsed.errno})`);
            return reject(new Error(`99Food recusou o envio: ${parsed.errmsg} (errno ${parsed.errno})`));
          }
          console.log(`[99food upload] aceito, taskId=${parsed.data?.taskId}`);
          resolve(parsed.data || {});
        } catch (err) {
          reject(new Error('99Food retornou resposta inválida no upload: ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', (err) => reject(new Error('Falha de rede no upload 99Food: ' + err.message)));
    req.write(body); req.end();
  });
}

module.exports = { fetchRawMenu, simplifyItems, getMenuItems, buildUploadPayload, uploadMenu };
