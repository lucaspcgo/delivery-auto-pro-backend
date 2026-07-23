const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/postgres');
const { billingIntervalDays, planCycleDays } = require('../services/billing');
const { trialDays } = require('../config/featureFlags');
const router = express.Router();

const { JWT_SECRET } = require('../config/env');

// Middleware da EQUIPE: libera admin OU gerente no Painel Administrativo.
// O gerente cuida da cobrança (ver/filtrar faturas, marcar paga, renovar,
// suspender/reativar) mas NÃO mexe em planos, perfis nem exclui usuários —
// isso é barrado endpoint a endpoint pelo `adminOnly`.
function staffAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.is_admin && decoded.role !== 'gerente' && decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado — apenas equipe (gerente ou admin)' });
    }
    req.user = decoded;
    next();
  } catch (err) { return res.status(401).json({ error: 'Token inválido' }); }
}

// Barra o gerente nas ações estruturais (só admin passa).
function adminOnly(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Acesso negado — apenas administradores' });
  }
  next();
}

router.use(staffAuth);

// GET /api/v1/admin/users — listar todos os usuários
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, phone, role, plan, active, is_admin, payment_status, plan_expires_at,
              company_name, company_cnpj, totp_enabled, created_at, updated_at
       FROM users ORDER BY created_at DESC`
    );
    return res.json(result.rows);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/v1/admin/users/:id — detalhes de um usuário
router.get('/users/:id', async (req, res) => {
  try {
    const user = await pool.query(
      `SELECT id, name, email, phone, role, plan, active, is_admin, payment_status, plan_expires_at,
              company_name, company_cnpj, company_address, totp_enabled, created_at, updated_at
       FROM users WHERE id = $1`, [req.params.id]
    );
    if (user.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    const invoices = await pool.query(
      `SELECT * FROM invoices WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [req.params.id]
    );
    const restaurants = await pool.query(
      `SELECT r.*, (SELECT json_agg(rp.*) FROM restaurant_platforms rp WHERE rp.restaurant_id = r.id) as platforms
       FROM restaurants r WHERE r.active = true ORDER BY r.created_at DESC`
    );
    return res.json({ ...user.rows[0], invoices: invoices.rows, restaurants: restaurants.rows });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// PUT /api/v1/admin/users/:id — atualizar usuário (plano, status, etc)
