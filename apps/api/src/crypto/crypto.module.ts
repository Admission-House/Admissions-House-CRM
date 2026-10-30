import { Global, Module } from '@nestjs/common';
import { SecretBox } from './secret-box.js';

@Global()
@Module({ providers: [SecretBox], exports: [SecretBox] })
export class CryptoModule {}
