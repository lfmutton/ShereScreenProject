import { Module } from '@nestjs/common';
import { IceServersController } from './ice-servers.controller';

@Module({
  controllers: [IceServersController],
})
export class IceServersModule {}
