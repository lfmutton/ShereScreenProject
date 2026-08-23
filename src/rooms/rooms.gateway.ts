import { randomUUID } from 'crypto';
import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { RateLimiterService } from '../rate-limiter/rate-limiter.service';
import { RoomsService } from './rooms.service';
import { ClientMessage, PeerInfo, RelayMessage } from './rooms.types';

interface SocketMeta {
  room: string;
  peerId: string;
  name: string;
}

// @nestjs/platform-ws espera mensagens no formato {event, data} pros
// handlers @SubscribeMessage — mas o public/client.js já fala um protocolo
// próprio, {type: 'join', ...}, testado a fundo. Em vez de reescrever o
// front (e arriscar quebrar o WebRTC), esse gateway ignora o roteamento por
// decorator e faz o parsing manual das mensagens, exatamente como o
// server.js original fazia.
@WebSocketGateway()
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  // Todas as conexões ativas (mesmo antes de entrar numa sala), pra
  // conseguirmos avisar todo mundo quando a lista de salas mudar.
  private readonly allSockets = new Set<WebSocket>();
  // Endereçamento pra sinalização ponto a ponto (offer/answer/ice-candidate):
  // encontrar o socket de um peer a partir do id dele.
  private readonly peerSockets = new Map<string, WebSocket>();
  private readonly socketMeta = new Map<WebSocket, SocketMeta>();

  constructor(
    private readonly roomsService: RoomsService,
    private readonly rateLimiterService: RateLimiterService,
  ) {}

  handleConnection(client: WebSocket, request: IncomingMessage): void {
    const ip = this.rateLimiterService.getClientIp(request);
    if (!this.rateLimiterService.canConnect(ip)) {
      client.close(1008, 'rate-limited');
      return;
    }

    // Limita quantas mensagens de sinalização essa conexão pode mandar —
    // protege contra um cliente com bug (ou malicioso) inundando a sala.
    const messageLimiter = this.rateLimiterService.createLimiter(200, 10 * 1000);

    this.allSockets.add(client);
    // Assim que conecta, já manda a lista de salas ativas (útil pra mostrar
    // no painel de entrada antes mesmo de escolher uma sala).
    client.send(JSON.stringify({ type: 'room-list', rooms: this.roomsService.getRoomList() }));

    client.on('message', (data) => {
      if (!messageLimiter()) return; // descarta silenciosamente o excesso

      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignora mensagens mal formadas
      }

      this.handleMessage(client, msg);
    });
  }

  handleDisconnect(client: WebSocket): void {
    this.allSockets.delete(client);

    const meta = this.socketMeta.get(client);
    if (!meta) return;
    this.socketMeta.delete(client);
    this.peerSockets.delete(meta.peerId);

    this.roomsService.removePeer(meta.room, meta.peerId);
    // Avisa quem ficou que esse usuário (com esse id/nome) saiu.
    this.broadcastToRoom(meta.room, { type: 'peer-left', id: meta.peerId, name: meta.name });

    if (this.roomsService.clearPresenterIfSelf(meta.room, meta.peerId)) {
      this.broadcastToRoom(meta.room, { type: 'presenter-changed', presenterId: null });
    }

    this.roomsService.deleteRoomIfEmpty(meta.room);
    this.broadcastRoomList();
  }

  private handleMessage(client: WebSocket, msg: ClientMessage): void {
    if (msg.type === 'join') {
      this.handleJoin(client, msg.room, msg.name, msg.password ?? '');
      return;
    }

    const meta = this.socketMeta.get(client);
    if (!meta || !this.roomsService.roomExists(meta.room)) return;

    switch (msg.type) {
      case 'presenting-start':
        this.handlePresentingStart(client, meta);
        break;
      case 'presenting-stop':
        this.handlePresentingStop(meta);
        break;
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        this.relay(msg, meta);
        break;
    }
  }

  private handleJoin(client: WebSocket, rawRoom: string, rawName: string, password: string): void {
    const room = this.roomsService.normalizeRoomCode(rawRoom);
    const name = (rawName || '').trim() || 'Anônimo';
    if (!room) return;

    if (this.roomsService.roomExists(room) && !this.roomsService.checkPassword(room, password)) {
      client.send(JSON.stringify({ type: 'join-denied', reason: 'wrong-password' }));
      return;
    }

    const peerId = randomUUID();
    const peer: PeerInfo = { id: peerId, name };
    const { existingPeers, presenter } = this.roomsService.joinRoom(room, peer, password);

    this.peerSockets.set(peerId, client);
    this.socketMeta.set(client, { room, peerId, name });

    // Avisa pro novo usuário seu próprio id, quantas pessoas já estão na
    // sala, quem são elas, e quem está apresentando agora (se alguém estiver).
    client.send(
      JSON.stringify({
        type: 'joined',
        id: peerId,
        peersCount: existingPeers.length,
        peers: existingPeers,
        presenter,
      }),
    );

    // Avisa pros outros na sala que alguém novo chegou (exceto ele mesmo).
    this.broadcastToRoom(room, { type: 'peer-joined', id: peerId, name }, peerId);
    this.broadcastRoomList();
  }

  private handlePresentingStart(client: WebSocket, meta: SocketMeta): void {
    const result = this.roomsService.trySetPresenter(meta.room, meta.peerId);
    if (!result.allowed) {
      client.send(JSON.stringify({ type: 'presenting-denied', presenterName: result.presenterName }));
      return;
    }
    this.broadcastToRoom(meta.room, {
      type: 'presenter-changed',
      presenterId: meta.peerId,
      presenterName: meta.name,
    });
  }

  private handlePresentingStop(meta: SocketMeta): void {
    if (this.roomsService.clearPresenterIfSelf(meta.room, meta.peerId)) {
      this.broadcastToRoom(meta.room, { type: 'presenter-changed', presenterId: null });
    }
  }

  // Sinalização ponto a ponto: repassa a mensagem só pro peer de destino
  // (msg.target), anexando quem enviou.
  private relay(msg: RelayMessage, meta: SocketMeta): void {
    const targetSocket = this.peerSockets.get(msg.target);
    if (!targetSocket || targetSocket.readyState !== WebSocket.OPEN) return;

    const { target: _target, ...rest } = msg;
    targetSocket.send(JSON.stringify({ ...rest, senderId: meta.peerId, senderName: meta.name }));
  }

  private broadcastToRoom(room: string, payload: unknown, exceptPeerId?: string): void {
    const data = JSON.stringify(payload);
    for (const peer of this.roomsService.getPeers(room)) {
      if (peer.id === exceptPeerId) continue;
      const socket = this.peerSockets.get(peer.id);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(data);
      }
    }
  }

  private broadcastRoomList(): void {
    const payload = JSON.stringify({ type: 'room-list', rooms: this.roomsService.getRoomList() });
    for (const socket of this.allSockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }
}
