// Bootstrap file - loads env vars and initializes early services.
// This file must be imported first in app.ts.
import { initPostHog } from '@js/utils/posthog';
import { initSentry } from '@js/utils/sentry';

import { loadEnvironment } from '../config/db/connection';

loadEnvironment();

// Initialize monitoring services early (after env vars are loaded)
// Note: imports are hoisted, but these function calls execute after dotenv.config()
initSentry();
initPostHog();
