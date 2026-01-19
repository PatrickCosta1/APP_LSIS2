import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

function tryLoadEnv(p?: string) {
  try {
    if (p) {
      if (!fs.existsSync(p)) return;
      dotenv.config({ path: p });
      return;
    }
    dotenv.config();
  } catch {
    // ignore
  }
}

// 1) tenta no cwd (útil se o backend for executado a partir da raiz)
tryLoadEnv();

// 2) se não encontrou, tenta na raiz do monorepo (útil quando cwd=apps/backend)
if (!process.env.MONGODB_URI) {
  const monorepoRootEnv = path.resolve(__dirname, '..', '..', '..', '.env');
  tryLoadEnv(monorepoRootEnv);
}
