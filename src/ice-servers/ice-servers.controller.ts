import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Servidores ICE (STUN sempre; TURN só se configurado via variáveis de
// ambiente). O cliente busca essa lista em vez de ter um TURN fixo no
// código — assim quem hospedar o app pode apontar pro seu próprio TURN
// (coturn, Twilio, Xirsys etc.) sem mexer no client.js.
@Controller('ice-servers')
export class IceServersController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  getIceServers() {
    const iceServers: Array<Record<string, unknown>> = [{ urls: 'stun:stun.l.google.com:19302' }];

    const turnUrl = this.config.get<string>('TURN_URL');
    if (turnUrl) {
      iceServers.push({
        urls: turnUrl.split(',').map((url) => url.trim()),
        username: this.config.get<string>('TURN_USERNAME'),
        credential: this.config.get<string>('TURN_CREDENTIAL'),
      });
    }

    return { iceServers };
  }
}
