# Kynex Monorepo

Monorepo académico com frontend React + TypeScript (Vite) e backend Express + TypeScript, usando npm workspaces.

## Requisitos
- Node.js 20+
- npm 10+

## Como rodar
- Instalar dependências: `npm install`
- Configurar MongoDB:
	- `MONGODB_URI` (obrigatória)
	- `MONGODB_DB` (opcional)
	- (Produção) garantir que a variável está definida no serviço (ex.: Render)
- Configurar Frontend (produção):
	- `VITE_API_BASE` (URL do backend; ex.: Render). Sem isto, o frontend pode tentar `localhost`.
- (Opcional) Treinar IA:
	- `py -3 apps/backend/ai_train.py --days 14 --lambda 2.0`
- Desenvolver backend: `npm run dev:backend`
	- Gera novas leituras sintéticas continuamente (por defeito a cada 10s, simulando passos de 15 minutos)
	- Ajuste com `KYNEX_SIM_TICK_MS=5000` (mais rápido) / `KYNEX_SIM_TICK_MS=30000` (mais lento)
- Desenvolver frontend: `npm run dev:frontend`
- Abrir a app (Vite imprime o URL) e completar o Onboarding (é a página inicial quando não existe perfil)

## Fluxo esperado
- O Onboarding cria um cliente via `POST /ai/customers` e guarda o `customerId` em `localStorage` (`kynex:customerId`).
- A Dashboard usa esse `customerId` para buscar dados reais:
	- `GET /customers/:id/telemetry/now`
	- `GET /customers/:id/chart?range=dia|semana|mes`

## Estatísticas (dinâmico)
- A página “Estatísticas” (Charts) preenche automaticamente:
	- Eficiência Horária
	- Análise Contratual (inclui Simulador de Preços)
	- Ofertas do mercado
	- Insights gerados a partir da telemetria

## Equipamentos (dinâmico)
- A página “Equipamentos” usa dados por cliente (estimativa/seed) via:
	- `GET /customers/:id/appliances/summary?days=30`
- O backend agrega “sessões” por equipamento em MongoDB na coleção `customer_appliance_usage`.

## Assistente (chat)
- O botão central (estrela) abre um chat/modal no frontend.
- Endpoints:
	- `GET /customers/:id/chat?conversationId=...&limit=50` (histórico)
	- `POST /customers/:id/chat` com `{ "message": "...", "conversationId"?: "..." }`
- Perguntas suportadas (exemplos):
	- "Quanto gastei nas últimas 24h?" / "na última semana" / "este mês"
	- "Qual o equipamento que mais consome?"
	- "Eficiência horária" / "melhores horas" / "horas de pico"
	- "Potência contratada" / "kVA" / "estou perto do limite?"
	- "Dá-me 3 dicas para poupar"
- As respostas podem incluir `cards` estruturados (metric/tip/list) e memória por conversa (ex.: "sim", "mais").
- Coleções MongoDB:
	- `chat_conversations`
	- `chat_messages`

## Estrutura
- apps/frontend: SPA em React + Vite.
- apps/backend: API Express com MongoDB.

## Notas
- Usar `npm install` na raiz para instalar dependências de todos os pacotes.
- Variáveis de ambiente sensíveis ficam fora do repositório (.env).
- Em dev, se a porta 4000 estiver ocupada, pode iniciar o backend com `PORT=4100`.
