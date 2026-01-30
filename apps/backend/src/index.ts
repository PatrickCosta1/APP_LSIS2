import './env';

import app from './app';
import { startAiRetrainJob } from './aiTrainer';
import { startTelemetryJob } from './telemetryJob';
import { startEredesOpenDataJob } from './openDataJob';
import { startErseTariffsJob } from './erseTariffsJob';
import { startNilmJob } from './nilmJob';

const port = process.env.PORT || 4100;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API ouvindo em http://localhost:${port}`);

  // Gera novas leituras sintéticas continuamente (configurável via KYNEX_SIM_TICK_MS)
  startTelemetryJob();

  // Re-treina o modelo com base na telemetria (configurável via KYNEX_AI_*)
  startAiRetrainJob();

  // Cache de Open Data (E-REDES) para enriquecer insights/explicações (configurável via KYNEX_EREDES_TICK_MS)
  startEredesOpenDataJob();

  // Importação diária de tarifários ERSE (configurável via KYNEX_ERSE_TARIFF_ZIP_URL e KYNEX_ERSE_TICK_MS)
  startErseTariffsJob();

  // NILM + fingerprints por cliente (configurável via KYNEX_NILM_TICK_MS; desligar com KYNEX_NILM_ENABLED=0)
  if (String(process.env.KYNEX_NILM_ENABLED ?? '1') !== '0') startNilmJob();
});
