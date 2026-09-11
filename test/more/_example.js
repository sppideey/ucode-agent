// Smoke check that feature suites are picked up. Real suites sit beside it.
export default async function ({ test, section, ok }) {
  section('suites');
  await test('feature suites in test/more are loaded', () => ok(true));
}
