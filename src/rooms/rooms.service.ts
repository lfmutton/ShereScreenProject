import { Injectable } from '@nestjs/common';
import { PasswordService } from './password.service';
import { PeerInfo, RoomListEntry } from './rooms.types';

interface RoomState {
  peers: Map<string, PeerInfo>; // peerId -> info
  presenterId: string | null;
  passwordHash: string | null; // null = sala sem senha
}

// Dono do estado e das regras de negócio das salas. Não sabe o que é um
// WebSocket — quem endereça mensagens pra cada peer é o RoomsGateway.
@Injectable()
export class RoomsService {
  private readonly rooms = new Map<string, RoomState>();

  constructor(private readonly passwordService: PasswordService) {}

  // Tira espaços e ignora maiúsculas/minúsculas, pra "Sala1" e "sala1 " não
  // virarem salas diferentes por engano.
  normalizeRoomCode(room: string): string {
    return (room || '').trim().toLowerCase();
  }

  roomExists(room: string): boolean {
    return this.rooms.has(room);
  }

  checkPassword(room: string, password: string): boolean {
    const state = this.rooms.get(room);
    if (!state?.passwordHash) return true; // sala sem senha, sempre libera
    const providedHash = password ? this.passwordService.hash(password) : '';
    return this.passwordService.matches(providedHash, state.passwordHash);
  }

  // Cria a sala se ainda não existir (a senha de quem chega primeiro vira a
  // senha da sala) e registra o novo peer. Retorna quem já estava na sala e
  // quem está apresentando *antes* de adicionar o novo peer — é isso que o
  // gateway manda na mensagem "joined".
  joinRoom(
    room: string,
    peer: PeerInfo,
    password: string,
  ): { existingPeers: PeerInfo[]; presenter: PeerInfo | null } {
    let state = this.rooms.get(room);
    if (!state) {
      state = {
        peers: new Map(),
        presenterId: null,
        passwordHash: password ? this.passwordService.hash(password) : null,
      };
      this.rooms.set(room, state);
    }

    const existingPeers = Array.from(state.peers.values());
    const presenter = state.presenterId ? (state.peers.get(state.presenterId) ?? null) : null;

    state.peers.set(peer.id, peer);

    return { existingPeers, presenter };
  }

  getPeers(room: string): PeerInfo[] {
    return Array.from(this.rooms.get(room)?.peers.values() ?? []);
  }

  removePeer(room: string, peerId: string): void {
    this.rooms.get(room)?.peers.delete(peerId);
  }

  deleteRoomIfEmpty(room: string): void {
    const state = this.rooms.get(room);
    if (state && state.peers.size === 0) {
      this.rooms.delete(room);
    }
  }

  trySetPresenter(
    room: string,
    peerId: string,
  ): { allowed: true } | { allowed: false; presenterName: string } {
    const state = this.rooms.get(room);
    if (!state) return { allowed: false, presenterName: 'outra pessoa' };

    if (state.presenterId && state.presenterId !== peerId) {
      const presenterName = state.peers.get(state.presenterId)?.name ?? 'outra pessoa';
      return { allowed: false, presenterName };
    }

    state.presenterId = peerId;
    return { allowed: true };
  }

  clearPresenterIfSelf(room: string, peerId: string): boolean {
    const state = this.rooms.get(room);
    if (state && state.presenterId === peerId) {
      state.presenterId = null;
      return true;
    }
    return false;
  }

  getRoomList(): RoomListEntry[] {
    return Array.from(this.rooms.entries()).map(([room, state]) => ({
      room,
      count: state.peers.size,
      hasPassword: !!state.passwordHash,
    }));
  }
}
