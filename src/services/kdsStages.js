// Etapas (colunas) do KDS, iguais para iFood e 99Food. Cada pedido é encaixado
// em UMA etapa a partir do seu `status` cru (que varia por plataforma).
//
// Ordem do fluxo do pedido:
//   pendente → aceito → preparando → aguardando → entregando → no_destino → entregue
//   (cancelado é um estado à parte)

const STAGES = [
  { key: 'pendente',    label: 'Pendentes',   order: 1 },
  { key: 'aceito',      label: 'Aceitos',     order: 2 },
  { key: 'preparando',  label: 'Preparando',  order: 3 },
  { key: 'aguardando',  label: 'Aguardando',  order: 4 },
  { key: 'entregando',  label: 'Entregando',  order: 5 },
  { key: 'no_destino',  label: 'No Destino',  order: 6 },
  { key: 'entregue',    label: 'Entregue',    order: 7 },
  { key: 'cancelado',   label: 'Cancelado',   order: 8 },
  // Coragem: status não reconhecido cai aqui (visível), para nunca sumir do KDS
  // e para percebermos códigos novos que ainda precisam ser mapeados.
  { key: 'outros',      label: 'Outros',      order: 9 },
];

// Conjunto de etapas válidas (para validação/fallback no consumo)
const STAGE_KEYS = new Set(STAGES.map(s => s.key));

// Mapa: valor de status cru (minúsculo) → etapa. Cobre os valores das duas
// plataformas e os apelidos curtos do iFood (PLC, CFM, RTP, DSP, CON...).
const STATUS_TO_STAGE = {
  // Pendente (pedido novo aguardando aceite)
  '100': 'pendente', 'placed': 'pendente', 'plc': 'pendente', 'new': 'pendente', 'pending': 'pendente',
  // Aceito (confirmado pela loja)
  '200': 'aceito', 'confirmed': 'aceito', 'cfm': 'aceito', 'accepted': 'aceito',
  // Preparando (em produção)
  'preparing': 'preparando', 'separation_started': 'preparando', 'sps': 'preparando',
  'separation_ended': 'preparando', 'spe': 'preparando', 'in_preparation': 'preparando',
  // Aguardando (pronto, esperando o entregador retirar)
  'ready': 'aguardando', 'ready_to_pickup': 'aguardando', 'rtp': 'aguardando', 'ready_to_deliver': 'aguardando',
  // Entregando (saiu para entrega)
  'dispatched': 'entregando', 'dsp': 'entregando', 'on_the_way': 'entregando', 'going_to_origin': 'entregando',
  // No destino (entregador chegou no endereço do cliente)
  'arrived': 'no_destino', 'arrived_at_destination': 'no_destino', 'arv': 'no_destino',
  // Entregue (concluído)
  'concluded': 'entregue', 'con': 'entregue', 'delivered': 'entregue', 'completed': 'entregue', 'dlv': 'entregue',
  // Cancelado
  'cancelled': 'cancelado', 'canceled': 'cancelado', 'can': 'cancelado', 'cancellation_requested': 'cancelado',
};

// Descobre a etapa do KDS a partir do status cru salvo no pedido.
// Status não reconhecido cai em 'outros' (coluna visível) — nunca some do KDS.
function normalizeStage(status) {
  const s = String(status ?? '').trim().toLowerCase();
  return STATUS_TO_STAGE[s] || 'outros';
}

module.exports = { STAGES, STAGE_KEYS, normalizeStage };
