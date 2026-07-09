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
  // Nome "enxuto" p/ casar promoções: tira quantidade no início ("1 ", "2x ")
  // e o sufixo de promoção (depois de — , - , + , "por"). "1 MARMITEX GALINHADA
  // — POR + 19,90..." -> "marmitex galinhada".
  const nomeBase = (s) => norm(s)
    .replace(/^\s*\d+\s*x?\s*/i, '')
    .split(/\s+[—\-+]\s+|\s*—\s*|\s+por\s+/i)[0]
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parse = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return v && typeof v === 'object' ? v : [];
  };

  // Monta os mapas de foto (por código e por nome) a partir dos cardápios salvos
  const byId = new Map();
  const byName = new Map();
  const byBase = new Map(); // nome base -> imagem (casa promoções/combos)
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
        if (id != null && String(id) !== '') byId.set(String(id), img);
        if (it.name) {
          byName.set(norm(it.name), img);
          const base = nomeBase(it.name);
          if (base && base.length >= 4 && !byBase.has(base)) byBase.set(base, img);
        }
      }
    }
  } catch (err) {
    console.warn('[order images] não foi possível carregar cardápios:', err.message);
    return orders; // sem fotos, mas retorna os pedidos normalmente
  }

  console.log(`[order images] ${platform}: ${byId.size} foto(s) por código, ${byName.size} por nome no cardápio salvo`);
  if (byId.size === 0 && byName.size === 0) {
    console.log(`[order images] ${platform}: NENHUMA foto no cardápio salvo — cadastre foto no produto e clique em "Buscar cardápio".`);
    return orders;
  }

  let casados = 0, semFoto = 0;
  for (const o of orders) {
    const items = parse(o.items);
    if (!Array.isArray(items)) continue;
    o.items = items.map((it) => {
      if (!it || typeof it !== 'object') return it;
      const id = it.app_item_id ?? it.item_id ?? it.id ?? it.sku ?? it.productId ?? it.mdu_id;
      const name = it.name ?? it.item_name ?? it.dish_name ?? it.food_name;
      // Casa a foto do cardápio salvo, nesta ordem:
      //   1) por código (app_item_id)  2) por nome exato
      //   3) por "nome base" (ignora quantidade/promoção — ex.: combos)
      //   4) por "contém" (nome do cardápio dentro do nome do pedido)
      //   5) por último, a foto que o 99Food manda no próprio item do pedido
      const idOk = id != null && String(id) !== '';
      const base = nomeBase(name);
      let image = (idOk && byId.get(String(id)))
        || (name && byName.get(norm(name)))
        || (base && byBase.get(base))
        || null;
      if (!image && base && base.length >= 4) {
        for (const [b, img] of byBase) { if (base.includes(b) || b.includes(base)) { image = img; break; } }
      }
      if (!image) {
        const ownImg = it.head_img || it.image || it.item_head_img || it.food_img || it.img || it.item_img;
        if (typeof ownImg === 'string' && /^https?:\/\//i.test(ownImg)) image = ownImg;
      }
      if (image) casados++; else { semFoto++; console.log(`[order images] item sem foto (id=${id}, nome=${name})`); }
      return { ...it, image };
    });
  }
  console.log(`[order images] ${platform}: ${casados} item(ns) com foto, ${semFoto} sem foto`);
  return orders;
}

module.exports = { attachItemImages };
