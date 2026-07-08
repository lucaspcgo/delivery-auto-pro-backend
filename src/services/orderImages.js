const pool = require('../db/postgres');

// Anexa a foto (image) de cada item do pedido, casando com o cardápio salvo
// (tabela menu_items, preenchida ao "Buscar cardápio"). Best-effort:
// se não achar a foto, deixa image = null — nunca quebra o pedido.
//
// orders: linhas do SELECT em orders (campo items = JSON de itens do pedido)
// platform: 'ifood' | '99food'
// userId: dono das lojas (isolamento por conta)
async function attachItemImages(orders, platform, userId) {
  if (!Array.isArray(orders) || orders.length === 0) return orders;

  const norm = (s) => String(s || '').trim().toLowerCase();
  const parse = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return v && typeof v === 'object' ? v : [];
  };

  // Monta os mapas de foto (por código e por nome) a partir dos cardápios salvos
  const byId = new Map();
  const byName = new Map();
  try {
    const menus = await pool.query(
      `SELECT mi.items_data FROM menu_items mi
       JOIN restaurants r ON r.id = mi.restaurant_id
       WHERE r.user_id = $1 AND mi.platform = $2`,
      [userId, platform]
    );
    for (const row of menus.rows) {
      for (const it of parse(row.items_data)) {
        const img = it && (it.image || it.head_img);
        if (!img) continue;
        const id = it.id ?? it.app_item_id ?? it.productId;
        if (id != null) byId.set(String(id), img);
        if (it.name) byName.set(norm(it.name), img);
      }
    }
  } catch (err) {
    console.warn('[order images] não foi possível carregar cardápios:', err.message);
    return orders; // sem fotos, mas retorna os pedidos normalmente
  }

  if (byId.size === 0 && byName.size === 0) return orders; // nada pra casar

  for (const o of orders) {
    const items = parse(o.items);
    if (!Array.isArray(items)) continue;
    o.items = items.map((it) => {
      if (!it || typeof it !== 'object') return it;
      const id = it.app_item_id ?? it.item_id ?? it.id ?? it.sku ?? it.productId;
      const name = it.name ?? it.item_name ?? it.dish_name ?? it.food_name;
      const image = it.image
        || (id != null && byId.get(String(id)))
        || (name && byName.get(norm(name)))
        || null;
      return { ...it, image };
    });
  }
  return orders;
}

module.exports = { attachItemImages };
