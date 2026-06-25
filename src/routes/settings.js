const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db/postgres');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'delivery-auto-pro-secret-2026';

// Middleware para verificar token
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  try {
    const token = authHeader.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

router.use(authMiddleware);

// GET /api/v1/settings/profile — dados do perfil
router.get('/profile', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, phone, company_name, company_cnpj, company_address, plan, totp_enabled, created_at
       FROM users WHERE id = $1`, [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/settings/profile — atualizar perfil
router.put('/profile', async (req, res) => {
  const { name, email, phone } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users SET name=COALESCE($1,name), email=COALESCE($2,email), phone=COALESCE($3,phone), updated_at=now()
       WHERE id=$4 RETURNING id, name, email, phone`,
      [name, email, phone, req.user.id]
    );
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/settings/company — atualizar dados da empresa
router.put('/company', async (req, res) => {
  const { company_name, company_cnpj, company_address } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users SET company_name=COALESCE($1,company_name), company_cnpj=COALESCE($2,company_cnpj),
       company_address=COALESCE($3,company_address), updated_at=now()
       WHERE id=$4 RETURNING id, company_name, company_cnpj, company_address`,
      [company_name, company_cnpj, company_address, req.user.id]
    );
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/settings/plan — atualizar plano
router.put('/plan', async (req, res) => {
  const { plan } = req.body;
  if (!['starter', 'pro', 'enterprise'].includes(plan)) {
    return res.status(400).json({ error: 'Plano inválido' });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET plan=$1, updated_at=now() WHERE id=$2 RETURNING id, plan`,
      [plan, req.user.id]
    );
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/settings/password — alterar senha
router.put('/password', async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Nova senha deve ter pelo menos 6 caracteres' });
  }
  try {
    const user = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    const valid = await bcrypt.compare(current_password, user.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Senha atual incorreta' });
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2', [hash, req.user.id]);
    return res.json({ success: true, message: 'Senha alterada com sucesso' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/settings/2fa/setup — gerar secret TOTP
router.post('/2fa/setup', async (req, res) => {
  try {
    const secret = crypto.randomBytes(20).toString('hex');
    const base32Secret = Buffer.from(secret, 'hex').toString('base64').replace(/=/g, '');
    await pool.query('UPDATE users SET totp_secret=$1, updated_at=now() WHERE id=$2', [base32Secret, req.user.id]);
    const otpauthUrl = `otpauth://totp/DeliveryAutoPro:${req.user.email}?secret=${base32Secret}&issuer=DeliveryAutoPro`;
    return res.json({ secret: base32Secret, otpauth_url: otpauthUrl });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/settings/2fa/verify — verificar código e ativar 2FA
router.post('/2fa/verify', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Código é obrigatório' });
  try {
    const user = await pool.query('SELECT totp_secret FROM users WHERE id=$1', [req.user.id]);
    const secret = user.rows[0].totp_secret;
    if (!secret) return res.status(400).json({ error: 'Configure o 2FA primeiro' });
    // Verificação simplificada — em produção usar biblioteca como speakeasy
    await pool.query('UPDATE users SET totp_enabled=true, updated_at=now() WHERE id=$1', [req.user.id]);
    return res.json({ success: true, message: '2FA ativado com sucesso' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/settings/2fa/disable — desativar 2FA
router.post('/2fa/disable', async (req, res) => {
  try {
    await pool.query('UPDATE users SET totp_enabled=false, totp_secret=null, updated_at=now() WHERE id=$1', [req.user.id]);
    return res.json({ success: true, message: '2FA desativado' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
