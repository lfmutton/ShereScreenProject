const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve os arquivos estáticos da pasta "public" (HTML, CSS, JS do cliente)
app.use(express.static(path.join(__dirname, 'public')));

// Servidores ICE (STUN sempre; TURN só se configurado via variáveis de
// ambiente). O cliente busca essa lista em vez de ter um TURN fixo no
// código — assim quem hospedar o app pode apontar pro seu próprio TURN
// (coturn, Twilio, Xirsys etc.) sem mexer no client.js.
app.get('/ice-servers', (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((url) => url.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }

  res.json({ iceServers });
});

// Guarda as salas: { codigoDaSala: Map<conexão WebSocket, { id, name }> }
const rooms = new Map();

// Quem está compartilhando a tela em cada sala agora (só uma pessoa por vez).
// { codigoDaSala: idDoApresentador | null }
const presenters = new Map();

// Hash da senha de cada sala (null = sala sem senha). Quem cria a sala
// (primeira pessoa a entrar) define a senha; quem entra depois precisa
// informar a mesma senha.
const roomPasswords = new Map();

// Todas as conexões ativas (mesmo antes de entrar numa sala), pra
// conseguirmos avisar todo mundo quando a lista de salas mudar.
const allSockets = new Set();

// ===== Rate limiting =====
// Limitador de janela deslizante simples, sem dependências externas:
// cada chamada registra um evento agora e diz se ainda estamos dentro do
// limite permitido pra janela de tempo configurada.
function createRateLimiter(maxEvents, windowMs) {
  const timestamps = [];
  return function hit() {
    const now = Date.now();
    while (timestamps.length && now - timestamps[0] > windowMs) {
      timestamps.shift();
    }
    timestamps.push(now);
    return timestamps.length <= maxEvents;
  };
}

// Limita quantas conexões WebSocket novas cada IP pode abrir por minuto —
// evita que alguém fique reconectando em loop pra spammar salas.
const MAX_CONNECTIONS_PER_IP_PER_MINUTE = 30;
const ipConnectionLimiters = new Map();

function getClientIp(req) {
  // Atrás de um proxy (Render, Railway, Fly.io, nginx...) o socket bruto
  // é o IP do próprio proxy — usamos o X-Forwarded-For quando existir.
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function isIpAllowedToConnect(ip) {
  let limiter = ipConnectionLimiters.get(ip);
  if (!limiter) {
    limiter = createRateLimiter(MAX_CONNECTIONS_PER_IP_PER_MINUTE, 60 * 1000);
    ipConnectionLimiters.set(ip, limiter);
  }
  return limiter();
}

// Evita que esse mapa cresça pra sempre com IPs que só passaram uma vez.
// Como a janela de cada limitador é de 1 minuto, zerar tudo a cada 10
// minutos não afeta ninguém que ainda estiver ativo.
setInterval(() => ipConnectionLimiters.clear(), 10 * 60 * 1000).unref();

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function passwordsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function getRoomList() {
  return Array.from(rooms.entries()).map(([room, peers]) => ({
    room,
    count: peers.size,
    hasPassword: !!roomPasswords.get(room)
  }));
}

function broadcastRoomList() {
  const payload = JSON.stringify({ type: 'room-list', rooms: getRoomList() });
  allSockets.forEach((socket) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  });
}

function broadcastToRoom(room, payload, exceptWs) {
  const peers = rooms.get(room);
  if (!peers) return;
  const data = JSON.stringify(payload);
  peers.forEach((_info, peer) => {
    if (peer !== exceptWs && peer.readyState === WebSocket.OPEN) {
      peer.send(data);
    }
  });
}

function findPeerSocketById(room, peerId) {
  const peers = rooms.get(room);
  if (!peers) return null;
  for (const [socket, info] of peers.entries()) {
    if (info.id === peerId) return socket;
  }
  return null;
}

function clearPresenterIfSelf(room, peerId) {
  if (presenters.get(room) === peerId) {
    presenters.set(room, null);
    broadcastToRoom(room, { type: 'presenter-changed', presenterId: null });
  }
}

