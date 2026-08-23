// Protocolo de sinalização trocado com o cliente (public/client.js) via
// WebSocket — mantido idêntico ao que já existia no server.js original.

export interface JoinMessage {
  type: 'join';
  room: string;
  name: string;
  password?: string;
}

export interface PresentingStartMessage {
  type: 'presenting-start';
}

export interface PresentingStopMessage {
  type: 'presenting-stop';
}

// offer/answer/ice-candidate: o servidor só repassa esse payload pro peer
// de destino (msg.target), sem interpretar o conteúdo (SDP/candidate).
export interface RelayMessage {
  type: 'offer' | 'answer' | 'ice-candidate';
  target: string;
  [key: string]: unknown;
}

export type ClientMessage =
  | JoinMessage
  | PresentingStartMessage
  | PresentingStopMessage
  | RelayMessage;

export interface PeerInfo {
  id: string;
  name: string;
}

export interface RoomListEntry {
  room: string;
  count: number;
  hasPassword: boolean;
}
