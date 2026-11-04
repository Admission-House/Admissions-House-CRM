import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { PartitionKeeperService } from './partition-keeper.service.js';

@Global()
@Module({
  providers: [DatabaseService, PartitionKeeperService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
