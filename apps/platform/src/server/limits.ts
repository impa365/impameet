import { RateLimiter } from './security/rate-limit';

const MINUTE = 60_000;

export const limits = {
  signupPerIp: new RateLimiter(5, 10 * MINUTE),
  loginPerIp: new RateLimiter(20, MINUTE),
  loginPerAccount: new RateLimiter(5, MINUTE),
  joinPerIp: new RateLimiter(30, MINUTE),
  lobbyPollPerIp: new RateLimiter(120, MINUTE),
  handPerIp: new RateLimiter(60, MINUTE),
  moderationPerUser: new RateLimiter(120, MINUTE),
  writePerUser: new RateLimiter(60, MINUTE),
};