router.put('/users/:id', async (req, res) => {
  let { name, email, phone, plan, active, payment_status, role, is_admin, plan_expires_at } = req.body;
  // O gerente pode editar contato e mexer no acesso (active/payment_status),
  // mas NÃO troca plano, perfil nem promove admin — só o admin faz isso.
  if (!req.user.is_admin) {
    plan = undefined; role = undefined; is_admin = undefined; plan_expires_at = undefined;
  } else if (role) {
    // O Perfil (role) é a fonte da verdade do acesso: escolher "Admin" LIGA o
    // is_admin de verdade; "Gerente"/"Cliente" DESLIGA. Assim o dropdown de
    // Perfil concede/remove o poder — não fica só um rótulo bonito.
    is_admin = (role === 'admin');
  }
  try {
    // Quando o admin TROCA o plano do usuário (e não mandou uma data específica),
    // a validade do bloqueio passa a valer o CICLO do novo plano (semanal=7,
    // mensal=30, anual=365 dias), contando a partir da DATA DE CRIAÇÃO da conta
    // (não de hoje). Ex.: criada dia 22 no Starter (7 dias) => vence dia 29.
    // A RENOVAÇÃO (botão Renovar / fatura paga) é que conta pra frente a partir
    // do dia da renovação.
    let renewDays = null;
    if (plan) {
      const planRow = await pool.query('SELECT billing_period, is_free FROM plans WHERE slug = $1 AND active = true', [plan]);
      if (planRow.rows.length === 0) return res.status(400).json({ error: 'Plano inválido' });
      if (plan_expires_at == null) {
        const cur = await pool.query('SELECT plan FROM users WHERE id = $1', [req.params.id]);
        const planoMudou = cur.rows.length > 0 && cur.rows[0].plan !== plan;
        // Free => dias de teste (3); senão o ciclo do plano.
        if (planoMudou) renewDays = planCycleDays(planRow.rows[0]);
      }
    }
    const result = await pool.query(
      `UPDATE users SET name=COALESCE($1,name), email=COALESCE($2,email), phone=COALESCE($3,phone),
       plan=COALESCE($4,plan), active=COALESCE($5,active), payment_status=COALESCE($6,payment_status),
       role=COALESCE($7,role), is_admin=COALESCE($8,is_admin),
       plan_expires_at = CASE WHEN $10::int IS NOT NULL THEN created_at + ($10 || ' days')::interval
                              ELSE COALESCE($9, plan_expires_at) END,
       updated_at=now()
       WHERE id=$11 RETURNING id, name, email, phone, plan, active, payment_status, role, is_admin, plan_expires_at`,
      [name, email, phone, plan, active, payment_status, role, is_admin, plan_expires_at,
       renewDays != null ? String(renewDays) : null, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    console.log(`[admin] usuário ${req.params.id} atualizado`);
    return res.json(result.rows[0]);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// POST /api/v1/admin/users/:id/reset-password — admin redefine a senha do usuário.
// Se vier `new_password`, usa ela; senão gera uma senha temporária e a devolve
// para o admin repassar ao usuário. Não envia email (reset manual pelo admin).
router.post('/users/:id/reset-password', adminOnly, async (req, res) => {
  const { new_password } = req.body;
  try {
    let senha = new_password;
    let gerada = false;
    if (senha) {
      if (String(senha).length < 6) {
        return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
      }
    } else {
      // Gera uma senha temporária legível (ex.: "Zt7k9Qx2")
      senha = crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
      gerada = true;
    }
    const hash = await bcrypt.hash(String(senha), 10);
    const result = await pool.query(
      `UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2 RETURNING id, email`,
      [hash, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    console.log(`[admin] senha redefinida para o usuário ${req.params.id} (${result.rows[0].email})`);
    // Só devolve a senha quando foi GERADA (pra o admin repassar). Se o admin
    // digitou, ele já a conhece — não repetimos no corpo.
    return res.json({ success: true, email: result.rows[0].email, ...(gerada ? { temporary_password: senha } : {}) });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// POST /api/v1/admin/users/:id/renew — renova o acesso do usuário por +1 ciclo
// do plano dele (semanal=7, mensal=30, anual=365 dias), reativa a conta e tira
// a suspensão. Estende a partir da validade atual se ainda estiver no futuro
// (não perde os dias que faltavam); senão, conta a partir de agora.
router.post('/users/:id/renew', async (req, res) => {
  try {
    const u = await pool.query('SELECT id, plan, plan_expires_at FROM users WHERE id=$1', [req.params.id]);
    if (u.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });

    const planRow = await pool.query('SELECT billing_period, is_free FROM plans WHERE slug=$1', [u.rows[0].plan]);
    const days = planCycleDays(planRow.rows[0] || null);

    // Base = maior entre agora e a validade atual (renovação antecipada soma).
    const result = await pool.query(
      `UPDATE users SET
         payment_status='active', active=true,
         plan_expires_at = GREATEST(COALESCE(plan_expires_at, now()), now()) + ($1 || ' days')::interval,
         updated_at=now()
       WHERE id=$2
       RETURNING id, email, plan, payment_status, plan_expires_at`,
      [String(days), req.params.id]
    );
    console.log(`[admin] acesso do usuário ${req.params.id} renovado por ${days} dias`);
    return res.json({ success: true, days, ...result.rows[0] });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// POST /api/v1/admin/users — criar novo usuário
router.post('/users', adminOnly, async (req, res) => {
  const { name, email, password, plan, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, plan, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, plan, role`,
      [name, email, hash, plan || 'starter', role || 'admin']
    );
    console.log(`[admin] usuário criado: ${email}`);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email já cadastrado' });
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/admin/users/:id — desativar usuário
router.delete('/users/:id', adminOnly, async (req, res) => {
  try {
    await pool.query('UPDATE users SET active=false, updated_at=now() WHERE id=$1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/v1/admin/invoices — listar todas as faturas
router.get('/invoices', async (req, res) => {
  // Filtros de cobrança: status, cliente, período (from/to em created_at) e
  // "só em atraso" (overdue=1 => pendentes com vencimento no passado).
  const { status, user_id, from, to, overdue } = req.query;
  try {
    let query = `SELECT i.id, i.user_id, i.plan, i.amount, i.status, i.due_date, i.paid_at,
                        i.payment_method, i.payment_gateway, i.created_at, i.updated_at,
                        u.name as user_name, u.email as user_email, u.phone as user_phone,
                        u.plan as user_plan, u.payment_status as user_payment_status,
                        p.name as plan_name, p.billing_period,
                        CASE WHEN i.status = 'pending' AND i.due_date < CURRENT_DATE
                             THEN (CURRENT_DATE - i.due_date) ELSE 0 END AS days_overdue
                 FROM invoices i
                 JOIN users u ON u.id = i.user_id
                 LEFT JOIN plans p ON p.slug = i.plan
                 WHERE 1=1`;
    const params = [];
    let idx = 1;
    if (status) { query += ` AND i.status = $${idx++}`; params.push(status); }
    if (user_id) { query += ` AND i.user_id = $${idx++}`; params.push(user_id); }
    if (from) { query += ` AND i.created_at >= $${idx++}`; params.push(from); }
    if (to) { query += ` AND i.created_at < ($${idx++}::date + interval '1 day')`; params.push(to); }
    if (overdue === '1' || overdue === 'true') {
      query += ` AND i.status = 'pending' AND i.due_date < CURRENT_DATE`;
    }
    query += ` ORDER BY i.created_at DESC LIMIT 200`;
    const result = await pool.query(query, params);

    // Resumo pra tela de cobrança (totais por situação).
    const summary = { count: result.rows.length, total_pending: 0, total_paid: 0, total_overdue: 0, overdue_count: 0 };
    for (const r of result.rows) {
      const amt = Number(r.amount) || 0;
      if (r.status === 'paid') summary.total_paid += amt;
      else if (r.status === 'pending') summary.total_pending += amt;
      if (Number(r.days_overdue) > 0) { summary.total_overdue += amt; summary.overdue_count++; }
    }
    return res.json({ invoices: result.rows, summary });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// POST /api/v1/admin/invoices — criar fatura manual
router.post('/invoices', async (req, res) => {
  const { user_id, plan, amount, due_date } = req.body;
  if (!user_id || !amount) return res.status(400).json({ error: 'Usuário e valor são obrigatórios' });
  try {
    const result = await pool.query(
      `INSERT INTO invoices (user_id, plan, amount, due_date) VALUES ($1,$2,$3,$4) RETURNING *`,
      [user_id, plan || 'pro', amount, due_date || new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0]]
    );
    console.log(`[admin] fatura criada para ${user_id}: R$ ${amount}`);
    return res.status(201).json(result.rows[0]);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// PUT /api/v1/admin/invoices/:id — atualizar status da fatura
router.put('/invoices/:id', async (req, res) => {
  const { status } = req.body;
  const ALLOWED = ['pending', 'paid', 'failed', 'cancelled'];
  if (!ALLOWED.includes(status)) return res.status(400).json({ error: 'Status inválido' });
  try {
    const result = status === 'paid'
      ? await pool.query(
          `UPDATE invoices SET status='paid', paid_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
          [req.params.id])
      : await pool.query(
          `UPDATE invoices SET status=$1, updated_at=now() WHERE id=$2 RETURNING *`,
          [status, req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Fatura não encontrada' });
    // Se pago, ativar acesso do usuário
    if (status === 'paid') {
      const invoice = result.rows[0];
      // Validade conforme o CICLO do plano (semanal=7, mensal=30, anual=365).
      const planRow = await pool.query('SELECT billing_period, is_free FROM plans WHERE slug=$1', [invoice.plan]);
      const days = planCycleDays(planRow.rows[0] || null);
      await pool.query(
        `UPDATE users SET payment_status='active', plan=$1,
         plan_expires_at=(now() + ($2 || ' days')::interval), active=true, updated_at=now()
         WHERE id=$3`,
        [invoice.plan, String(days), invoice.user_id]
      );
      console.log(`[admin] fatura ${req.params.id} paga — acesso liberado por ${days} dias (${invoice.plan})`);
    } else if (status === 'failed' || status === 'cancelled') {
      const invoice = result.rows[0];
      await pool.query(`UPDATE users SET payment_status='suspended', updated_at=now() WHERE id=$1`, [invoice.user_id]);
      console.log(`[admin] fatura ${req.params.id} ${status} — acesso suspenso`);
    }
    return res.json(result.rows[0]);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/v1/admin/settings — configurações do sistema
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM system_settings ORDER BY key ASC');
    return res.json(result.rows);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// PUT /api/v1/admin/settings/:key — atualizar configuração
router.put('/settings/:key', adminOnly, async (req, res) => {
  const { value } = req.body;
  try {
    const result = await pool.query(
      `UPDATE system_settings SET value=$1, updated_at=now() WHERE key=$2 RETURNING *`,
      [value, req.params.key]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Configuração não encontrada' });
    console.log(`[admin] config ${req.params.key} atualizada`);
    return res.json(result.rows[0]);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/v1/admin/stats — estatísticas gerais do admin (visão de decisão).
// Mantém os campos originais (users/invoices/restaurants/orders) e adiciona
// métricas novas: crescimento de clientes, MRR estimado, cobrança em atraso,
// retenção (vencendo/vencidos) e desempenho da automação.
router.get('/stats', async (req, res) => {
  const n = (v) => parseInt(v, 10) || 0;
  const f = (v) => parseFloat(v) || 0;
  try {
    const users = await pool.query(`
      SELECT
        COUNT(*)                                                          AS total,
        COUNT(*) FILTER (WHERE active)                                    AS ativos,
        COUNT(*) FILTER (WHERE NOT active)                                AS inativos,
        COUNT(*) FILTER (WHERE payment_status = 'suspended')              AS suspensos,
        COUNT(*) FILTER (WHERE role = 'gerente')                          AS gerentes,
        COUNT(*) FILTER (WHERE is_admin)                                  AS admins,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))  AS novos_mes,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now() - interval '1 month')
                           AND created_at <  date_trunc('month', now()))  AS novos_mes_anterior,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')   AS novos_semana,
        COUNT(*) FILTER (WHERE active AND NOT is_admin AND plan_expires_at IS NOT NULL
                           AND plan_expires_at >= now()
                           AND plan_expires_at <  now() + interval '7 days') AS vencendo_7d,
        COUNT(*) FILTER (WHERE active AND NOT is_admin AND plan_expires_at IS NOT NULL
                           AND plan_expires_at < now())                    AS vencidos
      FROM users`);
    const u = users.rows[0];

    const byPlan = await pool.query(`SELECT plan, COUNT(*) as total FROM users WHERE active=true GROUP BY plan ORDER BY total DESC`);

    const invoices = await pool.query(`
      SELECT
        COUNT(*)                                                                 AS total,
        COALESCE(SUM(amount) FILTER (WHERE status='paid'), 0)                     AS receita,
        COALESCE(SUM(amount) FILTER (WHERE status='paid'
                    AND paid_at >= date_trunc('month', now())), 0)               AS receita_mes,
        COALESCE(SUM(amount) FILTER (WHERE status='paid'
                    AND paid_at >= date_trunc('month', now() - interval '1 month')
                    AND paid_at <  date_trunc('month', now())), 0)               AS receita_mes_anterior,
        COUNT(*) FILTER (WHERE status='pending')                                 AS pendentes,
        COALESCE(SUM(amount) FILTER (WHERE status='pending'), 0)                 AS pendentes_valor,
        COUNT(*) FILTER (WHERE status='pending' AND due_date < CURRENT_DATE)     AS em_atraso,
        COALESCE(SUM(amount) FILTER (WHERE status='pending'
                    AND due_date < CURRENT_DATE), 0)                             AS em_atraso_valor,
        COUNT(*) FILTER (WHERE status='paid')                                    AS pagas
      FROM invoices`);
    const inv = invoices.rows[0];

    // MRR estimado: normaliza o preço do plano pelo ciclo (semanal ~4.33/mês,
    // mensal x1, anual /12) dos assinantes ATIVOS e pagantes (fora admin/free).
    const mrr = await pool.query(`
      SELECT
        COALESCE(SUM(CASE p.billing_period
          WHEN 'weekly' THEN p.price * 4.33
          WHEN 'yearly' THEN p.price / 12.0
          WHEN 'one_time' THEN 0
          ELSE p.price END), 0)                          AS mrr,
        COUNT(*)                                          AS assinantes_pagantes
      FROM users us JOIN plans p ON p.slug = us.plan
      WHERE us.active = true AND us.is_admin = false
        AND COALESCE(p.is_free, false) = false
        AND us.payment_status = 'active'`);

    const restaurants = await pool.query(`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now())) AS novos_mes
      FROM restaurants WHERE active=true`);

    let plat = { ifood: 0, food99: 0 };
    try {
      const p = await pool.query(`
        SELECT COUNT(*) FILTER (WHERE status='authorized' AND platform='ifood')  AS ifood,
               COUNT(*) FILTER (WHERE status='authorized' AND platform='99food') AS food99
        FROM restaurant_platforms`);
      plat = { ifood: n(p.rows[0].ifood), food99: n(p.rows[0].food99) };
    } catch (e) { /* tabela pode não existir em algum ambiente */ }

    const orders = await pool.query(`
      SELECT COUNT(*)                                                        AS total,
             COALESCE(SUM(total_price), 0)                                   AS gmv,
             COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now())) AS pedidos_mes,
             COALESCE(SUM(total_price) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS gmv_mes,
             COUNT(*) FILTER (WHERE DATE(created_at AT TIME ZONE 'America/Sao_Paulo')
                                  = DATE(now() AT TIME ZONE 'America/Sao_Paulo')) AS pedidos_hoje,
             COUNT(*) FILTER (WHERE status='cancelled')                      AS cancelados
      FROM orders`);
    const o = orders.rows[0];

    // Desempenho da automação: quantos pedidos foram marcados "pronto" pela
    // nossa API (coluna carimbada). Tolerante a ambiente sem a coluna ainda.
    let automatizados = 0, automatizados_mes = 0;
    try {
      const a = await pool.query(`
        SELECT COUNT(*) FILTER (WHERE automation_ready_at IS NOT NULL) AS auto,
               COUNT(*) FILTER (WHERE automation_ready_at IS NOT NULL
                                 AND automation_ready_at >= date_trunc('month', now())) AS auto_mes
        FROM orders`);
      automatizados = n(a.rows[0].auto); automatizados_mes = n(a.rows[0].auto_mes);
    } catch (e) { /* coluna automation_ready_at pode não existir */ }

    const receitaMes = f(inv.receita_mes), receitaMesAnt = f(inv.receita_mes_anterior);
    const crescimentoReceita = receitaMesAnt > 0
      ? Math.round(((receitaMes - receitaMesAnt) / receitaMesAnt) * 100)
      : (receitaMes > 0 ? 100 : 0);
    const pedidosMes = n(o.pedidos_mes);
    const taxaAutomacaoMes = pedidosMes > 0 ? Math.round((automatizados_mes / pedidosMes) * 100) : 0;

    return res.json({
      // --- campos originais (compatibilidade) ---
      users: { total: n(u.total), ativos: n(u.ativos), por_plano: byPlan.rows },
      invoices: { total: n(inv.total), receita: f(inv.receita), pendentes: n(inv.pendentes), pagas: n(inv.pagas) },
      restaurants: n(restaurants.rows[0].total),
      orders: { total: n(o.total), gmv: f(o.gmv) },

      // --- novas métricas de decisão ---
      clientes: {
        total: n(u.total), ativos: n(u.ativos), inativos: n(u.inativos),
        suspensos: n(u.suspensos), gerentes: n(u.gerentes), admins: n(u.admins),
        novos_mes: n(u.novos_mes), novos_mes_anterior: n(u.novos_mes_anterior),
        novos_semana: n(u.novos_semana),
        vencendo_7d: n(u.vencendo_7d), vencidos: n(u.vencidos),
        por_plano: byPlan.rows,
      },
      financeiro: {
        receita_total: f(inv.receita),
        receita_mes: receitaMes,
        receita_mes_anterior: receitaMesAnt,
        crescimento_receita_pct: crescimentoReceita,
        mrr_estimado: Math.round(f(mrr.rows[0].mrr) * 100) / 100,
        assinantes_pagantes: n(mrr.rows[0].assinantes_pagantes),
        faturas_pendentes: n(inv.pendentes),
        pendentes_valor: f(inv.pendentes_valor),
        em_atraso: n(inv.em_atraso),
        em_atraso_valor: f(inv.em_atraso_valor),
      },
      operacao: {
        restaurantes: n(restaurants.rows[0].total),
        restaurantes_novos_mes: n(restaurants.rows[0].novos_mes),
        lojas_ifood: plat.ifood,
        lojas_99food: plat.food99,
        pedidos_total: n(o.total),
        pedidos_mes: pedidosMes,
        pedidos_hoje: n(o.pedidos_hoje),
        cancelados: n(o.cancelados),
        gmv_total: f(o.gmv),
        gmv_mes: f(o.gmv_mes),
        automatizados_total: automatizados,
        automatizados_mes: automatizados_mes,
        taxa_automacao_mes_pct: taxaAutomacaoMes,
      },
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/v1/admin/audit — auditoria de acesso: quantos cadastros existem,
// quando cada um foi criado e quantas lojas cada usuário tem CONECTADAS
// (status 'authorized'), separando iFood e 99food. Só admin (router.use acima).
router.get('/audit', async (req, res) => {
  try {
    const users = await pool.query(
      `SELECT u.id, u.name, u.email, u.plan, u.active, u.is_admin,
              u.payment_status, u.created_at,
              u.plan_expires_at,
              p.billing_period,
              COALESCE(s.stores, 0)  AS stores_connected,
              COALESCE(s.ifood, 0)   AS ifood_stores,
              COALESCE(s.food99, 0)  AS food99_stores,
              o.last_order_at,
              COALESCE(o.orders_total, 0) AS orders_total
       FROM users u
       LEFT JOIN plans p ON p.slug = u.plan
       LEFT JOIN (
         SELECT user_id,
                COUNT(*) FILTER (WHERE status = 'authorized')                       AS stores,
                COUNT(*) FILTER (WHERE status = 'authorized' AND platform = 'ifood')  AS ifood,
                COUNT(*) FILTER (WHERE status = 'authorized' AND platform = '99food') AS food99
         FROM restaurant_platforms
         GROUP BY user_id
       ) s ON s.user_id = u.id
       LEFT JOIN (
         SELECT user_id, MAX(created_at) AS last_order_at, COUNT(*) AS orders_total
         FROM orders GROUP BY user_id
       ) o ON o.user_id = u.id
       ORDER BY u.created_at DESC`
    );

    // Janela de aviso: a partir de quantos dias antes do vencimento marcamos
    // como "vencendo" (padrão 3, ajustável por env AUDIT_EXPIRING_DAYS).
    const avisoDias = Number(process.env.AUDIT_EXPIRING_DAYS) > 0 ? Number(process.env.AUDIT_EXPIRING_DAYS) : 3;
    const agora = Date.now();

    // Calcula, por usuário: dias restantes e situação (ok/vencendo/vencido).
    // Admin e conta sem validade não entram no aviso.
    const withStatus = users.rows.map(u => {
      let days_until_expiry = null;
      let expiry_status = 'sem_validade'; // sem data (ex.: admin/free permanente)
      if (u.plan_expires_at && !u.is_admin) {
        const diffMs = new Date(u.plan_expires_at).getTime() - agora;
        days_until_expiry = Math.ceil(diffMs / 86400000);
        if (days_until_expiry < 0) expiry_status = 'vencido';
        else if (days_until_expiry <= avisoDias) expiry_status = 'vencendo';
        else expiry_status = 'ok';
      }
      return {
        ...u,
        stores_connected: Number(u.stores_connected),
        ifood_stores: Number(u.ifood_stores),
        food99_stores: Number(u.food99_stores),
        orders_total: Number(u.orders_total),
        days_until_expiry,
        expiry_status,
      };
    });

    const totals = withStatus.reduce((acc, u) => {
      acc.users += 1;
      if (u.active) acc.active_users += 1;
      acc.stores_connected += u.stores_connected;
      acc.ifood_stores += u.ifood_stores;
      acc.food99_stores += u.food99_stores;
      if (u.expiry_status === 'vencendo') acc.expiring_soon += 1;
      if (u.expiry_status === 'vencido') acc.expired += 1;
      return acc;
    }, { users: 0, active_users: 0, stores_connected: 0, ifood_stores: 0, food99_stores: 0, expiring_soon: 0, expired: 0 });

    return res.json({ summary: totals, warning_days: avisoDias, users: withStatus });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// POST /api/v1/admin/recalculate-expiry — recalcula a validade de TODOS os
// clientes (não-admin) de uma vez: plan_expires_at = data de criação + ciclo do
// plano (semanal=7, mensal=30, anual=365). Útil pra alinhar todo mundo à regra
// depois de trocar planos em massa. Não mexe em payment_status.
router.post('/recalculate-expiry', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users u
          SET plan_expires_at = u.created_at + ((CASE
                WHEN p.is_free                                                THEN $1::int
                WHEN lower(p.billing_period) IN ('weekly','semanal')          THEN 7
                WHEN lower(p.billing_period) IN ('yearly','anual','annual')   THEN 365
                ELSE 30 END)::text || ' days')::interval,
              updated_at = now()
         FROM plans p
        WHERE p.slug = u.plan AND u.is_admin = false
      RETURNING u.id`,
      [trialDays()]
    );
    console.log(`[admin] validades recalculadas para ${result.rowCount} usuário(s)`);
    return res.json({ success: true, updated: result.rowCount });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/v1/admin/notifications — alimenta o sininho do painel admin.
// Junta avisos úteis: usuários vencidos, vencendo, novos cadastros do dia e
// faturas pendentes. Só admin.
router.get('/notifications', async (req, res) => {
  try {
    const avisoDias = Number(process.env.AUDIT_EXPIRING_DAYS) > 0 ? Number(process.env.AUDIT_EXPIRING_DAYS) : 3;

    const venc = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE plan_expires_at < now())::int AS vencidos,
         COUNT(*) FILTER (WHERE plan_expires_at >= now()
                            AND plan_expires_at < now() + ($1 || ' days')::interval)::int AS vencendo
       FROM users
       WHERE is_admin = false AND active = true AND plan_expires_at IS NOT NULL`,
      [String(avisoDias)]
    );
    const novos = await pool.query(
      `SELECT COUNT(*)::int AS n FROM users
        WHERE DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = DATE(now() AT TIME ZONE 'America/Sao_Paulo')`
    );
    const faturas = await pool.query(`SELECT COUNT(*)::int AS n FROM invoices WHERE status = 'pending'`);

    const v = venc.rows[0];
    const notifications = [];
    if (v.vencidos > 0) notifications.push({
      type: 'plan_expired', severity: 'high',
      title: 'Clientes com plano vencido',
      message: `${v.vencidos} cliente(s) com o plano vencido`,
      count: v.vencidos, link: '/admin?tab=auditoria',
    });
    if (v.vencendo > 0) notifications.push({
      type: 'plan_expiring', severity: 'medium',
      title: 'Clientes vencendo em breve',
      message: `${v.vencendo} cliente(s) vencem em até ${avisoDias} dia(s)`,
      count: v.vencendo, link: '/admin?tab=auditoria',
    });
    if (faturas.rows[0].n > 0) notifications.push({
      type: 'invoice_pending', severity: 'medium',
      title: 'Faturas pendentes',
      message: `${faturas.rows[0].n} fatura(s) aguardando pagamento`,
      count: faturas.rows[0].n, link: '/admin?tab=faturas',
    });
    if (novos.rows[0].n > 0) notifications.push({
      type: 'new_signups', severity: 'info',
      title: 'Novos cadastros hoje',
      message: `${novos.rows[0].n} novo(s) cadastro(s) hoje`,
      count: novos.rows[0].n, link: '/admin?tab=usuarios',
    });

    return res.json({ unread_count: notifications.length, notifications });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

module.exports = router;
