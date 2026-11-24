// Selective dip-buyer for the pump.fun replay sprint (second entry, wider dip band).
//
// What the dev window teaches (and live pump.fun confirms): most coins bleed
// to zero, momentum-chasing buys tops, and the curve fee plus tx fees punish
// churn — the house momentum and reversion pilots both finish deep under
// water on the calibration window while holding cash finishes at zero. So
// this bot's first job is not losing: it trades rarely, only buying coins
// that have already been punished — down a third to three-fifths from a
// recent high on a curve with real depth — and only once the tape says the
// dip is being bought (most of the last handful of trades are buys, the very
// last one included, net flow non-negative) and the price has stopped
// falling. Positions are small, exits are mechanical, a per-coin cooldown
// stops re-entering a falling knife, and if the account's equity ever falls
// 28% from its peak the bot stops opening new risk entirely. Deterministic:
// slots and reserves only, no clock, no randomness.

import { LAMPORTS_PER_SOL, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = Number(LAMPORTS_PER_SOL);

function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

interface Track {
  /** [slot, price] samples from trade events, oldest first. */
  samples: [number, number][];
  /** Last trades as [isBuy, sol] pairs, oldest first. */
  tape: [boolean, number][];
  firstSeen: number;
  coolUntil: number;
}

interface Held {
  entryPrice: number;
  entrySlot: number;
  high: number;
}

export interface Params {
  minAgeSlots: number;
  minRealSol: number;
  maxRealSol: number;
  minTrades: number;
  highWindow: number;
  ddMin: number;
  ddMax: number;
  stabWindow: number;
  stabLo: number;
  stabHi: number;
  tapeN: number;
  tapeMinBuys: number;
  sizeFrac: number;
  minQuoteLamports: bigint;
  takeProfit: number;
  stopLoss: number;
  trailArm: number;
  trailDrop: number;
  maxHold: number;
  cooldown: number;
  equityHalt: number;
  slippageBps: number;
}

export const PARAMS: Params = {
  minAgeSlots: 120,
  minRealSol: 2.5,
  maxRealSol: 84,
  minTrades: 30,
  highWindow: 900,
  ddMin: 0.42,
  ddMax: 0.62,
  stabWindow: 50,
  stabLo: -0.04,
  stabHi: 0.08,
  tapeN: 14,
  tapeMinBuys: 11,
  sizeFrac: 0.06,
  minQuoteLamports: 30_000_000n,
  takeProfit: 0.34,
  stopLoss: -0.18,
  trailArm: 0.22,
  trailDrop: 0.14,
  maxHold: 2200,
  cooldown: 1200,
  equityHalt: 0.72,
  slippageBps: 900,
};

export function createStrategy(p: Params = PARAMS) {
  const tracks = new Map<Pubkey, Track>();
  const held = new Map<Pubkey, Held>();
  const pendingBuy = new Map<string, Pubkey>();
  let counter = 0;
  let peakEquity = 0;

  const trackOf = (mint: Pubkey, slot: number): Track => {
    let t = tracks.get(mint);
    if (t === undefined) {
      t = { samples: [], tape: [], firstSeen: slot, coolUntil: -1 };
      tracks.set(mint, t);
    }
    return t;
  };

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy' && pendingBuy.has(f.client_id)) {
        const mint = pendingBuy.get(f.client_id)!;
        pendingBuy.delete(f.client_id);
        const tokens = Number(f.token_amount);
        if (tokens > 0) held.set(mint, { entryPrice: Number(f.quote_lamports) / tokens, entrySlot: slot, high: 0 });
      }
      if (f.side === 'sell') {
        held.delete(f.mint);
        const t = tracks.get(f.mint);
        if (t !== undefined) t.coolUntil = slot + p.cooldown;
      }
    }
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const t = trackOf(e.mint, slot);
      t.tape.push([e.is_buy, Number(e.sol_amount) / SOL]);
      if (t.tape.length > 24) t.tape.splice(0, t.tape.length - 24);
      const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      if (price > 0) {
        t.samples.push([slot, price]);
        if (t.samples.length > 400) t.samples.splice(0, t.samples.length - 400);
      }
    }

    // Equity estimate for the drawdown halt: cash plus positions at the
    // latest curve prices.
    let equity = Number(state.cash);
    for (const [mint, pos] of state.positions) {
      const c = state.curves.get(mint);
      if (c !== undefined) equity += Number(pos.token_amount) * priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
    }
    if (equity > peakEquity) peakEquity = equity;
    const halted = peakEquity > 0 && equity < peakEquity * p.equityHalt;

    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // Exits first.
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      const h = held.get(mint);
      if (curve === undefined || h === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      if (price > h.high) h.high = price;
      const pnl = price / h.entryPrice - 1;
      const aged = slot - h.entrySlot > p.maxHold;
      const trail = pnl > p.trailArm && price < h.high * (1 - p.trailDrop);
      if (pnl <= p.stopLoss || pnl >= p.takeProfit || trail || aged) {
        const inFlight = [...state.pending.values()].some((o) => o.order.side === 'sell' && o.order.mint === mint);
        if (!inFlight) orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.slippageBps });
        if (orders.length >= maxOrders) return orders;
      }
    }

    // Entries: punished, stabilising, and being bought.
    if (!halted && state.committedPositionCount() < state.hello.caps.max_open_positions) {
      const scored: { mint: Pubkey; score: number }[] = [];
      for (const [mint, curve] of state.curves) {
        if (curve.complete || state.positions.has(mint)) continue;
        if ([...state.pending.values()].some((o) => o.order.side === 'buy' && o.order.mint === mint)) continue;
        const t = tracks.get(mint);
        if (t === undefined || slot < t.coolUntil) continue;
        const born = curve.created_slot ?? t.firstSeen;
        if (slot - born < p.minAgeSlots) continue;
        const realSol = Number(curve.real_quote_reserves) / SOL;
        if (realSol < p.minRealSol || realSol > p.maxRealSol) continue;
        if (curve.trades < p.minTrades) continue;
        if (t.samples.length < 12 || t.tape.length < p.tapeN) continue;
        const now = t.samples[t.samples.length - 1]![1];
        let high = 0;
        let past: number | null = null;
        for (let i = t.samples.length - 1; i >= 0; i--) {
          const [ss, px] = t.samples[i]!;
          if (slot - ss > p.highWindow) break;
          if (px > high) high = px;
          if (past === null && slot - ss >= p.stabWindow) past = px;
        }
        if (high <= 0 || past === null) continue;
        const dd = 1 - now / high;
        if (dd < p.ddMin || dd > p.ddMax) continue;
        const stab = now / past - 1;
        if (stab < p.stabLo || stab > p.stabHi) continue;
        const recent = t.tape.slice(-p.tapeN);
        if (!recent[recent.length - 1]![0]) continue;
        let buys = 0;
        let net = 0;
        for (const [isBuy, sol] of recent) {
          if (isBuy) {
            buys += 1;
            net += sol;
          } else net -= sol;
        }
        if (buys < p.tapeMinBuys || net < 0) continue;
        scored.push({ mint, score: dd * Math.log(1 + realSol) });
      }
      scored.sort((a, b) => b.score - a.score);
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const c of scored) {
        if (slotsLeft <= 0 || orders.length >= maxOrders) break;
        const cap = state.maxBuyLamports(c.mint);
        const want = BigInt(Math.floor(Number(state.freeCashLamports()) * p.sizeFrac));
        const quote = want < cap ? want : cap;
        if (quote < p.minQuoteLamports) continue;
        counter += 1;
        const id = `b${counter}`;
        pendingBuy.set(id, c.mint);
        orders.push({ side: 'buy', client_id: id, mint: c.mint, quote_lamports: quote, max_slippage_bps: p.slippageBps });
        slotsLeft -= 1;
      }
    }
    return orders;
  }

  return { onBatch };
}
