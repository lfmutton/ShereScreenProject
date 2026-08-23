import { Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

@Injectable()
export class PasswordService {
  hash(password: string): string {
    return createHash('sha256').update(password).digest('hex');
  }

  matches(providedHash: string, requiredHash: string): boolean {
    if (providedHash.length !== requiredHash.length) return false;
    return timingSafeEqual(Buffer.from(providedHash), Buffer.from(requiredHash));
  }
}
