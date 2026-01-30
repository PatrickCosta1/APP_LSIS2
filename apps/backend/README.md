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

\#\#\# Shelly (candeeiro) — MQTT (HiveMQ)
Se estas variáveis estiverem definidas, o endpoint do candeeiro usa RPC via MQTT (porta TLS 8883).

- `SHELLY_MQTT_BROKER` (obrigatória; host do broker)
- `SHELLY_MQTT_PORT` (opcional; default: `8883`)
- `SHELLY_MQTT_USERNAME` (obrigatória)
- `SHELLY_MQTT_PASSWORD` (obrigatória)
- `SHELLY_MQTT_TOPIC` (obrigatória; tópico RPC, ex.: `shelly.../rpc`)
- `SHELLY_MQTT_SRC` (opcional; default: `kynex-backend`)
- `SHELLY_MQTT_TIMEOUT_MS` (opcional; default: `2500`)
- `SHELLY_MQTT_REJECT_UNAUTHORIZED` (opcional; default: `true`)


### Exemplo HiveMQ Cloud (produção)

```
SHELLY_MQTT_BROKER=3885b212bedd4eebb03ddfd6e5eff3cc.s1.eu.hivemq.cloud
SHELLY_MQTT_PORT=8883
SHELLY_MQTT_TOPIC=shellyazplug-e4b3232ea858/rpc
SHELLY_MQTT_USERNAME=kynex
SHELLY_MQTT_PASSWORD=1a2b3c4dA
```

Fallback: se MQTT não estiver configurado, usa o modo HTTP local:
- `SHELLY_BASE_URL` (opcional; default: `http://192.168.1.185`)

\#\#\# Telemetria 15m (CSV / modelo)
- `KYNEX_SIM_TICK_MS` (opcional; default: `900000` = 15 min)
- `KYNEX_TELEMETRY_CSV_PATH` (opcional; path para CSV 15m real, ex.: `meusDados1Ano.csv`)
- `KYNEX_TELEMETRY_CSV_CUSTOMER_ID` (opcional; customerId a popular com o CSV)
- `KYNEX_TELEMETRY_CSV_OVERWRITE=1` (opcional; apaga e reimporta)
- `KYNEX_TELEMETRY_MODEL_PATH` (opcional; default: `apps/backend/data/consumption_model_15m.json`)

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

### NILM (fingerprints + feedback loop)
- Worker assíncrono: calcula sessões NILM e atualiza fingerprints por cliente.
	- `KYNEX_NILM_ENABLED=0` desliga o worker
	- `KYNEX_NILM_TICK_MS` intervalo do worker (default: 10 min)
- Feedback (rótulo por sessão):
	- `POST /customers/:customerId/nilm/sessions/:sessionId/label` com `{ "label": "..." }` (ou `{ "label": null }`)

### Forecast mensal (mais regressoras)
O `GET /customers/:customerId/telemetry/now` passa a tentar um modelo diário com lag + sazonalidade + IPMA.
- `forecastMethod` indica o método efetivo
- `forecastWeatherOk` indica se IPMA foi usado
- Campos novos (opcionais para UI): `forecastMonthBillEuros*` incluem termo fixo diário

### Chat
- `GET /customers/:customerId/chat?conversationId=...&limit=50`
- `POST /customers/:customerId/chat` com `{ "message": "...", "conversationId"?: "..." }`

### Endpoints por cliente (Dashboard dinâmica)
- `GET /customers/:customerId/telemetry/now` — métricas do cliente (últimas 24h + watts atuais).
- `GET /customers/:customerId/chart?range=dia|semana|mes` — série agregada (com consumido/previsto).

## Base de dados
- MongoDB (coleções principais): `customers`, `customerTelemetry15m`, `chatConversations`, `chatMessages`.
- Nota: `customerApplianceUsage` e `appliances` passam a ser legado para “Equipamentos” (agora inferidos a partir do consumo agregado em `customerTelemetry15m`).

## IA (dados sintéticos + treino + previsão)
O backend inclui scripts Python para treino/geração dos modelos (ex.: `ai_train.py`) e usa telemetria guardada em MongoDB.

### Treinar o modelo
- `py -3 apps/backend/ai_train.py --days 14 --lambda 2.0`

\#\#\# Usar o chat com LLM
- Defina `GROQ_API_KEY` e (opcionalmente) `KYNEX_GROQ_ENABLED=true`.
- Reinicie o backend. Sem a chave, o endpoint de chat devolve uma mensagem de fallback indicando que o LLM está desativado/indisponível.
