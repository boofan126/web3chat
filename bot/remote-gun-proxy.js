// #366 远程 Gun 代理：把 bot.js 的链式调用通过 IPC 转发给子进程里的真实 Gun 实例。
function createRemoteGunProxy(worker, path) {
  path = path || [];
  const subs = new Map();   // id -> callback
  let subId = 0;

  worker.on('message', (msg) => {
    if (msg.type === 'on') {
      const cb = subs.get(msg.id);
      if (cb) cb(msg.v, msg.k);
    } else if (msg.type === 'ack') {
      const cb = subs.get(msg.id);
      if (cb) cb(msg.err ? { err: msg.err } : {});
    } else if (msg.type === 'once') {
      const cb = subs.get(msg.id);
      if (cb) cb(msg.v);
    }
  });

  const handler = {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'get') {
        return (soul) => createRemoteGunProxy(worker, path.concat([{ op: 'get', soul }]));
      }
      if (prop === 'map') {
        return () => createRemoteGunProxy(worker, path.concat([{ op: 'map' }]));
      }
      if (prop === 'on') {
        return (cb) => {
          const id = ++subId;
          subs.set(id, cb);
          worker.send({ type: 'sub', path, id });
        };
      }
      if (prop === 'once') {
        return (cb) => {
          const id = ++subId;
          subs.set(id, cb);
          worker.send({ type: 'once', path, id });
        };
      }
      if (prop === 'put') {
        return (val, cb) => {
          const id = ++subId;
          if (cb) subs.set(id, cb);
          worker.send({ type: 'put', path, val, id });
        };
      }
      return undefined;
    }
  };
  return new Proxy({}, handler);
}
module.exports = { createRemoteGunProxy };
