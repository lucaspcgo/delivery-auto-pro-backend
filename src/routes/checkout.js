const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('../db/postgres');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'delivery-auto-pro-secret-2026';

function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try { req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET); } catch (err) { req.user = null; }
  }
  next();
}

// GET /api/v1/checkout/plans
router.get('/plans', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, slug, name, price, billing_period, popular, is_free, max_restaurants, max_orders_month, features, sort_order
       FROM plans WHERE active = true ORDER BY sort_order ASC`
    );
    return res.json(result.rows);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// POST /api/v1/checkout/create
router.post('/create', optionalAuth, async (req, res) => {
  const { plan, name, email, password } = req.body;
  if (!plan) return res.status(400).json({ error: 'Plano é obrigatório' });

  try {
    // Busca dados do plano
    const planData = await pool.query('SELECT * FROM plans WHERE slug=$1 AND active=true', [plan]);
    if (planData.rows.length === 0) return res.status(400).json({ error: 'Plano não encontrado' });
    const selectedPlan = planData.rows[0];

    let userId;

    if (req.user) {
      userId = req.user.id;
    } else {
      if (!name || !email || !password) {
        return res.status(400).json({ error: 'Nome, email e senha são obrigatórios para novos usuários' });
      }

      // Verificar se email já existe
      const existing = await pool.query('SELECT id, plan, plan_expires_at, payment_status FROM users WHERE email=$1', [email]);
      if (existing.rows.length > 0) {
        const existingUser = existing.rows[0];
        // Verificar se já usou trial gratuito
        if (selectedPlan.is_free) {
          return res.status(400).json({ error: 'Este email já foi utilizado. O período gratuito é válido apenas uma vez. Escolha um plano pago para continuar.' });
        }
        return res.status(400).json({ error: 'Email já cadastrado. Faça login primeiro.' });
      }

      const hash = await bcrypt.hash(password, 10);

      if (selectedPlan.is_free) {
        // Plano gratuito: criar com trial de 7 dias
        // Criar dados padrão para o novo usuário
        await pool.query('SELECT create_user_defaults($1)', [u.id]);
        console.log(`[checkout] dados padrão criados para ${email}`);
        const newUser = await pool.query(
          `INSERT INTO users (name, email, password_hash, plan, payment_status, plan_expires_at)
           VALUES ($1, $2, $3, $4, 'active', now() + INTERVAL '7 days') RETURNING *`,
          [name, email, hash, plan]
        );
        const u = newUser.rows[0];
        const token = jwt.sign(
          { id: u.id, email: u.email, name: u.name, role: u.role, is_admin: u.is_admin, plan: u.plan },
          JWT_SECRET, { expiresIn: '24h' }
        );
        console.log(`[checkout] trial gratuito criado: ${email} (expira em 7 dias)`);
        return res.json({
          type: 'free_trial',
          success: true,
          message: 'Conta gratuita criada! Você tem 7 dias para testar.',
          expires_at: u.plan_expires_at,
          token,
          user: { id: u.id, name: u.name, email: u.email, role: u.role, plan: u.plan, is_admin: u.is_admin, payment_status: 'active' }
        });
      }

      const newUser = await pool.query(
        `INSERT INTO users (name, email, password_hash, plan, payment_status)
         VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
        [name, email, hash, plan]
      );
      userId = newUser.rows[0].id;
      console.log(`[checkout] novo usuário criado: ${email}`);
    }

    const amount = selectedPlan.price;

    if (selectedPlan.slug === 'enterprise') {
      return res.json({ type: 'contact', message: 'Para o plano Enterprise, entre em contato conosco.', user_id: userId });
    }

    const dueDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const invoice = await pool.query(
      `INSERT INTO invoices (user_id, plan, amount, due_date, payment_method, payment_gateway)
       VALUES ($1, $2, $3, $4, 'pix', 'mercadopago') RETURNING *`,
      [userId, plan, amount, dueDate]
    );

    console.log(`[checkout] fatura criada: R$ ${amount} (${plan}) para user ${userId}`);
    // Criar dados padrão para o novo usuário
      await pool.query('SELECT create_user_defaults($1)', [userId]);
      console.log(`[checkout] dados padrão criados para ${email}`);
    return res.json({ type: 'payment', invoice: invoice.rows[0], amount, plan, user_id: userId });
  } catch (err) {
    console.error('[checkout] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/checkout/confirm
router.post('/confirm', async (req, res) => {
  const { invoice_id, gateway_transaction_id } = req.body;
  if (!invoice_id) return res.status(400).json({ error: 'ID da fatura é obrigatório' });
  try {
    const invoice = await pool.query('SELECT * FROM invoices WHERE id=$1', [invoice_id]);
    if (invoice.rows.length === 0) return res.status(404).json({ error: 'Fatura não encontrada' });
    const inv = invoice.rows[0];
    if (inv.status === 'paid') return res.json({ success: true, message: 'Fatura já paga', already_paid: true });
    await pool.query(
      `UPDATE invoices SET status='paid', paid_at=now(), gateway_transaction_id=$1, updated_at=now() WHERE id=$2`,
      [gateway_transaction_id || 'manual', invoice_id]
    );
    await pool.query(
      `UPDATE users SET plan=$1, payment_status='active', plan_expires_at=(now() + INTERVAL '30 days'), active=true, updated_at=now() WHERE id=$2`,
      [inv.plan, inv.user_id]
    );
    console.log(`[checkout] pagamento confirmado — fatura ${invoice_id}, user ${inv.user_id}, plano ${inv.plan}`);
    const user = await pool.query('SELECT * FROM users WHERE id=$1', [inv.user_id]);
    const u = user.rows[0];
    const token = jwt.sign(
      { id: u.id, email: u.email, name: u.name, role: u.role, is_admin: u.is_admin, plan: u.plan },
      JWT_SECRET, { expiresIn: '24h' }
    );
    return res.json({
      success: true, message: 'Pagamento confirmado! Acesso liberado.', token,
      user: { id: u.id, name: u.name, email: u.email, role: u.role, plan: u.plan, is_admin: u.is_admin }
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// GET /api/v1/checkout/status/:invoiceId
router.get('/status/:invoiceId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.*, u.name as user_name, u.email as user_email, u.payment_status
       FROM invoices i JOIN users u ON u.id = i.user_id WHERE i.id=$1`, [req.params.invoiceId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Fatura não encontrada' });
    return res.json(result.rows[0]);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

module.exports = router;
