import app from './app';
import { startAiRetrainJob } from './aiTrainer';
import { startTelemetryJob } from './telemetryJob';

const port = process.env.PORT || 4000;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API ouvindo em http://localhost:${port}`);

  // Gera novas leituras sintéticas continuamente (configurável via KYNEX_SIM_TICK_MS)
  startTelemetryJob();

  // Re-treina o modelo com base na telemetria (configurável via KYNEX_AI_*)
  startAiRetrainJob();
});
