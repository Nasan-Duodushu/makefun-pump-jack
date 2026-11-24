// Paper-sprint entry: a momentum-with-discipline strategy for the pump.fun
// paper replay (agent-fun/replay/v2). The grader runs `node /bot/main.ts`;
// the wire protocol lives in the kit's vendored shim, the decisions in
// strategy.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
