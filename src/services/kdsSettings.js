const pool = require('../db/postgres');
const { STAGES } = require('./kdsStages');

// Colunas do KDS (etapas). Por padrão mostramos TODAS as etapas ativas para que
// nenhum pedido suma (inclusive os que a automação já aceitou e estão "Aceitos"
// aguardando o tempo de pronto). Só as etapas finais (entregue/cancelado) vêm
// ocultas. O usuário pode ajustar em "Configurar colunas".
const DEFAULT_VISIBLE = new Set(['pendente', 'aceito', 'preparando', 'aguardando', 'entregando', 'no_destino']);
function defaultColumns() {
  return STAGES.map((s, i) => ({
    key: s.key, label: s.label,
    visible: DEFAULT_VISIBLE.has(s.key),
    order: i + 1,
  }));
}

// Catálogo de TODOS os campos que o KDS pode mostrar hoje (iFood + 99Food).
// group: 'pedido' (dados do pedido) ou 'item' (por item do pedido).
// default: se vem ligado por padrão. source: de onde o dado sai (referência).
const AVAILABLE_FIELDS = [
  // ── Dados do pedido ──
  { key: 'customer_name',   label: 'Nome do cliente',        group: 'pedido', default: true },
  { key: 'order_time',      label: 'Horário do pedido',      group: 'pedido', default: true },
  { key: 'platform',        label: 'Plataforma (iFood/99)',  group: 'pedido', default: true },
  { key: 'status',          label: 'Status do pedido',       group: 'pedido', default: true },
  { key: 'total_price',     label: 'Valor total',            group: 'pedido', default: true },
  { key: 'order_elapsed',   label: 'Tempo desde o pedido',   group: 'pedido', default: true },
  { key: 'order_type',      label: 'Entrega ou retirada',    group: 'pedido', default: true },
  { key: 'promise_time',    label: 'Promessa (previsão)',    group: 'pedido', default: true },
  { key: 'neighborhood',    label: 'Bairro / setor',         group: 'pedido', default: true },
  { key: 'note',            label: 'Observação do cliente',  group: 'pedido', default: true },
  { key: 'payment_method',  label: 'Forma de pagamento',     group: 'pedido', default: false },
  { key: 'order_number',    label: 'Número do pedido',       group: 'pedido', default: true },
  { key: 'customer_phone',  label: 'Telefone do cliente',    group: 'pedido', default: false },
  { key: 'delivery_address',label: 'Endereço de entrega',    group: 'pedido', default: false },
  // ── Por item ──
  { key: 'item_image',      label: 'Foto do produto',        group: 'item',   default: true },
  { key: 'item_name',       label: 'Nome do item',           group: 'item',   default: true },
  { key: 'item_quantity',   label: 'Quantidade',             group: 'item',   default: true },
  { key: 'item_subitems',   label: 'Complementos/adicionais',group: 'item',   default: true },
  { key: 'item_price',      label: 'Preço do item',          group: 'item',   default: false },
];

// Configuração padrão: quais CAMPOS aparecem no card + quais COLUNAS aparecem no KDS
function defaultConfig() {
  const fields = {};
  for (const f of AVAILABLE_FIELDS) fields[f.key] = f.default;
  return { fields, columns: defaultColumns() };
}

// Mantém só chaves conhecidas e valores válidos (sanitiza a entrada do usuário)
function sanitize(input) {
  const cfg = defaultConfig();
  const inFields = (input && typeof input === 'object' && input.fields) || {};
  for (const f of AVAILABLE_FIELDS) {
    if (typeof inFields[f.key] === 'boolean') cfg.fields[f.key] = inFields[f.key];
  }

  // Colunas: aplica visible/order que o usuário mandou, só para chaves conhecidas.
  const inCols = (input && typeof input === 'object' && Array.isArray(input.columns)) ? input.columns : [];
  const byKey = new Map(inCols.map(c => [c && c.key, c]));
  for (const col of cfg.columns) {
    const c = byKey.get(col.key);
    if (c) {
      if (typeof c.visible === 'boolean') col.visible = c.visible;
      if (Number.isFinite(Number(c.order))) col.order = Number(c.order);
    }
  }
  // Ordena pela ordem pedida e REatribui 1..N para garantir índices únicos e
  // consistentes (mesmo que o usuário mande orders repetidos ou com buracos).
  cfg.columns.sort((a, b) => a.order - b.order);
  cfg.columns.forEach((col, i) => { col.order = i + 1; });
  return cfg;
}

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS kds_settings (
        user_id    TEXT PRIMARY KEY,
        config     JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `).catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// Retorna a config do usuário (ou o padrão) + o catálogo de campos disponíveis.
async function getSettings(userId) {
  await ensureSchema();
  const r = await pool.query('SELECT config FROM kds_settings WHERE user_id = $1', [String(userId)]);
  const saved = r.rows[0]?.config;
  const config = saved ? sanitize(saved) : defaultConfig();
  return { config, available_fields: AVAILABLE_FIELDS, available_columns: STAGES };
}

// Salva a config do usuário (sanitizada).
async function saveSettings(userId, input) {
  await ensureSchema();
  const config = sanitize(input);
  await pool.query(
    `INSERT INTO kds_settings (user_id, config, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [String(userId), JSON.stringify(config)]
  );
  return { config, available_fields: AVAILABLE_FIELDS, available_columns: STAGES };
}

// Restaura a configuração padrão do usuário (campos + colunas).
async function resetSettings(userId) {
  await ensureSchema();
  const config = defaultConfig();
  await pool.query(
    `INSERT INTO kds_settings (user_id, config, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [String(userId), JSON.stringify(config)]
  );
  return { config, available_fields: AVAILABLE_FIELDS, available_columns: STAGES };
}

module.exports = { AVAILABLE_FIELDS, defaultConfig, getSettings, saveSettings, resetSettings };
