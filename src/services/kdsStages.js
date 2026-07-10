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
];

// Conjunto de etapas válidas (para validação/fallback no consumo)
const STAGE_KEYS = new Set(STAGES.map(s => s.key));

// Etapas finais (pedido encerrado — sai do kanban por padrão)
const TERMINAL_STAGES = new Set(['entregue', 'cancelado']);

// Mapa: valor de status cru (minúsculo) → etapa. Cobre os valores das duas
// plataformas e os apelidos curtos do iFood (PLC, CFM, RTP, DSP, CON...).
const STATUS_TO_STAGE = {
  // Pendente (pedido novo aguardando aceite)
  '100': 'pendente', 'placed': 'pendente', 'plc': 'pendente', 'new': 'pendente', 'pending': 'pendente',
  // Aceito (confirmado pela loja) — 99Food usa 200
  '200': 'aceito', 'confirmed': 'aceito', 'cfm': 'aceito', 'accepted': 'aceito',
  // Preparando (em produção) — 99Food ~300
  '300': 'preparando',
  'preparing': 'preparando', 'separation_started': 'preparando', 'sps': 'preparando',
  'separation_ended': 'preparando', 'spe': 'preparando', 'in_preparation': 'preparando',
  // Aguardando (pronto, esperando o entregador retirar)
  'ready': 'aguardando', 'ready_to_pickup': 'aguardando', 'rtp': 'aguardando', 'ready_to_deliver': 'aguardando',
  // Entregando (saiu para entrega) — 99Food 400/500 (entregador designado / a caminho)
  '400': 'entregando', '500': 'entregando',
  'dispatched': 'entregando', 'dsp': 'entregando', 'on_the_way': 'entregando', 'going_to_origin': 'entregando',
  // No destino (entregador chegou no endereço do cliente)
  'arrived': 'no_destino', 'arrived_at_destination': 'no_destino', 'arv': 'no_destino',
  // Entregue (concluído) — 99Food 600
  '600': 'entregue',
  'concluded': 'entregue', 'con': 'entregue', 'delivered': 'entregue', 'completed': 'entregue', 'dlv': 'entregue',
  // Cancelado
  'cancelled': 'cancelado', 'canceled': 'cancelado', 'can': 'cancelado', 'cancellation_requested': 'cancelado',
};

// Lista de valores de status CRUS que representam etapa final (entregue/cancelado).
// Usada para filtrar no SQL sem depender do JS. Em minúsculo.
const TERMINAL_RAW_STATUSES = Object.entries(STATUS_TO_STAGE)
  .filter(([, stage]) => TERMINAL_STAGES.has(stage))
  .map(([raw]) => raw);

// Diz se um status cru representa pedido encerrado (etapa final).
function isTerminalStatus(status) {
  return TERMINAL_STAGES.has(normalizeStage(status));
}

// Descobre a etapa do KDS a partir do status cru salvo no pedido.
// Status não reconhecido cai em 'pendente' (pedido novo/actionável) — assim
// aparece na primeira coluna com o botão "Aceitar", nunca some do KDS.
function normalizeStage(status) {
  const s = String(status ?? '').trim().toLowerCase();
  return STATUS_TO_STAGE[s] || 'pendente';
}

// Ações manuais (botões) que a LOJA pode comandar em cada etapa. É a fonte da
// verdade do KDS: o front renderiza exatamente estes botões, sem adivinhar.
// Rótulos por ação:
const ACTION_LABELS = {
  confirm:  'Aceitar',
  ready:    'Pronto',
  dispatch: 'Saiu p/ entrega',
  cancel:   'Cancelar',
};

function availableActions(platform, stage) {
  let acts;
  switch (stage) {
    case 'pendente':   acts = ['confirm', 'cancel']; break;
    case 'aceito':     acts = ['ready', 'cancel']; break;
    case 'preparando': acts = ['ready', 'cancel']; break;
    // Saiu p/ entrega só existe no iFood (e apenas entrega própria da loja)
    case 'aguardando': acts = platform === 'ifood' ? ['dispatch', 'cancel'] : ['cancel']; break;
    // Etapas finais/controladas pela plataforma: sem botões
    case 'entregando':
    case 'no_destino':
    case 'entregue':
    case 'cancelado':  acts = []; break;
    // Desconhecido ("outros"): oferece o fluxo manual completo como PLANO B,
    // pra loja nunca ficar sem "Aceitar"/"Pronto" se a automação falhar.
    default:           acts = ['confirm', 'ready', 'cancel']; break;
  }
  return acts.map(a => ({ action: a, label: ACTION_LABELS[a] }));
}

// Resumo de etapa para RESPOSTA de ação: o front atualiza só o card, sem refetch.
function stageInfo(platform, orderId, status) {
  const kds_stage = normalizeStage(status);
  return {
    platform_order_id: String(orderId),
    status,
    kds_stage,
    available_actions: availableActions(platform, kds_stage),
  };
}

module.exports = { STAGES, STAGE_KEYS, TERMINAL_STAGES, TERMINAL_RAW_STATUSES, isTerminalStatus, normalizeStage, availableActions, ACTION_LABELS, stageInfo };
