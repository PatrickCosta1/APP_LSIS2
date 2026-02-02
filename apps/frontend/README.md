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

## App instalável (PWA)
O frontend está configurado como PWA (instalável) e funciona em Android/iOS, desde que esteja publicado em HTTPS.

### Requisitos
- A app tem de estar publicada (ou servida) em HTTPS.
- O backend (Render) tem de aceitar chamadas do domínio do frontend (CORS), se aplicável.

### Configuração
- No host do frontend (ex.: Netlify), definir `VITE_API_BASE` com a URL pública do backend no Render.
- Fazer build e publicar a pasta `apps/frontend/dist`.

### Instalar no telemóvel
- Android (Chrome/Edge): abrir o site publicado → menu do browser → "Instalar app".
- iPhone (Safari): abrir o site publicado → Partilhar → "Adicionar ao ecrã principal".
