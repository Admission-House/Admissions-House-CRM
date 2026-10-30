import { Module } from '@nestjs/common';
import { CompanyController } from './company.controller.js';
import { CompanyService } from './company.service.js';

@Module({ controllers: [CompanyController], providers: [CompanyService] })
export class CompanyModule {}
