import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // WsAdapter usa a lib `ws` crua (mesma de antes) em vez do socket.io
  // padrão do Nest — necessário porque o RoomsGateway fala o protocolo
  // próprio do public/client.js, não o {event, data} do socket.io.
  app.useWebSocketAdapter(new WsAdapter(app));

  const config = app.get(ConfigService);
  const port = config.get<string>('PORT') ?? 3000;

  await app.listen(port);
  console.log(`Servidor rodando em http://localhost:${port}`);
}

bootstrap();
