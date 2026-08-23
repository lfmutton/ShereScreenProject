import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { IceServersModule } from './ice-servers/ice-servers.module';
import { RoomsModule } from './rooms/rooms.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Serve os arquivos estáticos da pasta "public" (HTML, CSS, JS do cliente).
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
    }),
    RoomsModule,
    IceServersModule,
  ],
})
export class AppModule {}
