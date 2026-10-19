// Test environment. DATABASE_URL must point at a throwaway Postgres with the migrations applied and the seed run.
process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "test-secret-test-secret-test-secret";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/retailr_test";
process.env.AUTH_RATE_LIMIT = "100000";
process.env.RATE_LIMIT = "100000";
process.env.STORAGE_DRIVER = "local";
process.env.API_PUBLIC_URL = "http://api.test";
process.env.LOCAL_UPLOAD_DIR = require("os").tmpdir() + "/retailr-test-uploads";
process.env.UPLOAD_MAX_BYTES = "200000";
process.env.DEMO_CARD_PAYMENTS = "true";
process.env.TRACK_RATE_LIMIT = "100000";
