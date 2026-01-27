\# Backend

API Express em TypeScript com MongoDB.

\#\# Scripts
- `npm run dev` — modo desenvolvimento com recarga (`ts-node-dev`).
- `npm run build` — compila para `dist/`.
- `npm start` — executa o build.
- `npm run lint` — checa lint.
- `npm test` — roda Jest (usa Supertest para endpoints).

\#\# Variáveis de ambiente
- `MONGODB_URI` (obrigatória)
- `MONGODB_DB` (opcional)

\#\# IA (Chat)
O Groq é usado **apenas** no chatbot de conversação. Todo o resto (dicas/sugestões/insights) é gerado por heurísticas locais.

Para ativar o chat com LLM:
- `GROQ_API_KEY` (obrigatória)
- `GROQ_MODEL` (opcional; default do Groq)
- `GROQ_TIMEOUT_MS` (opcional; default: `12000`)
- `GROQ_BASE_URL` (opcional; default: `https://api.groq.com/openai/v1`)
- `KYNEX_GROQ_ENABLED=true|false` (opcional; força habilitar/desabilitar)

\#\# Endpoints atuais
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

\#\#\# Usar o chat com LLM
- Defina `GROQ_API_KEY` e (opcionalmente) `KYNEX_GROQ_ENABLED=true`.
- Reinicie o backend. Sem a chave, o endpoint de chat devolve uma mensagem de fallback indicando que o LLM está desativado/indisponível.
