// Test environment. DATABASE_URL must point at a throwaway Postgres with the migrations applied and the seed run.
process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-secret-test-secret-test-secret";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/retailr_test";
process.env.AUTH_RATE_LIMIT = "100000";
process.env.RATE_LIMIT = "100000";
