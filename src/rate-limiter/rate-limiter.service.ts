import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { IncomingMessage } from 'http';

const MAX_CONNECTIONS_PER_IP_PER_MINUTE = 30;
const CONNECTION_LIMITER_CLEANUP_MS = 10 * 60 * 1000;

// Limitador de janela deslizante genérico, sem dependência externa: cada
// chamada registra um evento agora e diz se ainda estamos dentro do limite
// permitido pra janela de tempo configurada.
type SlidingWindowLimiter = () => boolean;

@Injectable()
export class RateLimiterService implements OnModuleDestroy {
  private readonly ipConnectionLimiters = new Map<string, SlidingWindowLimiter>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor() {
    // Evita que o mapa acima cresça pra sempre com IPs que só passaram uma
    // vez. Como a janela de cada limitador é de 1 minuto, zerar tudo a cada
    // 10 minutos não afeta ninguém que ainda estiver ativo.
    this.cleanupTimer = setInterval(
      () => this.ipConnectionLimiters.clear(),
      CONNECTION_LIMITER_CLEANUP_MS,
    );
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  createLimiter(maxEvents: number, windowMs: number): SlidingWindowLimiter {
    const timestamps: number[] = [];
    return () => {
      const now = Date.now();
      while (timestamps.length && now - timestamps[0] > windowMs) {
        timestamps.shift();
      }
      timestamps.push(now);
      return timestamps.length <= maxEvents;
    };
  }

  // Atrás de um proxy (Render, Railway, Fly.io, nginx...) o socket bruto é
  // o IP do próprio proxy — usamos o X-Forwarded-For quando existir.
  getClientIp(request: IncomingMessage): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    return request.socket.remoteAddress ?? 'unknown';
  }

  // Limita quantas conexões WebSocket novas cada IP pode abrir por minuto —
  // evita que alguém fique reconectando em loop pra spammar salas.
  canConnect(ip: string): boolean {
    let limiter = this.ipConnectionLimiters.get(ip);
    if (!limiter) {
      limiter = this.createLimiter(MAX_CONNECTIONS_PER_IP_PER_MINUTE, 60 * 1000);
      this.ipConnectionLimiters.set(ip, limiter);
    }
    return limiter();
  }
}
