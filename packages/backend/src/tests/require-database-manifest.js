// Execute before application imports or any destructive integration-test setup.
if (!process.env.TEST_DATABASE_MANIFEST) {
  throw new Error('Integration tests require an isolated database manifest. Run npm run test:e2e instead.');
}
