export interface Contacts {
  leftFoot: boolean;
  rightFoot: boolean;
  leftHand: boolean;
  rightHand: boolean;
}
export interface Composition {
  bodyFatPct: number;
  muscleMassKg: number;
  bodyWaterPct: number;
}
export interface ScaleReading {
  weightKg: number;
  contacts: Contacts;
  /** Present once the device has enough data (BIA). */
  composition?: Composition;
}
export interface ScaleInput {
  age: number;
  heightCm: number;
}
/** Optional overrides: dev manual entry or tests. */
export interface ScaleOverride {
  weightKg?: number;
  composition?: Composition;
  contacts?: Partial<Contacts>;
}

// Contract for real devices (USB / Bluetooth / serial). The rest of the system only sees this.
export interface ScaleProvider {
  start(input: ScaleInput, override?: ScaleOverride): void;
  onReading(cb: (r: ScaleReading) => void): void;
  stop(): void;
}

export const ALL_CONTACTS: Contacts = { leftFoot: true, rightFoot: true, leftHand: true, rightHand: true };

/** Simulation: noisy readings that converge on a plausible value over `durationMs`. */
export class SimulatedScale implements ScaleProvider {
  private timer?: ReturnType<typeof setInterval>;
  private cb?: (r: ScaleReading) => void;
  constructor(private durationMs: number) {}

  onReading(cb: (r: ScaleReading) => void) {
    this.cb = cb;
  }

  start(input: ScaleInput, override: ScaleOverride = {}) {
    const base = override.weightKg ?? Math.round((55 + Math.random() * 40) * 10) / 10;
    const bmi = base / (input.heightCm / 100) ** 2;
    const fat = Math.round((12 + Math.random() * 18) * 10) / 10;
    const composition: Composition = override.composition ?? {
      bodyFatPct: fat,
      muscleMassKg: Math.round(base * (1 - fat / 100) * 0.5 * 10) / 10,
      bodyWaterPct: Math.round((75 - fat * 0.8 - (bmi > 25 ? 3 : 0)) * 10) / 10,
    };
    const contacts = { ...ALL_CONTACTS, ...override.contacts };
    const tick = Math.max(5, Math.round(this.durationMs / 30));
    const t0 = Date.now();
    this.timer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - t0) / this.durationMs);
      // Noise shrinks to zero by 70% of the duration, so the reading then stabilises.
      const noise = progress < 0.7 && override.weightKg === undefined ? (Math.random() - 0.5) * 2 * (1 - progress) : 0;
      this.cb?.({
        weightKg: Math.round((base + noise) * 10) / 10,
        contacts,
        composition: progress > 0.5 ? composition : undefined,
      });
    }, tick);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

