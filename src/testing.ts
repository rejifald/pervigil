// Test-only surface. Kept out of the main barrel so production bundles never
// pull in the mock driver.
export { MockWakeLockDriver } from "./drivers/mock.js";
export type { MockSetStateCall } from "./drivers/mock.js";
