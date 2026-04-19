import { CircuitBreaker, CircuitBreakerOpenError } from '../../resilience/circuitBreaker';

const fail500 = () => Promise.reject(Object.assign(new Error('upstream error'), { statusCode: 500 }));
const succeed = () => Promise.resolve('ok');
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// threshold=3, successThreshold=2, openTimeout=50ms — fast for tests
const makeCB = () => new CircuitBreaker(3, 2, 50);

describe('CircuitBreaker — estado inicial', () => {
  it('começa no estado CLOSED', () => {
    expect(makeCB().getState()).toBe('CLOSED');
  });
});

describe('CircuitBreaker — transição CLOSED → OPEN', () => {
  it('permanece CLOSED abaixo do threshold', async () => {
    const cb = makeCB();
    await expect(cb.call(fail500)).rejects.toThrow();
    await expect(cb.call(fail500)).rejects.toThrow();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('abre ao atingir o threshold de falhas consecutivas', async () => {
    const cb = makeCB();
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail500)).rejects.toThrow();
    }
    expect(cb.getState()).toBe('OPEN');
  });

  it('reseta o contador de falhas após um sucesso', async () => {
    const cb = makeCB();
    // 2 falhas (abaixo do threshold de 3)
    await expect(cb.call(fail500)).rejects.toThrow();
    await expect(cb.call(fail500)).rejects.toThrow();
    // 1 sucesso reseta o contador
    await cb.call(succeed);
    // 2 falhas mais — não deve abrir (contador zerado)
    await expect(cb.call(fail500)).rejects.toThrow();
    await expect(cb.call(fail500)).rejects.toThrow();
    expect(cb.getState()).toBe('CLOSED');
  });
});

describe('CircuitBreaker — comportamento com estado OPEN', () => {
  it('rejeita imediatamente com CircuitBreakerOpenError quando OPEN', async () => {
    const cb = makeCB();
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail500)).rejects.toThrow();
    }
    await expect(cb.call(succeed)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
  });

  it('não executa a função quando OPEN (sem I/O externo)', async () => {
    const cb = makeCB();
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail500)).rejects.toThrow();
    }
    const spy = jest.fn().mockResolvedValue('ok');
    await expect(cb.call(spy)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('CircuitBreaker — transição OPEN → HALF_OPEN → CLOSED', () => {
  it('transiciona para HALF_OPEN após o timeout', async () => {
    const cb = makeCB();
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail500)).rejects.toThrow();
    }
    await wait(60); // aguarda o openTimeout de 50ms
    // Próxima chamada deve transicionar para HALF_OPEN e executar
    await expect(cb.call(succeed)).resolves.toBe('ok');
    expect(cb.getState()).toBe('HALF_OPEN');
  });

  it('fecha após successThreshold sucessos em HALF_OPEN', async () => {
    const cb = makeCB();
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail500)).rejects.toThrow();
    }
    await wait(60);
    await cb.call(succeed); // 1º sucesso
    await cb.call(succeed); // 2º sucesso → CLOSED
    expect(cb.getState()).toBe('CLOSED');
  });

  it('reabre em HALF_OPEN se ocorrer qualquer falha', async () => {
    const cb = makeCB();
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail500)).rejects.toThrow();
    }
    await wait(60);
    await expect(cb.call(fail500)).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');
  });

  it('reabre em HALF_OPEN após 1 sucesso e depois 1 falha (não fechou ainda)', async () => {
    const cb = makeCB();
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail500)).rejects.toThrow();
    }
    await wait(60);
    await cb.call(succeed);          // 1 sucesso — ainda HALF_OPEN
    await expect(cb.call(fail500)).rejects.toThrow(); // falha → OPEN
    expect(cb.getState()).toBe('OPEN');
  });
});
