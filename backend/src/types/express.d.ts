import type { AuthContext } from '../middleware/authenticate.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};