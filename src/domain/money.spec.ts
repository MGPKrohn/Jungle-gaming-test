import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from './money.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('0.10 + 0.20 é exatamente 0.30', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('ida e volta preserva a escala 2', () => {
    expect(brl('80.00').toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });
    expect(brl('0.05').toJSON().amount).toBe('0.05');
    expect(Money.zero('BRL').toJSON().amount).toBe('0.00');
  });

  test('precisão acima de number: soma exata de valores enormes', () => {
    const total = brl('99999999999999999999.99').add(brl('0.01'));
    expect(total.toJSON().amount).toBe('100000000000000000000.00');
  });

  test('entradas inválidas são rejeitadas', () => {
    for (const amount of ['25', '25.0', '10.001', '-1.00', '1e3', '', 'abc', 'NaN', 'Infinity', ' 1.00']) {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    }
    expect(() => Money.from({ amount: 10.5 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(InvalidMoneyError);
  });

  test('é imutável: operações devolvem nova instância', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('15.00');
  });

  test('subtract/negate podem produzir negativo e formatam corretamente', () => {
    expect(brl('1.00').subtract(brl('1.05')).toJSON().amount).toBe('-0.05');
    expect(brl('2.50').negate().toString()).toBe('-2.50 BRL');
    expect(brl('1.00').subtract(brl('2.00')).isNegative()).toBe(true);
  });

  test('predicados e comparação', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
  });

  test('conflito de moeda lança erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });
});
