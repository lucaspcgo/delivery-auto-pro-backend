const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'delivery-auto-pro-secret-2026';

const authenticateToken = (req, res, next) => {
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
      is_admin: decoded.is_admin || false
    };
    
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

module.exports = {
  authenticateToken,
  requireAdmin
};