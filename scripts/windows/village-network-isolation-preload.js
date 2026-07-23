'use strict';

const message = 'Village capability validation network access is disabled';
const deny = () => {
  throw new Error(message);
};
const denyAsync = async () => {
  throw new Error(message);
};

globalThis.fetch = denyAsync;
globalThis.WebSocket = class DisabledValidationWebSocket {
  constructor() { deny(); }
};

for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = deny;
  module.get = deny;
}

const net = require('node:net');
net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;

const tls = require('node:tls');
tls.connect = deny;

const dgram = require('node:dgram');
dgram.createSocket = deny;

const dns = require('node:dns');
for (const name of Object.keys(dns)) {
  if (name === 'promises' || typeof dns[name] !== 'function') continue;
  if (name === 'getDefaultResultOrder' || name === 'getServers') continue;
  dns[name] = deny;
}
if (dns.promises) {
  for (const name of Object.keys(dns.promises)) {
    if (typeof dns.promises[name] === 'function') dns.promises[name] = denyAsync;
  }
}

process.env.VILLAGE_NETWORK_ISOLATED = '1';
