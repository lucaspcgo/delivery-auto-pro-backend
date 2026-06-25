const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db/postgres');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'delivery-auto-pro-secret-2026';

// Middleware auth opcional (pode ser acessado sem login para novos usuários)
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    } catch (err) { req.user = null; }
  }
  next();
}

// GET /api/v1/checkout/plans — lista planos disponíveis com preços
router.get('/plans', async (req, res) => {
  try {
    const settings = await pool.query(
      `SELECT key, value FROM system_settings WHERE key LIKE 'plan_%_price'`
    );
    const plans = [
      {
        id: 'starter',
        name: 'Starter',
        price: parseFloat(settings.rows.find(s => s.key === 'plan_starter_price')?.value || '99'),
        features: ['1 loja', '300 pedidos/mês', 'Integrações básicas', 'Suporte por email']
      },
      {
        id: 'pro',
        name: 'Pro',
        popular: true,
        price: parseFloat(settings.rows.find(s => s.key === 'plan_pro_price')?.value || '249'),
        features: ['5 lojas', 'Pedidos ilimitados', 'Todas as automações', 'Suporte prioritário', 'Relatórios avançados']
      },
      {
        id: 'enterprise',
        name: 'Enterprise',
        price: 0,
        custom: true,
        features: ['Lojas ilimitadas', 'API dedicada', 'Gerente de conta', 'SLA garantido', 'Personalização completa']
      }
    ];
    return res.json(plans);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/checkout/create — cria fatura e retorna link de pagamento
router.post('/create', optionalAuth, async (req, res) => {
  const { plan, name, email, password } = req.body;
  if (!plan) return res.status(400).json({ error: 'Plano é obrigatório' });

  try {
    let userId;

    // Se já logado, usa o usuário atual
    if (req.user) {
      userId = req.user.id;
    } else {
      // Novo usuário — precisa de nome, email e senha
      if (!name || !email || !password) {
        return res.status(400).json({ error: 'Nome, email e senha são obrigatórios para novos usuários' });
      }
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash(password, 10);
      const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Email já cadastrado. Faça login primeiro.' });
      }
      const newUser = await pool.query(
        `INSERT INTO users (name, email, password_hash, plan, payment_status)
         VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
        [name, email, hash, plan]
      );
      userId = newUser.rows[0].id;
      console.log(`[checkout] novo usuário criado: ${email}`);
    }

    // Busca preço do plano
    const priceRow = await pool.query(
      `SELECT value FROM system_settings WHERE key = $1`,
      [`plan_${plan}_price`]
    );
    const amount = parseFloat(priceRow.rows[0]?.value || '0');

    if (plan === 'enterprise') {
      return res.json({
        type: 'contact',
        message: 'Para o plano Enterprise, entre em contato conosco.',
        user_id: userId
      });
    }

    // Cria fatura
    const dueDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const invoice = await pool.query(
      `INSERT INTO invoices (user_id, plan, amount, due_date, payment_method, payment_gateway)
       VALUES ($1, $2, $3, $4, 'pix', 'mercadopago') RETURNING *`,
      [userId, plan, amount, dueDate]
    );

    // Busca config do gateway
    const gateway = await pool.query(
      `SELECT key, value FROM system_settings WHERE key IN ('payment_gateway','mp_access_token','stripe_secret_key')`
    );
    const gatewayConfig = {};
    gateway.rows.forEach(r => { gatewayConfig[r.key] = r.value; });

    console.log(`[checkout] fatura criada: R$ ${amount} (${plan}) para user ${userId}`);

    return res.json({
      type: 'payment',
      invoice: invoice.rows[0],
      amount,
      plan,
      user_id: userId,
      gateway: gatewayConfig.payment_gateway || 'mercadopago',
      // Em produção, aqui geraria o link de pagamento real do Mercado Pago/Stripe
      payment_url: null
    });
  } catch (err) {
    console.error('[checkout] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/checkout/confirm — confirma pagamento (webhook do gateway ou manual)
router.post('/confirm', async (req, res) => {
  const { invoice_id, gateway_transaction_id } = req.body;
  if (!invoice_id) return res.status(400).json({ error: 'ID da fatura é obrigatório' });

  try {
    const invoice = await pool.query('SELECT * FROM invoices WHERE id=$1', [invoice_id]);
    if (invoice.rows.length === 0) return res.status(404).json({ error: 'Fatura não encontrada' });

    const inv = invoice.rows[0];
    if (inv.status === 'paid') return res.json({ success: true, message: 'Fatura já paga', already_paid: true });

    // Marca fatura como paga
    await pool.query(
      `UPDATE invoices SET status='paid', paid_at=now(), gateway_transaction_id=$1, updated_at=now()
       WHERE id=$2`,
      [gateway_transaction_id || 'manual', invoice_id]
    );

    // Libera acesso do usuário
    await pool.query(
      `UPDATE users SET plan=$1, payment_status='active',
       plan_expires_at=(now() + INTERVAL '30 days'), active=true, updated_at=now()
       WHERE id=$2`,
      [inv.plan, inv.user_id]
    );

    console.log(`[checkout] pagamento confirmado — fatura ${invoice_id}, user ${inv.user_id}, plano ${inv.plan}`);

    // Gera token de login para o usuário (auto-login após pagamento)
    const user = await pool.query('SELECT * FROM users WHERE id=$1', [inv.user_id]);
    const u = user.rows[0];
    const token = jwt.sign(
      { id: u.id, email: u.email, name: u.name, role: u.role, is_admin: u.is_admin, plan: u.plan },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.json({
      success: true,
      message: 'Pagamento confirmado! Acesso liberado.',
      token,
      user: { id: u.id, name: u.name, email: u.email, role: u.role, plan: u.plan, is_admin: u.is_admin }
    });
  } catch (err) {
    console.error('[checkout] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/checkout/status/:invoiceId — verifica status de pagamento
router.get('/status/:invoiceId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.*, u.name as user_name, u.email as user_email, u.payment_status
       FROM invoices i JOIN users u ON u.id = i.user_id WHERE i.id=$1`,
      [req.params.invoiceId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Fatura não encontrada' });
    return res.json(result.rows[0]);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

module.exports = router;
