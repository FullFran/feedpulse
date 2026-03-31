declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: string;
    tenantId?: string;
  }
}

export {};
