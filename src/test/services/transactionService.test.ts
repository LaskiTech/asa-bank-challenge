import { SqliteTransactionStore } from '../../storage/SqliteTransactionStore';
import { TransactionService } from '../../services/transactionService';

// Each test suite gets its own isolated in-memory SQLite database
function makeService() {
  const store = new SqliteTransactionStore(':memory:');
  return new TransactionService(store);
}

const CID = 'test-correlation-id';

// ---------------------------------------------------------------------------
// authorize
// ---------------------------------------------------------------------------

describe('TransactionService.authorize — nova transação', () => {
  it('cria uma transação no estado AUTHORIZED', () => {
    const svc = makeService();
    const { transaction, isNew } = svc.authorize(
      { nsu: 'NSU-1', terminalId: 'T-1', amount: 100 },
      CID,
    );
    expect(isNew).toBe(true);
    expect(transaction.state).toBe('AUTHORIZED');
    expect(transaction.nsu).toBe('NSU-1');
    expect(transaction.terminalId).toBe('T-1');
    expect(transaction.amount).toBe(100);
    expect(transaction.id).toBeTruthy();
  });

  it('gera transactionId único para cada transação', () => {
    const svc = makeService();
    const { transaction: t1 } = svc.authorize({ nsu: 'NSU-A', terminalId: 'T-1', amount: 10 }, CID);
    const { transaction: t2 } = svc.authorize({ nsu: 'NSU-B', terminalId: 'T-1', amount: 10 }, CID);
    expect(t1.id).not.toBe(t2.id);
  });
});

describe('TransactionService.authorize — idempotência', () => {
  it('retorna a mesma transação para o mesmo (terminalId, nsu)', () => {
    const svc = makeService();
    const req = { nsu: 'NSU-1', terminalId: 'T-1', amount: 99 };
    const first = svc.authorize(req, CID);
    const second = svc.authorize(req, CID);
    expect(second.isNew).toBe(false);
    expect(second.transaction.id).toBe(first.transaction.id);
  });

  it('não cria nova transação no replay', () => {
    const svc = makeService();
    const req = { nsu: 'NSU-1', terminalId: 'T-1', amount: 50 };
    svc.authorize(req, CID);
    const { isNew } = svc.authorize(req, CID);
    expect(isNew).toBe(false);
  });

  it('permite mesma NSU em terminais diferentes', () => {
    const svc = makeService();
    const { transaction: t1 } = svc.authorize({ nsu: 'NSU-1', terminalId: 'T-1', amount: 10 }, CID);
    const { transaction: t2 } = svc.authorize({ nsu: 'NSU-1', terminalId: 'T-2', amount: 10 }, CID);
    expect(t1.id).not.toBe(t2.id);
  });
});

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

describe('TransactionService.getById', () => {
  it('retorna a transação pelo id', () => {
    const svc = makeService();
    const { transaction } = svc.authorize({ nsu: 'N1', terminalId: 'T1', amount: 1 }, CID);
    const found = svc.getById(transaction.id, CID);
    expect(found.id).toBe(transaction.id);
  });

  it('lança 404 para id desconhecido', () => {
    const svc = makeService();
    expect(() => svc.getById('UNKNOWN-ID', CID)).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });
});

// ---------------------------------------------------------------------------
// getByNsuAndTerminal
// ---------------------------------------------------------------------------

describe('TransactionService.getByNsuAndTerminal', () => {
  it('retorna a transação pela dupla (nsu, terminalId)', () => {
    const svc = makeService();
    svc.authorize({ nsu: 'NSU-X', terminalId: 'T-X', amount: 5 }, CID);
    const found = svc.getByNsuAndTerminal('NSU-X', 'T-X', CID);
    expect(found.nsu).toBe('NSU-X');
  });

  it('lança 404 para (nsu, terminalId) inexistente', () => {
    const svc = makeService();
    expect(() => svc.getByNsuAndTerminal('NONE', 'T-X', CID)).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });
});

// ---------------------------------------------------------------------------
// transition — máquina de estados
// ---------------------------------------------------------------------------

describe('TransactionService.transition — transições válidas', () => {
  it('AUTHORIZED → CONFIRMED', () => {
    const svc = makeService();
    const { transaction } = svc.authorize({ nsu: 'N1', terminalId: 'T1', amount: 1 }, CID);
    const updated = svc.transition(transaction, 'CONFIRMED', CID);
    expect(updated.state).toBe('CONFIRMED');
  });

  it('AUTHORIZED → VOIDED', () => {
    const svc = makeService();
    const { transaction } = svc.authorize({ nsu: 'N1', terminalId: 'T1', amount: 1 }, CID);
    const updated = svc.transition(transaction, 'VOIDED', CID);
    expect(updated.state).toBe('VOIDED');
  });

  it('CONFIRMED → VOIDED', () => {
    const svc = makeService();
    const { transaction } = svc.authorize({ nsu: 'N1', terminalId: 'T1', amount: 1 }, CID);
    const confirmed = svc.transition(transaction, 'CONFIRMED', CID);
    const voided = svc.transition(confirmed, 'VOIDED', CID);
    expect(voided.state).toBe('VOIDED');
  });
});

describe('TransactionService.transition — idempotência (mesmo estado)', () => {
  it('AUTHORIZED → AUTHORIZED retorna a transação sem erro (no-op)', () => {
    const svc = makeService();
    const { transaction } = svc.authorize({ nsu: 'N1', terminalId: 'T1', amount: 1 }, CID);
    // O estado AUTHORIZED não é destino de transition, mas o teste de no-op aplica-se a CONFIRMED
    const confirmed = svc.transition(transaction, 'CONFIRMED', CID);
    const again = svc.transition(confirmed, 'CONFIRMED', CID);
    expect(again.state).toBe('CONFIRMED');
  });

  it('VOIDED → VOIDED é no-op', () => {
    const svc = makeService();
    const { transaction } = svc.authorize({ nsu: 'N1', terminalId: 'T1', amount: 1 }, CID);
    const voided = svc.transition(transaction, 'VOIDED', CID);
    const again = svc.transition(voided, 'VOIDED', CID);
    expect(again.state).toBe('VOIDED');
  });
});

describe('TransactionService.transition — transições inválidas', () => {
  it('VOIDED → CONFIRMED lança 409', () => {
    const svc = makeService();
    const { transaction } = svc.authorize({ nsu: 'N1', terminalId: 'T1', amount: 1 }, CID);
    const voided = svc.transition(transaction, 'VOIDED', CID);
    expect(() => svc.transition(voided, 'CONFIRMED', CID)).toThrow(
      expect.objectContaining({ statusCode: 409, errorCode: 'invalid_transaction_state' }),
    );
  });
});
