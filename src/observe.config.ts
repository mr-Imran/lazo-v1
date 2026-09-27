/**
 * @nestjs/observe ships telemetry to nestjs.com and needs real credentials.
 * Without them the agent retries and logs `Telemetry rejected (401)`, so the
 * module is only registered once both values are present.
 */
export const isObserveConfigured = (): boolean =>
  Boolean(process.env.OBSERVE_APP_KEY && process.env.OBSERVE_APP_SECRET);
