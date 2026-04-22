import * as crypto from 'node:crypto';

export interface PairOfferRecord {
  offer: string;
  uri: string;
  expiresAt: number;
  createdAt: number;
  paired: boolean;
  bindingId?: string;
  deviceName?: string;
  transport?: 'lan' | 'relay';
  clientPubKey?: string;
}

export interface PairingStatus {
  paired: boolean;
  expired: boolean;
  bindingId?: string;
  deviceName?: string;
  transport?: 'lan' | 'relay';
}

const DEFAULT_TTL_SEC = 300;
const MAX_TTL_SEC = 15 * 60;

export class PairingManager {
  private readonly offers = new Map<string, PairOfferRecord>();

  createOffer(ttlSec = DEFAULT_TTL_SEC): PairOfferRecord {
    this.cleanExpired();

    const safeTtlSec = Number.isFinite(ttlSec)
      ? Math.max(1, Math.min(Math.floor(ttlSec), MAX_TTL_SEC))
      : DEFAULT_TTL_SEC;
    const offer = crypto.randomBytes(24).toString('base64url');
    const record: PairOfferRecord = {
      offer,
      uri: `prismer://pair?offer=${encodeURIComponent(offer)}`,
      createdAt: Date.now(),
      expiresAt: Date.now() + safeTtlSec * 1000,
      paired: false,
    };
    this.offers.set(offer, record);
    return { ...record };
  }

  getStatus(offer: string): PairingStatus | null {
    const record = this.offers.get(offer);
    if (!record) return null;

    const expired = Date.now() > record.expiresAt;
    return {
      paired: record.paired,
      expired,
      bindingId: record.bindingId,
      deviceName: record.deviceName,
      transport: record.transport,
    };
  }

  confirm(
    offer: string,
    input: {
      bindingId?: string;
      deviceName?: string;
      transport?: 'lan' | 'relay';
      clientPubKey?: string;
    } = {},
  ): PairingStatus {
    const record = this.offers.get(offer);
    if (!record) {
      throw Object.assign(new Error('Pairing offer not found'), { status: 404 });
    }
    if (Date.now() > record.expiresAt) {
      throw Object.assign(new Error('Pairing offer expired'), { status: 410 });
    }

    record.paired = true;
    record.bindingId = input.bindingId ?? record.bindingId ?? crypto.randomUUID();
    record.deviceName = input.deviceName ?? record.deviceName ?? 'Paired Device';
    record.transport = input.transport ?? record.transport ?? 'lan';
    record.clientPubKey = input.clientPubKey ?? record.clientPubKey;
    return this.getStatus(offer)!;
  }

  cleanExpired(): void {
    const now = Date.now();
    for (const [offer, record] of this.offers) {
      if (!record.paired && now > record.expiresAt) {
        this.offers.delete(offer);
      }
    }
  }
}
