const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/postgres');
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'delivery-auto-pro-secret-2026';

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1 AND active = true', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou senha inválidos' });
    }
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email ou senha inválidos' });
    }
    // Verificar se o pagamento está suspenso
    if (user.payment_status === 'suspended') {
      return res.status(403).json({ error: 'Acesso suspenso. Regularize seu pagamento.', payment_suspended: true });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, is_admin: user.is_admin, plan: user.plan },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    console.log(`[auth] login: ${user.email} (${user.role}, admin: ${user.is_admin}, plano: ${user.plan})`);
    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, is_admin: user.is_admin, plan: user.plan, payment_status: user.payment_status }
    });
  } catch (err) {
    console.error('[auth] erro:', err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    return res.json({ user: { id: decoded.id, name: decoded.name, email: decoded.email, role: decoded.role, is_admin: decoded.is_admin, plan: decoded.plan } });
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
});

module.exports = router;
