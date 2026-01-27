export type AssistantTextKind =
  | 'appliances_summary_suggestion'
  | 'appliance_weekly_tip'
  | 'ai_insights_summary'
  | 'electrical_health_warning'
  | 'power_suggestion_message'
  | 'security_alert_message'
  | 'contract_tariff_suggestion_message';

export async function llmImproveText(opts: {
  kind: AssistantTextKind;
  customer: { id: string; name?: string | null; tariff?: string | null };
  context: unknown;
  draft: string;
  maxTokens?: number;
}): Promise<string | null> {
  // LLM removido por completo fora do chat.
  // Mantemos a API para compatibilidade: ao devolver null, o backend usa sempre o texto heurístico.
  return null;
}

export async function llmGenerateText(opts: {
  kind: AssistantTextKind;
  customer: { id: string; name?: string | null; tariff?: string | null };
  context: unknown;
  prompt: string;
  maxTokens?: number;
}): Promise<string | null> {
  // LLM removido por completo fora do chat.
  return null;
}
