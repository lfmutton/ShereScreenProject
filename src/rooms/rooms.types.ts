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
// de destino (msg.target), sem interpretar o conteúdo (SDP/candidate). O
// campo "purpose" (screen ou voice) diz pro cliente qual conjunto de
// RTCPeerConnection usar — o servidor não olha pra ele, só repassa.
export interface RelayMessage {
  type: 'offer' | 'answer' | 'ice-candidate';
  target: string;
  [key: string]: unknown;
}

// Avisa o resto da sala que liguei/desliguei o microfone (pra mostrar quem
// está com voz ativa na lista de participantes).
export interface MicChangedMessage {
  type: 'mic-changed';
  enabled: boolean;
}

export type ClientMessage =
  | JoinMessage
  | PresentingStartMessage
  | PresentingStopMessage
  | RelayMessage
  | MicChangedMessage;

export interface PeerInfo {
  id: string;
  name: string;
}

export interface RoomListEntry {
  room: string;
  count: number;
  hasPassword: boolean;
}
