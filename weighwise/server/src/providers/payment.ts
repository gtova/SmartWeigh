export interface ChargeRequest {
  sessionId: string;
  amountAgorot: number;
  idempotencyKey: string;
}
export interface ChargeResult {
  ok: boolean;
  txnId?: string;
}
export interface PaymentProvider {
  readonly name: string;
  charge(req: ChargeRequest): Promise<ChargeResult>;
}

// Mock provider for v1. `failNext` lets tests/dev simulate a declined card.
export const mockPayment: PaymentProvider & { failNext: boolean } = {
  name: 'mock',
  failNext: false,
  async charge(req) {
    if (this.failNext) {
      this.failNext = false;
      return { ok: false };
    }
    return { ok: true, txnId: `mock_${req.idempotencyKey.slice(0, 12)}` };
  },
};

export const paymentProviders: { payment: PaymentProvider } = { payment: mockPayment };
