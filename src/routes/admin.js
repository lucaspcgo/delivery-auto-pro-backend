const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/postgres');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'delivery-auto-pro-secret-2026';

// Middleware admin
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.is_admin) return res.status(403).json({ error: 'Acesso negado — apenas administradores' });
    req.user = decoded;
    next();
  } catch (err) { return res.status(401).json({ error: 'Token inválido' }); }
}

router.use(adminAuth);

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
  const { name, email, plan, active, payment_status, role, is_admin, plan_expires_at } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users SET name=COALESCE($1,name), email=COALESCE($2,email), plan=COALESCE($3,plan),
       active=COALESCE($4,active), payment_status=COALESCE($5,payment_status), role=COALESCE($6,role),
       is_admin=COALESCE($7,is_admin), plan_expires_at=COALESCE($8,plan_expires_at), updated_at=now()
       WHERE id=$9 RETURNING id, name, email, plan, active, payment_status, role, is_admin`,
      [name, email, plan, active, payment_status, role, is_admin, plan_expires_at, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    console.log(`[admin] usuário ${req.params.id} atualizado`);
    return res.json(result.rows[0]);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// POST /api/v1/admin/users — criar novo usuário
router.post('/users', async (req, res) => {
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
router.delete('/users/:id', async (req, res) => {
  try {
    await pool.query('UPDATE users SET active=false, updated_at=now() WHERE id=$1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/v1/admin/invoices — listar todas as faturas
router.get('/invoices', async (req, res) => {
  const { status, user_id } = req.query;
  try {
    let query = `SELECT i.*, u.name as user_name, u.email as user_email, u.plan as user_plan
                 FROM invoices i JOIN users u ON u.id = i.user_id WHERE 1=1`;
    const params = [];
    let idx = 1;
    if (status) { query += ` AND i.status = $${idx++}`; params.push(status); }
    if (user_id) { query += ` AND i.user_id = $${idx++}`; params.push(user_id); }
    query += ` ORDER BY i.created_at DESC LIMIT 100`;
    const result = await pool.query(query, params);
    return res.json(result.rows);
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
  try {
    const updates = status === 'paid'
      ? `status='paid', paid_at=now(), updated_at=now()`
      : `status='${status}', updated_at=now()`;
    const result = await pool.query(
      `UPDATE invoices SET ${updates} WHERE id=$1 RETURNING *`, [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Fatura não encontrada' });
    // Se pago, ativar acesso do usuário
    if (status === 'paid') {
      const invoice = result.rows[0];
      await pool.query(
        `UPDATE users SET payment_status='active', plan=$1,
         plan_expires_at=(now() + INTERVAL '30 days'), updated_at=now()
         WHERE id=$2`,
        [invoice.plan, invoice.user_id]
      );
      console.log(`[admin] fatura ${req.params.id} paga — acesso liberado`);
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
router.put('/settings/:key', async (req, res) => {
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

// GET /api/v1/admin/stats — estatísticas gerais do admin
router.get('/stats', async (req, res) => {
  try {
    const users = await pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN active THEN 1 END) as ativos FROM users`);
    const byPlan = await pool.query(`SELECT plan, COUNT(*) as total FROM users WHERE active=true GROUP BY plan`);
    const invoices = await pool.query(
      `SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN status='paid' THEN amount END),0) as receita,
       COUNT(CASE WHEN status='pending' THEN 1 END) as pendentes,
       COUNT(CASE WHEN status='paid' THEN 1 END) as pagas
       FROM invoices`
    );
    const restaurants = await pool.query(`SELECT COUNT(*) as total FROM restaurants WHERE active=true`);
    const orders = await pool.query(`SELECT COUNT(*) as total, COALESCE(SUM(total_price),0) as gmv FROM orders`);
    return res.json({
      users: { total: parseInt(users.rows[0].total), ativos: parseInt(users.rows[0].ativos), por_plano: byPlan.rows },
      invoices: { total: parseInt(invoices.rows[0].total), receita: parseFloat(invoices.rows[0].receita), pendentes: parseInt(invoices.rows[0].pendentes), pagas: parseInt(invoices.rows[0].pagas) },
      restaurants: parseInt(restaurants.rows[0].total),
      orders: { total: parseInt(orders.rows[0].total), gmv: parseFloat(orders.rows[0].gmv) }
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

module.exports = router;
