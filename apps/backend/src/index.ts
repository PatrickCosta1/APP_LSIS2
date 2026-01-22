import './env';

import app from './app';
import { startAiRetrainJob } from './aiTrainer';
import { startTelemetryJob } from './telemetryJob';
import { startEredesOpenDataJob } from './openDataJob';

const port = process.env.PORT || 4000;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API ouvindo em http://localhost:${port}`);

  // Gera novas leituras sintéticas continuamente (configurável via KYNEX_SIM_TICK_MS)
  startTelemetryJob();

  // Re-treina o modelo com base na telemetria (configurável via KYNEX_AI_*)
  startAiRetrainJob();

  // Cache de Open Data (E-REDES) para enriquecer insights/explicações (configurável via KYNEX_EREDES_TICK_MS)
  startEredesOpenDataJob();
});
