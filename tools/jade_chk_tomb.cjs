/* 校验：三块金沙种是否已在 arch.ids 墓碑名单里 + stones 是否干净 */
const mqtt = require('mqtt');
const PREFIX = 'lovesite-sj-ych-9f7e2/';
const TARGETS = [
  'brick-油菜花-mvgtlydq-b7122',
  'brick-油菜花-mvgtm52t-xaaup',
  'brick-油菜花-mvgtm8z6-no4tw',
];
const client = mqtt.connect('wss://mqtt.sanjin-youchaihua.top/mqtt', {
  username: 'lovesite', password: 'Ls-9f7e2-mqtt-Xk72Qp',
  clientId: 'chk-tomb-' + Math.random().toString(36).slice(2, 8),
  clean: true, connectTimeout: 15000, reconnectPeriod: 3000,
});
let jade = null;
client.on('connect', () => { client.subscribe([PREFIX + 'jade/state'], { qos: 1 }); });
client.on('message', (t, p) => { if (t === PREFIX + 'jade/state' && p.length > 100000) jade = p; });
setTimeout(() => { if (!jade) { console.log('NO JADE'); process.exit(1); } run(); }, 18000);

function run() {
  const j = JSON.parse(jade.toString());
  const tomb = new Set((j.arch && j.arch.ids) || []);
  for (const id of TARGETS) {
    console.log(id.slice(-14), 'tombstoned=', tomb.has(id), 'stillAlive=', id in (j.stones || {}));
  }
  console.log('v=', j.v, 'archIds=', (j.arch && j.arch.ids || []).length);
  process.exit(0);
}
