import { Bulkhead, BulkheadError } from './bulkhead';

describe('Bulkhead — caminho feliz', () => {
  it('executa a função e retorna o resultado', async () => {
    const bh = new Bulkhead(2);
    await expect(bh.call(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('expõe stats com contadores corretos', () => {
    const bh = new Bulkhead(5);
    expect(bh.stats).toEqual({ active: 0, max: 5 });
  });
});

describe('Bulkhead — controle de concorrência', () => {
  it('rejeita com BulkheadError quando o limite é atingido', async () => {
    const bh = new Bulkhead(1);
    let releaseSlot!: () => void;
    const blocking = new Promise<string>(r => { releaseSlot = () => r('done'); });

    const first = bh.call(() => blocking); // ocupa o único slot

    await expect(bh.call(() => Promise.resolve('ok'))).rejects.toBeInstanceOf(BulkheadError);

    releaseSlot();
    await first;
  });

  it('libera o slot após conclusão com sucesso', async () => {
    const bh = new Bulkhead(1);
    await bh.call(() => Promise.resolve('first'));
    await expect(bh.call(() => Promise.resolve('second'))).resolves.toBe('second');
  });

  it('libera o slot mesmo quando a função lança erro', async () => {
    const bh = new Bulkhead(1);
    await expect(bh.call(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    // Slot deve ter sido liberado — próxima chamada deve ter sucesso
    await expect(bh.call(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('permite até o limite exato de chamadas simultâneas', async () => {
    const bh = new Bulkhead(3);
    let releaseAll!: () => void;
    const gate = new Promise<string>(r => { releaseAll = () => r('done'); });

    const calls = [
      bh.call(() => gate),
      bh.call(() => gate),
      bh.call(() => gate),
    ];

    // O 4º deve ser rejeitado
    await expect(bh.call(() => Promise.resolve('rejected'))).rejects.toBeInstanceOf(BulkheadError);

    releaseAll();
    await Promise.all(calls);
  });
});