wss.on('connection', (ws, req) => {
  let currentRoom = null;
  let currentId = null;
  let currentName = null;

  const clientIp = getClientIp(req);
  if (!isIpAllowedToConnect(clientIp)) {
    ws.close(1008, 'rate-limited');
    return;
  }

  // Limita quantas mensagens de sinalização essa conexão pode mandar —
  // protege contra um cliente com bug (ou malicioso) inundando a sala.
  const messageLimiter = createRateLimiter(200, 10 * 1000);

  allSockets.add(ws);
  // Assim que conecta, já manda a lista de salas ativas (útil pra
  // mostrar no painel de entrada antes mesmo de escolher uma sala).
  ws.send(JSON.stringify({ type: 'room-list', rooms: getRoomList() }));

  ws.on('message', (data) => {
    if (!messageLimiter()) return; // descarta silenciosamente o excesso

    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return; // ignora mensagens mal formadas
    }

    // Usuário está entrando em uma sala
    if (msg.type === 'join') {
      // Normaliza o código da sala (tira espaços e ignora maiúsculas/minúsculas)
      // pra evitar que "Sala1" e "sala1 " virem salas diferentes por engano.
      const room = (msg.room || '').trim().toLowerCase();
      const name = (msg.name || '').trim() || 'Anônimo';
      const password = typeof msg.password === 'string' ? msg.password : '';

      if (!room) return;

      const roomExists = rooms.has(room);
      const requiredHash = roomPasswords.get(room);
      if (roomExists && requiredHash) {
        const providedHash = password ? hashPassword(password) : '';
        if (!passwordsMatch(providedHash, requiredHash)) {
          ws.send(JSON.stringify({ type: 'join-denied', reason: 'wrong-password' }));
          return;
        }
      }

      currentRoom = room;
      currentName = name;
      currentId = crypto.randomUUID();

      if (!roomExists) {
        rooms.set(currentRoom, new Map());
        presenters.set(currentRoom, null);
        roomPasswords.set(currentRoom, password ? hashPassword(password) : null);
      }
      const peers = rooms.get(currentRoom);

      const presenterId = presenters.get(currentRoom) || null;
      let presenter = null;
      if (presenterId) {
        for (const info of peers.values()) {
          if (info.id === presenterId) {
            presenter = { id: info.id, name: info.name };
            break;
          }
        }
      }

      // Avisa pro novo usuário seu próprio id, quantas pessoas já estão na
      // sala, quem são elas, e quem está apresentando agora (se alguém estiver).
      ws.send(JSON.stringify({
        type: 'joined',
        id: currentId,
        peersCount: peers.size,
        peers: Array.from(peers.values()).map((info) => ({ id: info.id, name: info.name })),
        presenter
      }));

      // Avisa pros outros na sala que alguém novo chegou, com o nome e id dele
      // (quem estiver apresentando usa isso pra abrir uma conexão dedicada
      // com essa pessoa e ela também poder ver a tela).
      broadcastToRoom(currentRoom, { type: 'peer-joined', id: currentId, name: currentName });

      peers.set(ws, { id: currentId, name: currentName });
      broadcastRoomList();
      return;
    }

    if (!currentRoom || !rooms.has(currentRoom)) return;

    // Pedido pra virar o apresentador da sala.
    if (msg.type === 'presenting-start') {
      const activePresenterId = presenters.get(currentRoom);
      if (activePresenterId && activePresenterId !== currentId) {
        const activePeers = rooms.get(currentRoom);
        let activePresenterName = 'outra pessoa';
        for (const info of activePeers.values()) {
          if (info.id === activePresenterId) {
            activePresenterName = info.name;
            break;
          }
        }
        ws.send(JSON.stringify({ type: 'presenting-denied', presenterName: activePresenterName }));
        return;
      }
      presenters.set(currentRoom, currentId);
      broadcastToRoom(currentRoom, { type: 'presenter-changed', presenterId: currentId, presenterName: currentName });
      return;
    }

    if (msg.type === 'presenting-stop') {
      clearPresenterIfSelf(currentRoom, currentId);
      return;
    }

    // Sinalização ponto a ponto (offer/answer/ice-candidate): repassa só
    // pro peer de destino (msg.target), anexando quem enviou.
    if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice-candidate') {
      const targetSocket = findPeerSocketById(currentRoom, msg.target);
      if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
        const outgoing = { ...msg, senderId: currentId, senderName: currentName };
        delete outgoing.target;
        targetSocket.send(JSON.stringify(outgoing));
      }
    }
  });

  ws.on('close', () => {
    allSockets.delete(ws);
    if (currentRoom && rooms.has(currentRoom)) {
      const peers = rooms.get(currentRoom);
      peers.delete(ws);

      // Avisa quem ficou que esse usuário (com esse id/nome) saiu
      broadcastToRoom(currentRoom, { type: 'peer-left', id: currentId, name: currentName });

      clearPresenterIfSelf(currentRoom, currentId);

      if (peers.size === 0) {
        rooms.delete(currentRoom);
        presenters.delete(currentRoom);
        roomPasswords.delete(currentRoom);
      }
      broadcastRoomList();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
