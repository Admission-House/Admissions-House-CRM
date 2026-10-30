import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error.js';
import { TELEPHONY_PROVIDERS, TelephonyProvider } from './provider.js';

@Injectable()
export class ProviderRegistry {
  private readonly byName: Map<string, TelephonyProvider>;

  constructor(@Inject(TELEPHONY_PROVIDERS) providers: TelephonyProvider[]) {
    this.byName = new Map(providers.map((p) => [p.name, p]));
  }

  names(): string[] {
    return [...this.byName.keys()].sort();
  }

  get(name: string): TelephonyProvider {
    const provider = this.byName.get(name);
    if (!provider) throw new AppError('PROVIDER_UNKNOWN', `Telephony provider "${name}" is not available`, 422);
    return provider;
  }
}
