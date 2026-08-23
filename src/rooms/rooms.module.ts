import { Module } from '@nestjs/common';
import { RateLimiterModule } from '../rate-limiter/rate-limiter.module';
import { PasswordService } from './password.service';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

@Module({
  imports: [RateLimiterModule],
  providers: [RoomsGateway, RoomsService, PasswordService],
})
export class RoomsModule {}
