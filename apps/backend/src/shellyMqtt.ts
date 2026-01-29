import crypto from 'node:crypto';
import mqtt from 'mqtt';

type ShellyMqttConfig = {
  broker: string;
  port: number;
  username: string;
  password: string;
  topic: string;
  src: string;
  timeoutMs: number;
  rejectUnauthorized: boolean;
};

function envBool(name: string, def: boolean) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return def;
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}

function getShellyMqttConfig(topicOverride?: string): ShellyMqttConfig | null {
  const broker = String(process.env.SHELLY_MQTT_BROKER ?? '').trim();
  const username = String(process.env.SHELLY_MQTT_USERNAME ?? '').trim();
  const password = String(process.env.SHELLY_MQTT_PASSWORD ?? '').trim();
  const topic = String(topicOverride ?? process.env.SHELLY_MQTT_TOPIC ?? '').trim();
  if (!broker || !username || !password || !topic) return null;

  const portRaw = Number(process.env.SHELLY_MQTT_PORT ?? 8883);
  const port = Number.isFinite(portRaw) ? Math.max(1, Math.min(65535, portRaw)) : 8883;

  const timeoutRaw = Number(process.env.SHELLY_MQTT_TIMEOUT_MS ?? 2500);
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.max(400, Math.min(12000, timeoutRaw)) : 2500;

  const src = String(process.env.SHELLY_MQTT_SRC ?? 'kynex-backend').trim() || 'kynex-backend';
  const rejectUnauthorized = envBool('SHELLY_MQTT_REJECT_UNAUTHORIZED', true);

  return { broker, port, username, password, topic, src, timeoutMs, rejectUnauthorized };
}

function pickOnValue(payload: any): boolean | null {
  const candidates = [
    payload?.result?.output,
    payload?.result?.on,
    payload?.result?.ison,
    payload?.result?.isOn,
    payload?.output,
    payload?.on,
    payload?.ison,
    payload?.isOn,
    payload?.state
  ];
  for (const c of candidates) {
    if (typeof c === 'boolean') return c;
    if (typeof c === 'number') return c !== 0;
    if (typeof c === 'string') {
      const v = c.trim().toLowerCase();
      if (v === 'on') return true;
      if (v === 'off') return false;
    }
  }
  return null;
}

async function shellyRpc(method: string, params: Record<string, any>, opts?: { topic?: string }) {
  const cfg = getShellyMqttConfig(opts?.topic);
  if (!cfg) {
    const err: any = new Error('SHELLY_MQTT_NOT_CONFIGURED');
    err.code = 'SHELLY_MQTT_NOT_CONFIGURED';
    throw err;
  }


  const id = crypto.randomInt(1, 2 ** 31 - 1);
  const payload = { id, src: cfg.src, method, params };
  console.log('[SHELLY][MQTT] RPC request:', { topic: cfg.topic, payload });

  return await new Promise<any>((resolve, reject) => {
    const client = mqtt.connect({
      host: cfg.broker,
      port: cfg.port,
      protocol: 'mqtts',
      username: cfg.username,
      password: cfg.password,
      protocolVersion: 5,
      connectTimeout: cfg.timeoutMs,
      clean: true,
      reconnectPeriod: 0,
      rejectUnauthorized: cfg.rejectUnauthorized
    });

    let done = false;
    const finish = (err?: unknown, value?: any) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      try {
        client.end(true);
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(value);
    };

    const timeout = setTimeout(() => {
      const err: any = new Error('SHELLY_MQTT_TIMEOUT');
      err.code = 'SHELLY_MQTT_TIMEOUT';
      finish(err);
    }, cfg.timeoutMs);

    client.on('error', (e) => {
      if (done) return;
      finish(e);
    });

    client.on('connect', () => {
      // Subscreve o tópico de comando (eco), o tópico de resposta (src/rpc) e eventos
      const topics = [
        cfg.topic, // comando (eco)
        `${cfg.src}/rpc`, // resposta do Shelly
        `${cfg.topic.replace(/\/rpc$/, '')}/events/rpc` // eventos
      ];
      client.subscribe(topics, { qos: 1 }, (subErr) => {
        if (subErr) return finish(subErr);
        client.publish(cfg.topic, JSON.stringify(payload), { qos: 1 }, (pubErr) => {
          if (pubErr) return finish(pubErr);
        });
      });
    });

    client.on('message', (topic, message) => {
      let json: any;
      try {
        json = JSON.parse(message.toString('utf8'));
      } catch {
        console.warn('[SHELLY][MQTT] Mensagem inválida recebida:', message.toString('utf8'));
        return;
      }

      console.log('[SHELLY][MQTT] Mensagem recebida:', { topic, id: json?.id, esperado: id, json });

      if (json?.id !== id) return;

      // Ignora o eco do próprio pedido (normalmente vem com method+params mas sem result)
      if (topic === cfg.topic && json?.result == null && json?.error == null) {
        console.log('[SHELLY][MQTT] Eco do pedido ignorado:', json);
        return;
      }

      if (json?.error) {
        console.error('[SHELLY][MQTT] Erro na resposta:', json.error);
        const err: any = new Error('SHELLY_RPC_ERROR');
        err.code = 'SHELLY_RPC_ERROR';
        err.details = json.error;
        return finish(err);
      }

      console.log('[SHELLY][MQTT] Resposta válida recebida:', json);
      return finish(undefined, json);
    });
  });
}

export async function shellySwitchSet(on: boolean, opts?: { topic?: string }): Promise<{ on: boolean; ack: boolean }>
{
  try {
    const resp = await shellyRpc('Switch.Set', { id: 0, on }, opts);
    const inferred = pickOnValue(resp);
    return { on: inferred ?? on, ack: true };
  } catch (e: any) {
    // fallback "fire and forget": se só falhar por timeout, devolve estado pedido.
    if (e?.code === 'SHELLY_MQTT_TIMEOUT') return { on, ack: false };
    throw e;
  }
}

export async function shellySwitchGetStatus(opts?: { topic?: string }): Promise<{ on: boolean; ack: boolean }>
{
  try {
    const resp = await shellyRpc('Switch.GetStatus', { id: 0 }, opts);
    const inferred = pickOnValue(resp);
    return { on: inferred ?? false, ack: true };
  } catch (e: any) {
    if (e?.code === 'SHELLY_MQTT_TIMEOUT') return { on: false, ack: false };
    throw e;
  }
}

export function isShellyMqttConfigured(opts?: { topic?: string }) {
  return getShellyMqttConfig(opts?.topic) != null;
}
