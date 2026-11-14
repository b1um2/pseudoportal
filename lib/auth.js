const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(stored, password) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== test.length) return false;
  return crypto.timingSafeEqual(expected, test);
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== role) {
      return res.status(403).render('error', {
        title: 'Forbidden',
        message: 'This page is for a different role.'
      });
    }
    next();
  };
}

function requireAgentKey(req, res, next) {
  const key = process.env.AGENT_API_KEY || 'dev-agent-key';
  if (req.get('x-api-key') !== key) {
    return res.status(401).json({ error: 'invalid api key' });
  }
  next();
}

function requireDashboardKey(req, res, next) {
  const key = process.env.AGENT_DASHBOARD_KEY || 'dev-dashboard-key';
  if (req.get('x-dashboard-key') !== key) {
    return res.status(401).json({ error: 'invalid dashboard key' });
  }
  next();
}


function requireAnyRole(roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', {
        title: 'Forbidden',
        message: 'This page is for a different role.'
      });
    }
    next();
  };
}

module.exports = { hashPassword, verifyPassword, requireRole, requireAnyRole, requireAgentKey, requireDashboardKey };
