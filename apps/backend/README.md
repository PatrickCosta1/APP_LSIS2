# Backend

API Express em TypeScript com MongoDB.

## Scripts
- `npm run dev` — modo desenvolvimento com recarga (`ts-node-dev`).
- `npm run build` — compila para `dist/`.
- `npm start` — executa o build.
- `npm run lint` — checa lint.
- `npm test` — roda Jest (usa Supertest para endpoints).

## Endpoints atuais
- `GET /health` — status simples.
- `GET /telemetry/now` — leitura atual, custo/hora, previsão mensal aproximada.
- `GET /telemetry/day` — pontos recentes (15m).
- `GET /telemetry/range?from&to&bucket=15m|raw` — série temporal.
- `GET /telemetry/forecast` — previsão horária sintética.
- `GET /events` ou `/nilm/events` — eventos NILM (pendentes/confirmados, confiança).
- `POST /events/:id/confirm` — confirma evento com `{ label: string }`.
- `GET /appliances` — aparelhos com métricas de uso e eficiência.
- `GET /appliances/:id/usage` — histórico de uso.
- `GET /alerts` — alertas de segurança/eficiência; `POST /alerts/:id/resolve` fecha.
- `GET /advice/contract` — recomendação atual.
- `GET /contract/profile` — perfil contratual atual.
- `POST /contract/simulate` — simulação de potência/tarifa.
- `GET /reports/monthly` — agregados diários (kWh, € e pico).

### Endpoints por cliente (Dashboard dinâmica)
- `GET /customers/:customerId/telemetry/now` — métricas do cliente (últimas 24h + watts atuais).
- `GET /customers/:customerId/chart?range=dia|semana|mes` — série agregada (com consumido/previsto).

## Base de dados
- MongoDB (configurado via variáveis de ambiente).
- Variáveis:
	- `MONGODB_URI` (obrigatória)
	- `MONGODB_DB` (opcional; default: `kynex` ou o nome presente no URI)

O backend cria índices e faz seed automático de dados globais (telemetria demo, NILM, aparelhos, alertas e contrato).

## IA (dados sintéticos + treino + previsão)
Para termos “IA a funcionar” sem depender de dados reais, o backend suporta um modelo linear treinado em Python e previsão via API.

### Telemetria contínua no servidor
Ao correr `npm run dev` / `npm start`, o backend também adiciona novas leituras sintéticas automaticamente para cada cliente existente.

- Intervalo do “tick” (em ms): `KYNEX_SIM_TICK_MS` (default: `10000`)
- Cada tick simula +15 minutos por cliente e grava em `customer_telemetry_15m` com `is_estimated=true`.

### 2) Treinar o modelo
- `py -3 apps/backend/ai_train.py --days 14 --lambda 2.0`

Isto exporta o modelo para:
- `apps/backend/data/ai_model.json`

### 3) Usar o modelo via API
- `GET /ai/customers` — lista clientes (para obter `customerId`).
- `GET /ai/forecast/:customerId?horizon=24` — prevê os próximos intervalos de 15m.
- `GET /ai/model` — metadata/métricas do modelo treinado.
