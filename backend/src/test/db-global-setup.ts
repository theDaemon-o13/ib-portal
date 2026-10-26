import { recreateTestDb } from '../../scripts/test-db.js';

export default async function setup() {
  await recreateTestDb();
}
