// #366 组 gun 子进程：与主进程完全隔离，避免同进程 Gun 实例互串导致分片白切。
const Gun = require('gun');
const peer = process.argv[2];
if (!peer) { console.error('[group-gun] missing peer'); process.exit(1); }

const gun = Gun({ peers: [peer], radisk: false, localStorage: false, axe: false, multicast: false });
console.log('[group-gun] started for peer:', peer);

function followPath(path) {
  let ref = gun;
  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    if (step.op === 'get') ref = ref.get(step.soul);
    else if (step.op === 'map') ref = ref.map();
    else throw new Error('bad op ' + step.op);
  }
  return ref;
}

process.on('message', (msg) => {
  try {
    if (msg.type === 'sub') {
      const ref = followPath(msg.path);
      const id = msg.id;
      ref.on((v, k) => process.send({ type: 'on', id, k, v }));
    } else if (msg.type === 'put') {
      const ref = followPath(msg.path);
      ref.put(msg.val, ack => process.send({ type: 'ack', id: msg.id, err: ack && ack.err }));
    } else if (msg.type === 'once') {
      const ref = followPath(msg.path);
      ref.once(v => process.send({ type: 'once', id: msg.id, v }));
    }
  } catch (e) {
    console.error('[group-gun] msg error:', e && e.message);
  }
});
