import { Global, Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { FileLinks } from './file-links.service.js';
import { S3Storage } from './s3-storage.js';
import { LocalDiskStorage, StorageService } from './storage.service.js';

@Global()
@Module({
  providers: [
    { provide: StorageService, inject: [ENV], useFactory: (env: Env): StorageService => (env.STORAGE_DRIVER === 's3' ? S3Storage.fromEnv(env) : new LocalDiskStorage(env.STORAGE_DIR)) },
    FileLinks,
  ],
  exports: [StorageService, FileLinks],
})
export class StorageModule {}
