const { signGrant } = require('../lib/grant');

function value(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const payload = {
  actor_id: Number(value('actor', 1)),
  role: value('role', 'advisor'),
  object_type: value('type', 'form'),
  object_id: Number(value('id', 1)),
  action: value('action', 'accept'),
  exp: Math.floor(Date.now() / 1000) + 120
};

console.log(signGrant(payload));
