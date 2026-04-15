export type TransactionState = 'AUTHORIZED' | 'CONFIRMED' | 'VOIDED';

export interface Transaction {
  id: string;           // UUID, uppercase
  nsu: string;
  terminalId: string;
  amount: number;
  state: TransactionState;
  externalApiId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthorizeRequest {
  nsu: string;
  amount: number;
  terminalId: string;
}

export interface ConfirmRequest {
  transactionId: string;
}

export interface VoidRequest {
  transactionId?: string;
  nsu?: string;
  terminalId?: string;
}

export interface AppError extends Error {
  statusCode: number;
  errorCode: string;
}
