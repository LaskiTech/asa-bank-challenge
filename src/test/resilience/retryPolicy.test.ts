import { retryWithBackoff } from '../../resilience/retryPolicy';

const err = (statusCode: number, message = 'error') =>
  Object.assign(new Error(message), { statusCode });

// baseDelayMs=1 keeps tests fast without fake timers
const retry = (fn: () => Promise<unknown>, max = 3) => retryWithBackoff(fn, max, 1);

describe('retryWithBackoff — caminho feliz', () => {
  it('retorna o resultado na primeira tentativa', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(retry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('retryWithBackoff — retry em falhas transitórias', () => {
  it('retenta em erro 5xx e tem sucesso na 2ª tentativa', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(err(500, 'upstream down'))
      .mockResolvedValue('ok');
    await expect(retry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retenta em erro de rede (sem statusCode)', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('ok');
    await expect(retry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('esgota todas as tentativas e lança o último erro', async () => {
    const fn = jest.fn().mockRejectedValue(err(503, 'service unavailable'));
    await expect(retry(fn)).rejects.toThrow('service unavailable');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respeita o limite de maxAttempts configurado', async () => {
    const fn = jest.fn().mockRejectedValue(err(500));
    await expect(retry(fn, 2)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('retryWithBackoff — sem retry em erros de cliente (4xx)', () => {
  it('não retenta em erro 400', async () => {
    const fn = jest.fn().mockRejectedValue(err(400, 'bad request'));
    await expect(retry(fn)).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('não retenta em erro 401', async () => {
    const fn = jest.fn().mockRejectedValue(err(401));
    await expect(retry(fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('não retenta em erro 404', async () => {
    const fn = jest.fn().mockRejectedValue(err(404, 'not found'));
    await expect(retry(fn)).rejects.toThrow('not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('não retenta em erro 422', async () => {
    const fn = jest.fn().mockRejectedValue(err(422));
    await expect(retry(fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
