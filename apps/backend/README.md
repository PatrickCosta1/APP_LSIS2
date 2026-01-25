# Backend

API Express em TypeScript com MongoDB.

## Scripts
- `npm run dev` — modo desenvolvimento com recarga (`ts-node-dev`).
- `npm run build` — compila para `dist/`.
- `npm start` — executa o build.
- `npm run lint` — checa lint.
- `npm test` — roda Jest (usa Supertest para endpoints).

## Variáveis de ambiente
- `MONGODB_URI` (obrigatória)
- `MONGODB_DB` (opcional)# Backend

API Express em TypeScript com MongoDB.

## Scripts
- `npm run dev` — modo desenvolvimento com recarga (`ts-node-dev`).
- `npm run build` — compila para `dist/`.
- `npm start` — executa o build.
- `npm run lint` — checa lint.
- `npm test` — roda Jest (usa Supertest para endpoints).

## Variáveis de ambiente
- `MONGODB_URI` (obrigatória)
- `MONGODB_DB` (opcional)

### LLM (Groq ou OpenRouter)
- `LLM_MODE=full|off` (default: `full`)
- `LLM_PROVIDER=groq|openrouter` (default: `openrouter`)

Se `LLM_PROVIDER=groq`:
- `GROQ_API_KEY` (obrigatória para ativar o LLM)
- `GROQ_MODEL` (opcional; default: `llama-3.1-8b-instant`)
- `GROQ_TIMEOUT_MS` (opcional; default: `12000`)
- `GROQ_BASE_URL` (opcional; default: `https://api.groq.com/openai/v1`)

Se `LLM_PROVIDER=openrouter`:
- `OPENROUTER_API_KEY` (obrigatória para ativar o LLM)
- `OPENROUTER_MODEL` (opcional; default: `arcee-ai/trinity-mini:free`)
- `OPENROUTER_TIMEOUT_MS` (opcional; default: `12000`)

## Endpoints atuais
- `GET /health` — status simples.

### Endpoints por cliente (principais)
- `GET /customers/:customerId/telemetry/now`
- `GET /customers/:customerId/chart?range=dia|semana|mes`
- `GET /customers/:customerId/appliances/summary?days=30`
- `GET /customers/:customerId/appliances/:applianceId/weekly?days=7`
- `GET /customers/:customerId/opendata/national`

### Chat
- `GET /customers/:customerId/chat?conversationId=...&limit=50`
- `POST /customers/:customerId/chat` com `{ "message": "...", "conversationId"?: "..." }`

### Endpoints por cliente (Dashboard dinâmica)
- `GET /customers/:customerId/telemetry/now` — métricas do cliente (últimas 24h + watts atuais).
- `GET /customers/:customerId/chart?range=dia|semana|mes` — série agregada (com consumido/previsto).

## Base de dados
- MongoDB (coleções principais): `customers`, `customerTelemetry15m`, `customerApplianceUsage`, `appliances`, `chatConversations`, `chatMessages`.

## IA (dados sintéticos + treino + previsão)
O backend inclui scripts Python para treino/geração dos modelos (ex.: `ai_train.py`) e usa telemetria guardada em MongoDB.

### Treinar o modelo
- `py -3 apps/backend/ai_train.py --days 14 --lambda 2.0`

### Usar o LLM no chat
- Crie `.env` na raiz do monorepo (ou use as variáveis no seu serviço) e defina `OPENROUTER_API_KEY`.
- Reinicie o backend. Sem a chave, o endpoint de chat devolve uma mensagem de fallback indicando que o LLM está desativado/indisponível.


### LLM (OpenRouter)
- `OPENROUTER_API_KEY` (obrigatória para ativar o LLM)
- `LLM_MODE=full|off` (default: `full`)
- `OPENROUTER_MODEL` (opcional; default: `arcee-ai/trinity-mini:free`)
- `OPENROUTER_TIMEOUT_MS` (opcional; default: `12000`)

## Endpoints atuais
- `GET /health` — status simples.

### Endpoints por cliente (principais)
- `GET /customers/:customerId/telemetry/now`
- `GET /customers/:customerId/chart?range=dia|semana|mes`
- `GET /customers/:customerId/appliances/summary?days=30`
- `GET /customers/:customerId/appliances/:applianceId/weekly?days=7`
- `GET /customers/:customerId/opendata/national`

### Chat
- `GET /customers/:customerId/chat?conversationId=...&limit=50`
- `POST /customers/:customerId/chat` com `{ "message": "...", "conversationId"?: "..." }`

### Endpoints por cliente (Dashboard dinâmica)
- `GET /customers/:customerId/telemetry/now` — métricas do cliente (últimas 24h + watts atuais).
- `GET /customers/:customerId/chart?range=dia|semana|mes` — série agregada (com consumido/previsto).

## Base de dados
- MongoDB (coleções principais): `customers`, `customerTelemetry15m`, `customerApplianceUsage`, `appliances`, `chatConversations`, `chatMessages`.

## IA (dados sintéticos + treino + previsão)
O backend inclui scripts Python para treino/geração dos modelos (ex.: `ai_train.py`) e usa telemetria guardada em MongoDB.

### Treinar o modelo
- `py -3 apps/backend/ai_train.py --days 14 --lambda 2.0`

### Usar o LLM no chat
- Crie `.env` na raiz do monorepo (ou use as variáveis no seu serviço) e defina `OPENROUTER_API_KEY`.
- Reinicie o backend. Sem a chave, o endpoint de chat devolve uma mensagem de fallback indicando que o LLM está desativado/indisponível.
