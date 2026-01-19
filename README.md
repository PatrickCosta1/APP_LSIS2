# Kynex Monorepo

Monorepo académico com frontend React + TypeScript (Vite) e backend Express + TypeScript, usando npm workspaces.

## Requisitos
- Node.js 20+
- npm 10+

## Como rodar
- Instalar dependências: `npm install`
- (Opcional) Gerar dados + treinar IA:
	- `py -3 apps/backend/ai_generate.py --customers 25 --days 14 --steps 96`
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

## Estrutura
- apps/frontend: SPA em React + Vite.
- apps/backend: API Express com SQLite embutido.

## Notas
- Usar `npm install` na raiz para instalar dependências de todos os pacotes.
- Variáveis de ambiente sensíveis ficam fora do repositório (.env).
