import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProfileController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({ imports: [AuthModule], controllers: [UsersController, ProfileController], providers: [UsersService, ProfileService], exports: [UsersService] })
export class UsersModule {}
