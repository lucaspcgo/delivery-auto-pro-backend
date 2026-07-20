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
  const out = {
    payment_method: null, payment_when: null, order_type: null,
    neighborhood: null, promise_time: null, note: null, order_number: null
  };

  // Número curto do pedido mostrado ao lojista (iFood: displayId, ex.: "1234")
  const disp = raw.displayId ?? raw.display_id;
  if (disp != null && String(disp).trim() !== '') out.order_number = String(disp).trim();

  // Bairro / setor
  out.neighborhood = raw.delivery?.deliveryAddress?.neighborhood
    || raw.deliveryAddress?.neighborhood || null;

  // Observação do cliente
  const obs = raw.observations || raw.observation || raw.note;
  if (obs && String(obs).trim()) out.note = String(obs).trim();

  // Promessa: horário previsto de entrega (iFood manda em ISO)
  const eta = raw.delivery?.deliveryDateTime || raw.deliveryDateTime
    || raw.preparationStartDateTime || null;
  if (eta) out.promise_time = horaISO(eta);

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

// Formata uma data ISO (ex.: "2026-07-09T20:15:00Z") para HH:mm no fuso de São Paulo
function horaISO(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  } catch { return null; }
}

// Canal de pagamento do 99Food (pay_channel) -> nome PT-BR (tabela oficial).
const FOOD99_CHANNEL = {
  110: 'Cupom', 150: 'Cartão de crédito/débito', 153: 'Dinheiro',
  154: 'POS (maquininha)', 182: 'PayPay', 184: 'PayPay', 190: '99Pay',
  120: 'Carteira 99Food', 2008: 'Marketing', 901: 'Benefício',
  310: 'Yape', 311: 'Plin', 167: 'Pré-autorização', 219: '99Food Cuenta',
  212: 'Pix', 280: 'Pix', 229: 'NuPay', 234: 'Apple Pay', 235: 'Apple Pay',
  257: 'Vale-refeição Pluxee', 258: 'Vale-refeição Ticket', 259: 'Vale-refeição VR',
  260: 'Vale-refeição Alelo', 261: 'NEQUI', 262: 'Cartão de crédito (POS)',
  263: 'Cartão de débito (POS)', 264: 'Vale-refeição (POS)',
  272: 'Google Pay', 273: 'Google Pay',
};

function fromFood99(raw) {
  const out = {
    payment_method: null, payment_when: null, order_type: null,
    neighborhood: null, promise_time: null, note: null,
    payment_code: null, order_number: null,
    courier_name: null, courier_phone: null, pickup_code: null, promise_epoch: null
  };
  const ra = raw.receive_address || {};

  // Entregador/parceiro (99Food: shopper_info) — vem vazio até ser designado.
  const sp = raw.shopper_info || raw.courier || {};
  const cName = String(sp.name || '').trim();
  const cPhone = String(sp.phone || '').trim();
  if (cName) out.courier_name = cName;
  if (cPhone) out.courier_phone = cPhone;

  // Código de retirada mostrado ao entregador (útil no card)
  out.pickup_code = raw.pickup_code || raw.takeaway_code || raw.handover_code || null;

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
  if (eta) { out.promise_time = hora(eta); out.promise_epoch = Number(eta) * 1000; }

  // Entrega x Retirada = fulfillment_mode (0-Entrega, 1-Retirada).
  // (delivery_type é OUTRA coisa: quem entrega — 1=99Food, 2=a própria loja.)
  if (raw.fulfillment_mode != null) {
    out.order_type = Number(raw.fulfillment_mode) === 1 ? 'Retirada' : 'Entrega';
  }
  if (raw.delivery_type != null) {
    out.delivery_by = Number(raw.delivery_type) === 2 ? 'Entrega da loja' : 'Entrega 99Food';
  }

  // Pagamento (tabela oficial do 99Food):
  //  pay_method: 1=online / 2=offline (na entrega). pay_channel: método específico.
  const payCode = raw.pay_method ?? raw.pay_type;
  if (payCode != null) out.payment_code = Number(payCode);
  if (raw.pay_channel != null) {
    out.payment_channel = Number(raw.pay_channel);
    out.payment_method = FOOD99_CHANNEL[Number(raw.pay_channel)] || null;
  }
  if (raw.pay_method != null) {
    out.payment_when = Number(raw.pay_method) === 2 ? 'Pagar na entrega' : 'Pago online';
  } else if (raw.pay_type != null) {
    out.payment_when = Number(raw.pay_type) === 1 ? 'Pago online' : 'Pagar na entrega';
  }

  // Valores (99Food manda em centavos no objeto price). Cobre os 3 modelos de
  // preço (entrega 99Food x entrega da loja). Convertemos p/ reais.
  const pr = raw.price || {};
  const of = pr.others_fees || {};
  const reais = (c) => (c == null ? null : Number(c) / 100);
  out.amounts = {
    order_price: reais(pr.order_price),                                   // valor dos itens
    delivery_fee: reais(pr.delivery_price ?? pr.store_charged_delivery_price), // taxa de entrega
    service_fee: reais(pr.service_price ?? of.service_price),             // taxa de serviço
    items_discount: reais(pr.items_discount),                            // desconto nos itens
    delivery_discount: reais(pr.delivery_discount),                      // desconto na entrega
    customer_paid: reais(pr.real_pay_price ?? pr.customer_need_paying_money), // total pago pelo cliente
    store_receives: reais(pr.real_price),                                // total que a loja recebe
    tip: reais(of.total_tip_money),                                      // gorjeta
    refund: reais(pr.refund_price),                                      // reembolso
  };

  // Endereço completo (útil pro card do KDS).
  out.address = {
    street: ra.street_name || null,
    number: ra.street_number || ra.house_number || null,
    district: ra.district || null,
    city: ra.city || null,
    state: ra.state || null,
    complement: ra.complement || null,
    reference: ra.reference || null,
    full: ra.poi_address || ra.poi_display_name || null,
    lat: ra.poi_lat || null,
    lng: ra.poi_lng || null,
  };

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
