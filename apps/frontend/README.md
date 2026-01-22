# Frontend

SPA em React + TypeScript usando Vite.

## Scripts
- `npm run dev` — servidor Vite com HMR.
- `npm run build` — build de produção.
- `npm run preview` — serve o build.
- `npm run lint` — checa lint.
- `npm run test` — testa com Vitest + Testing Library.

## Notas
- Configuração de testes usa ambiente jsdom e `src/setupTests.ts`.
- Estilos base em `src/index.css` e `src/App.css`.

## Backend / API Base
- Em produção, define `VITE_API_BASE` (ex.: `https://app-lsis2.onrender.com`) no host do frontend.
- Em dev, as tasks do VS Code já definem `VITE_API_BASE=http://localhost:4100`.
