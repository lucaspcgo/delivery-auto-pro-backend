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

// Formata epoch (segundos) para HH:mm no fuso de São Paulo
function hora(epochSec) {
  try {
    return new Date(Number(epochSec) * 1000)
      .toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  } catch { return null; }
}

function fromFood99(raw) {
  const out = {
    payment_method: null, payment_when: null, order_type: null,
    neighborhood: null, promise_time: null, note: null,
    payment_code: null, order_number: null
  };
  const ra = raw.receive_address || {};

  // Número curto do pedido mostrado na loja (o order_id de 64 bits NÃO é esse número).
  // O 99Food manda em algum destes campos; pegamos o primeiro que existir.
  const numCand = raw.order_index ?? raw.order_serial_num ?? raw.serial_number
    ?? raw.daily_serial ?? raw.order_show_id ?? raw.order_num ?? raw.order_display_num
    ?? raw.day_seq ?? raw.index;
  if (numCand != null && String(numCand).trim() !== '') out.order_number = String(numCand).trim();

  // Bairro / setor
  out.neighborhood = ra.district || null;

  // Observação do cliente
  if (raw.remark && String(raw.remark).trim()) out.note = String(raw.remark).trim();

  // Promessa: horário esperado de chegada (ou ETA de entrega)
  const eta = raw.expected_arrived_eta || raw.delivery_eta;
  if (eta) out.promise_time = hora(eta);

  // Tipo de entrega (99Food manda código numérico em delivery_type)
  if (raw.delivery_type != null) {
    const dt = Number(raw.delivery_type);
    out.order_type = dt === 2 ? 'Retirada' : 'Entrega'; // padrão: entrega
  }

  // Pagamento vem como código (pay_method/pay_type). Guardamos o código;
  // o nome ("Dinheiro/Crédito") depende da tabela de códigos do 99Food.
  const payCode = raw.pay_method ?? raw.pay_type;
  if (payCode != null) out.payment_code = Number(payCode);

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
