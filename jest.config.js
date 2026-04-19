/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/test/**/*.test.ts'],
  setupFiles: ['<rootDir>/src/test/setup.ts'],
  // uuid v13 ships ESM-only; redirect to a CJS shim using Node's crypto.randomUUID()
  moduleNameMapper: {
    '^uuid$': '<rootDir>/src/test/__mocks__/uuid.js',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        noUncheckedIndexedAccess: false,
        exactOptionalPropertyTypes: false,
      },
    }],
  },
};
