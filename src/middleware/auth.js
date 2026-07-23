const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const { isPlanGatingEnabled } = require('../config/featureFlags');
const { checkUserAccess } = require('../services/accessControl');

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = {
      id: decoded.id,
      email: decoded.email,
      is_admin: decoded.is_admin || false,
      plan: decoded.plan,
      role: decoded.role
    };

    // Corte de acesso EM TEMPO REAL: reconfere no banco se a conta foi
    // desativada/suspensa ou se o plano venceu (respeita o ciclo do plano).
    // Assim, desativar no admin derruba o usuário no próximo clique — não
    // espera o token de 30 dias vencer. Só roda com a flag ligada.
    if (isPlanGatingEnabled()) {
      try {
        const { blocked, reason } = await checkUserAccess(decoded.id);
        if (blocked) {
          return res.status(403).json({ error: reason, access_blocked: true, redirect: '/checkout' });
        }
      } catch (e) {
        // Na dúvida (falha de banco), NÃO derruba o usuário por engano.
        console.warn('[auth] checagem de acesso falhou (liberando):', e.message);
      }
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};

const requireAdmin = (req, res, next) => {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
  }
  next();
};

// Equipe = admin OU gerente. Libera o Painel Administrativo (ver usuários,
// auditoria, faturas/cobrança). As ações sensíveis (planos, perfis, exclusão)
// continuam protegidas por requireAdmin.
const requireStaff = (req, res, next) => {
  if (!req.user || (!req.user.is_admin && req.user.role !== 'gerente')) {
    return res.status(403).json({ error: 'Acesso negado. Apenas equipe (gerente ou admin).' });
  }
  next();
};

module.exports = {
  authenticateToken,
  requireAdmin,
  requireStaff
};