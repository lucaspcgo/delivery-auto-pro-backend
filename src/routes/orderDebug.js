const pool = require('../db/postgres');
const { attachItemImages } = require('../services/orderImages');
const { extractOrderExtras } = require('../services/orderExtras');
const { normalizeStage } = require('../services/kdsStages');

// ─── Helpers de comparação ──────────────────────────────────────────────────
const isEmpty = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const normTxt = (v) => String(v ?? '').trim().toLowerCase();
const num2 = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Math.round(Number(v) * 100) / 100);

// Compara o valor mapeado (o que o KDS usa) com o valor esperado a partir do
// payload BRUTO. Cada descritor sabe de onde o campo DEVERIA sair no raw e como
// transformá-lo para comparar. Status:
//   ok         → mapeado == origem no bruto
//   divergente → ambos existem mas são diferentes (POSSÍVEL QUEBRA DE MAPEAMENTO)
//   vazio      → mapeado vazio, mas há origem no bruto (dado perdido no caminho)
//   sem_origem → nem no bruto existe (esperado em pedido de simulador)
function buildFieldChecks(mapped, raw, platform) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const ra = raw.receive_address || {};
  const semMascara = (s) => (s && !/privacy protection/i.test(String(s)) ? String(s).trim() : '');
  const nome99 = [semMascara(ra.first_name), semMascara(ra.last_name)].filter(Boolean).join(' ') || semMascara(ra.name) || null;

  // Descritores por plataforma: { field, source (rótulo do caminho no bruto),
  //   rawValue (valor comparável extraído do bruto), compare ('txt'|'num') }
  const descriptors = platform === '99food' ? [
    { field: 'order_number', source: 'order_index/serial/...', rawValue: raw.order_index ?? raw.order_serial_num ?? raw.serial_number ?? raw.daily_serial ?? raw.order_show_id ?? raw.order_num ?? raw.order_display_num ?? raw.day_seq ?? raw.index, compare: 'txt' },
    { field: 'customer_name', source: 'first_name/last_name (name vem mascarado)', rawValue: nome99, compare: 'txt' },
    { field: 'customer_phone', source: 'receive_address.phone', rawValue: ra.phone, compare: 'txt' },
    { field: 'neighborhood', source: 'receive_address.district', rawValue: semMascara(ra.district) || null, compare: 'txt' },
    { field: 'delivery_address', source: 'receive_address.poi_address', rawValue: semMascara(ra.poi_address) || [[semMascara(ra.street_name), semMascara(ra.house_number)].filter(Boolean).join(', '), semMascara(ra.district), semMascara(ra.city)].filter(Boolean).join(' - ') || null, compare: 'txt' },
    { field: 'note', source: 'remark', rawValue: raw.remark, compare: 'txt' },
    { field: 'total_price', source: 'price.real_pay_price/100', rawValue: num2((raw.price?.real_pay_price ?? raw.price?.order_price ?? null) / 100), compare: 'num' },
  ] : [
    { field: 'order_number', source: 'displayId', rawValue: raw.displayId ?? raw.display_id, compare: 'txt' },
    { field: 'customer_name', source: 'customer.name', rawValue: raw.customer?.name, compare: 'txt' },
    { field: 'customer_phone', source: 'customer.phone.number', rawValue: raw.customer?.phone?.number ?? raw.customer?.phone, compare: 'txt' },
    { field: 'neighborhood', source: 'delivery.deliveryAddress.neighborhood', rawValue: raw.delivery?.deliveryAddress?.neighborhood, compare: 'txt' },
    { field: 'total_price', source: 'total.orderAmount', rawValue: num2(raw.total?.orderAmount), compare: 'num' },
  ];

  const checks = [];
  for (const d of descriptors) {
    const mappedVal = mapped[d.field];
    const rawVal = d.rawValue;
    let status;
    if (isEmpty(rawVal)) status = isEmpty(mappedVal) ? 'sem_origem' : 'divergente';
    else if (isEmpty(mappedVal)) status = 'vazio';
    else if (d.compare === 'num') status = num2(mappedVal) === num2(rawVal) ? 'ok' : 'divergente';
    else status = normTxt(mappedVal) === normTxt(rawVal) ? 'ok' : 'divergente';
    checks.push({ field: d.field, source: d.source, mapped: mappedVal ?? null, raw: rawVal ?? null, status });
  }
  return checks;
}

// Handler de DEPURAÇÃO: por pedido, devolve os campos BRUTOS recebidos da
// plataforma lado a lado com o MAPEAMENTO entregue ao KDS, MAIS uma checagem
// (field_checks) que destaca divergências entre bruto e mapeado.
//
// Escopo: só os pedidos do próprio usuário autenticado (isolamento por conta).
// Suporta paginação por offset: ?limit=10&offset=20.
function makeDebugHandler(platform) {
  return async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
      const offset = Math.max(Number(req.query.offset) || 0, 0);

      const totalRes = await pool.query(
        'SELECT COUNT(*)::int AS total FROM orders WHERE platform = $1 AND user_id = $2',
        [platform, req.user.id]
      );
      const total = totalRes.rows[0].total;

      const result = await pool.query(
        `SELECT id, platform, platform_order_id, app_shop_id, status, customer_name,
                customer_phone, delivery_address, items, total_price, raw_payload,
                created_at, updated_at
           FROM orders
          WHERE platform = $1 AND user_id = $2
          ORDER BY created_at DESC
          LIMIT $3 OFFSET $4`,
        [platform, req.user.id, limit, offset]
      );

      const withImages = await attachItemImages(result.rows, platform, req.user.id);

      const out = withImages.map((o) => {
        let raw = o.raw_payload;
        if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { /* deixa string */ } }
        const extras = extractOrderExtras(o.raw_payload, platform);
        const mapped = {
          customer_name: o.customer_name,
          customer_phone: o.customer_phone,
          delivery_address: o.delivery_address,
          total_price: o.total_price,
          items: o.items,
          ...extras,
        };
        return {
          id: o.id,
          platform_order_id: o.platform_order_id,
          status: o.status,
          kds_stage: normalizeStage(o.status),
          created_at: o.created_at,
          mapped,
          field_checks: buildFieldChecks(mapped, raw, platform),
          raw_keys: raw && typeof raw === 'object' ? Object.keys(raw) : [],
          raw,
        };
      });

      const nextOffset = offset + out.length;
      return res.json({
        platform,
        total,
        limit,
        offset,
        count: out.length,
        has_more: nextOffset < total,
        next_offset: nextOffset < total ? nextOffset : null,
        orders: out,
      });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao carregar depuração de pedidos', details: err.message });
    }
  };
}

module.exports = { makeDebugHandler, buildFieldChecks };
