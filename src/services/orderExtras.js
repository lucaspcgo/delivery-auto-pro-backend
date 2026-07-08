// Extrai campos úteis (forma de pagamento, entrega/retirada) do pedido cru
// (raw_payload) de cada plataforma. Best-effort: se não achar, devolve null.

function parse(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return {};
}

// iFood: método de pagamento (payments.methods[].method) → PT
const IFOOD_PAY = {
  CREDIT: 'Cartão de crédito', DEBIT: 'Cartão de débito', CASH: 'Dinheiro',
  MONEY: 'Dinheiro', PIX: 'Pix', MEAL_VOUCHER: 'Vale-refeição',
  FOOD_VOUCHER: 'Vale-alimentação', DIGITAL_WALLET: 'Carteira digital',
  GIFT_CARD: 'Vale-presente', CREDIT_DEBIT: 'Cartão'
};
const IFOOD_TYPE = {
  DELIVERY: 'Entrega', TAKEOUT: 'Retirada', INDOOR: 'Consumo no local',
  DINE_IN: 'Consumo no local'
};

function fromIfood(raw) {
  const out = { payment_method: null, payment_when: null, order_type: null };

  // Entrega x retirada
  const t = raw.orderType || raw.orderTiming || raw.type;
  if (t) out.order_type = IFOOD_TYPE[String(t).toUpperCase()] || String(t);
  else if (raw.takeout) out.order_type = 'Retirada';
  else if (raw.delivery) out.order_type = 'Entrega';

  // Pagamento
  const methods = raw.payments?.methods || raw.payment?.methods || [];
  if (Array.isArray(methods) && methods.length) {
    const nomes = methods.map(m => IFOOD_PAY[String(m.method || '').toUpperCase()] || m.method).filter(Boolean);
    if (nomes.length) out.payment_method = [...new Set(nomes)].join(', ');
    const online = methods.some(m => String(m.type || '').toUpperCase() === 'ONLINE') || Number(raw.payments?.prepaid) > 0;
    out.payment_when = online ? 'Pago online' : 'Pagar na entrega';
  } else if (Number(raw.payments?.prepaid) > 0) {
    out.payment_when = 'Pago online';
  }
  return out;
}

function fromFood99(raw) {
  const out = { payment_method: null, payment_when: null, order_type: null };

  // Entrega x retirada (campos possíveis do 99Food)
  const t = raw.order_type ?? raw.delivery_type ?? raw.shipping_type ?? raw.business_type;
  if (t != null && t !== '') {
    const s = String(t).toLowerCase();
    if (s.includes('pick') || s.includes('self') || s === '2') out.order_type = 'Retirada';
    else if (s.includes('deliver') || s === '1') out.order_type = 'Entrega';
    else out.order_type = String(t);
  }

  // Pagamento (campos possíveis)
  const pay = raw.pay_type ?? raw.payment_type ?? raw.payment_method ?? raw.price?.pay_type;
  if (pay != null && pay !== '') {
    const s = String(pay).toLowerCase();
    if (s.includes('online') || s.includes('prepaid') || s === '1') out.payment_when = 'Pago online';
    else if (s.includes('cash') || s.includes('delivery') || s === '2') out.payment_when = 'Pagar na entrega';
    out.payment_method = String(raw.pay_type_name ?? raw.payment_name ?? pay);
  }
  return out;
}

function extractOrderExtras(rawPayload, platform) {
  try {
    const raw = parse(rawPayload);
    if (platform === 'ifood') return fromIfood(raw);
    if (platform === '99food') return fromFood99(raw);
  } catch (e) { /* ignora */ }
  return { payment_method: null, payment_when: null, order_type: null };
}

module.exports = { extractOrderExtras };
