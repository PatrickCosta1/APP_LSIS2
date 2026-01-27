import crypto from 'node:crypto';
import { z } from 'zod';
import type { Collections, CustomerDoc } from './db';
import { llmChatReply } from './llm/orchestrator';
import { buildAssistantBaseContext } from './assistantContext';

export const chatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().min(1).optional()
});

export type ChatMessageRole = 'user' | 'assistant' | 'system';

export type ChatHistoryItem = { role: ChatMessageRole; content: string; createdAt: string };

export type ChatHistoryResponse = {
  conversationId: string | null;
  messages: ChatHistoryItem[];
};

export type ChatReplyResponse = {
  conversationId: string;
  reply: string;
};

const SAFE_MAX_HISTORY = 50;
async function ensureConversation(c: Collections, customerId: string, conversationId?: string) {
  const now = new Date();

  if (conversationId) {
    const existing = await c.chatConversations.findOne({ id: conversationId, customer_id: customerId }, { projection: { _id: 0, id: 1 } });
    if (existing?.id) return existing.id;
  }

  // Reusa a mais recente (se existir)
  const latest = await c.chatConversations
    .find({ customer_id: customerId }, { projection: { _id: 0, id: 1 } })
    .sort({ updated_at: -1 })
    .limit(1)
    .toArray();
  if (latest[0]?.id) return latest[0].id;

  // Cria nova
  const id = crypto.randomUUID();
  await c.chatConversations.insertOne({ id, customer_id: customerId, title: null, created_at: now, updated_at: now });
  return id;
}

async function listConversationMessages(c: Collections, customerId: string, conversationId: string, limit: number) {
  const lim = Math.max(1, Math.min(SAFE_MAX_HISTORY, Math.floor(limit)));
  const rows = await c.chatMessages
    .find({ customer_id: customerId, conversation_id: conversationId }, { projection: { _id: 0, role: 1, content: 1, created_at: 1 } })
    .sort({ created_at: 1 })
    .limit(lim)
    .toArray();

  return rows.map((r: any) => ({
    role: (r.role as ChatMessageRole) ?? 'assistant',
    content: String(r.content ?? ''),
    createdAt: (r.created_at ? new Date(r.created_at) : new Date()).toISOString()
  }));
}

async function getCustomerOrNull(c: Collections, customerId: string): Promise<CustomerDoc | null> {
  return (await c.customers.findOne({ id: customerId }, { projection: { _id: 0 } })) as any;
}

export async function getCustomerChatHistory(c: Collections, customerId: string, opts?: { conversationId?: string; limit?: number }): Promise<ChatHistoryResponse> {
  const convId = opts?.conversationId;
  const limit = opts?.limit ?? 50;

  if (convId) {
    const exists = await c.chatConversations.findOne({ id: convId, customer_id: customerId }, { projection: { _id: 0, id: 1 } });
    if (!exists) return { conversationId: null, messages: [] };
    const messages = await listConversationMessages(c, customerId, convId, limit);
    return { conversationId: convId, messages };
  }

  const latest = await c.chatConversations
    .find({ customer_id: customerId }, { projection: { _id: 0, id: 1 } })
    .sort({ updated_at: -1 })
    .limit(1)
    .toArray();

  const latestId = latest[0]?.id ?? null;
  if (!latestId) return { conversationId: null, messages: [] };

  const messages = await listConversationMessages(c, customerId, latestId, limit);
  return { conversationId: latestId, messages };
}

export async function handleCustomerChat(c: Collections, customerId: string, body: unknown): Promise<{ status: number; body: ChatReplyResponse | { message: string } }> {
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { message: 'Pedido inválido (message obrigatório).' } };
  }

  const customer = await getCustomerOrNull(c, customerId);
  if (!customer) return { status: 404, body: { message: 'Cliente não encontrado' } };

  const conversationId = await ensureConversation(c, customerId, parsed.data.conversationId);

  const now = new Date();
  const userMsgId = crypto.randomUUID();
  await c.chatMessages.insertOne({
    id: userMsgId,
    customer_id: customerId,
    conversation_id: conversationId,
    role: 'user',
    content: parsed.data.message,
    created_at: now
  });
  const nowUtc = new Date().toISOString();

  const baseContext = await buildAssistantBaseContext(c, customer, {
    end: undefined,
    includeGrid: true,
    includeEnergyWindows: true,
    includeTopAppliances30d: true,
    topAppliancesLimit: 5
  });

  const recent = await c.chatMessages
    .find({ customer_id: customerId, conversation_id: conversationId }, { projection: { _id: 0, role: 1, content: 1, created_at: 1 } })
    .sort({ created_at: -1 })
    .limit(16)
    .toArray();

  const history: Array<{ role: 'user' | 'assistant'; content: string }> = (recent as any[])
    .reverse()
    .map((m) => {
      const role: 'user' | 'assistant' = m?.role === 'user' ? 'user' : 'assistant';
      return { role, content: String(m?.content ?? '') };
    })
    .slice(0, -1);

  const context = baseContext;

  const llm = await llmChatReply({
    customer: { id: customer.id, name: customer.name ?? null, tariff: (customer as any).tariff ?? null, contractedPowerKva: (customer as any).contracted_power_kva ?? null },
    nowUtc,
    context,
    history,
    message: parsed.data.message
  });

  const reply = llm?.reply?.trim()
    ? llm.reply.trim()
    : 'O assistente de chat está desativado ou indisponível. Configure GROQ_API_KEY (e, se necessário, KYNEX_GROQ_ENABLED=true).';

  const assistantMsgId = crypto.randomUUID();
  await c.chatMessages.insertOne({ id: assistantMsgId, customer_id: customerId, conversation_id: conversationId, role: 'assistant', content: reply, created_at: new Date() });

  return { status: 200, body: { conversationId, reply } };
}
