import { DomainError } from './errors.js';

export class InvalidMoneyError extends DomainError {}
export class CurrencyMismatchError extends DomainError {}

/** Contrato de entrada/saída: string decimal com exatamente 2 casas. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^\d+\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável. Internamente um bigint em centavos (escala fixa 2):
 * aritmética exata, sem number/float e sem dependência de ORM ou NestJS.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Valida um contrato de entrada. Rejeita negativos, notação científica,
   * NaN/Infinity, string vazia e qualquer coisa diferente de 2 casas decimais.
   * Exigir escala exata também mantém o payloadHash estável ("25.00", nunca "25").
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money must be an object');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with exactly 2 decimal places',
      );
    }
    Money.assertCurrency(currency);
    return new Money(BigInt(amount.replace('.', '')), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  /** Pode resultar em valor negativo: quem decide se isso é aceitável é a Wallet. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }
  isPositive(): boolean {
    return this.cents > 0n;
  }
  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.format(), currency: this.currency };
  }

  toString(): string {
    return `${this.format()} ${this.currency}`;
  }

  private format(): string {
    const negative = this.cents < 0n;
    const digits = (negative ? -this.cents : this.cents).toString().padStart(3, '0');
    return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be a 3-letter uppercase ISO-4217 code');
    }
  }
}
