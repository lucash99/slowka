/*
 * Harmonogram powtórek FSRS-6, czyli algorytm dostępny w Anki.
 *
 * Wzory: https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm
 * Kroki nauki (learning steps) i dzień kończący się o 4:00: https://docs.ankiweb.net/deck-options.html
 *
 * Moduł jest czysty: dostaje kartę i czas, zwraca nowe stany karty. Nic nie zapisuje.
 */
(function (root) {
  'use strict';

  const W = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
    1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
  ];

  const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;
  const State = { NEW: 0, LEARNING: 1, REVIEW: 2, RELEARNING: 3 };

  const S_MIN = 0.001;
  const D_MIN = 1;
  const D_MAX = 10;
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  const DEFAULTS = {
    retention: 0.9,
    learningSteps: [1, 10],   // minuty
    relearningSteps: [10],    // minuty
    maxInterval: 36500,       // dni
    rolloverHour: 4,          // "dzień" w Anki zaczyna się o 4:00 rano
  };

  const DECAY = -W[20];
  const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const clampD = (d) => clamp(d, D_MIN, D_MAX);
  const clampS = (s) => Math.max(S_MIN, s);

  function retrievability(elapsedDays, s) {
    return Math.pow(1 + FACTOR * Math.max(0, elapsedDays) / s, DECAY);
  }

  /** Liczba dni (bez zaokrąglania), po której pamięć spadnie do `retention`. */
  function rawInterval(s, retention) {
    return (s / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  }

  const initStability = (g) => clampS(W[g - 1]);
  const initDifficulty = (g) => W[4] - Math.exp(W[5] * (g - 1)) + 1;

  function nextDifficulty(d, g) {
    const delta = -W[6] * (g - 3);
    const damped = d + (delta * (10 - d)) / 9;
    return clampD(W[7] * initDifficulty(EASY) + (1 - W[7]) * damped);
  }

  function shortTermStability(s, g) {
    let inc = Math.exp(W[17] * (g - 3 + W[18])) * Math.pow(s, -W[19]);
    if (g >= HARD) inc = Math.max(inc, 1);
    return clampS(s * inc);
  }

  function recallStability(d, s, r, g) {
    const hardPenalty = g === HARD ? W[15] : 1;
    const easyBonus = g === EASY ? W[16] : 1;
    return clampS(
      s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) *
        (Math.exp(W[10] * (1 - r)) - 1) * hardPenalty * easyBonus)
    );
  }

  function forgetStability(d, s, r) {
    const longTerm = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
    // Po zapomnieniu stabilność nie może wzrosnąć.
    return clampS(Math.min(longTerm, s / Math.exp(W[17] * W[18])));
  }

  /** Numer dnia w strefie lokalnej, z uwzględnieniem przesunięcia o `rollover` godzin. */
  function dayNumber(ts, rollover) {
    const d = new Date(ts - rollover * HOUR);
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
  }

  function dayStart(n, rollover) {
    const u = new Date(n * DAY);
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), rollover).getTime();
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /**
   * Lekko rozrzuca dłuższe odstępy, żeby karty dodane razem nie wracały razem.
   * Losowość zależy od karty i numeru powtórki, więc czas pokazany na przycisku
   * jest dokładnie tym, który zostanie zapisany.
   */
  function fuzz(days, card, max) {
    if (days < 2.5) return Math.min(Math.round(days), max);
    const ranges = [[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]];
    let delta = 1;
    for (const [start, end, factor] of ranges) {
      delta += factor * Math.max(Math.min(days, end) - start, 0);
    }
    const hi = Math.min(Math.round(days + delta), max);
    const lo = Math.min(Math.max(2, Math.round(days - delta)), hi);
    const f = (hash(card.id + ':' + card.reps) % 10000) / 10000;
    return Math.min(lo + Math.floor(f * (hi - lo + 1)), hi);
  }

  function memoryAfter(card, g, elapsed) {
    if (card.state === State.NEW) return { s: initStability(g), d: clampD(initDifficulty(g)) };
    const d = nextDifficulty(card.d, g);
    if (elapsed < 1) return { s: shortTermStability(card.s, g), d };
    const r = retrievability(elapsed, card.s);
    return { s: g === AGAIN ? forgetStability(card.d, card.s, r) : recallStability(card.d, card.s, r, g), d };
  }

  function hardDelay(steps, step) {
    if (step > 0) return steps[step];
    if (steps.length > 1) return Math.round((steps[0] + steps[1]) / 2);
    return Math.round(Math.min(steps[0] * 1.5, steps[0] + 1440));
  }

  /**
   * Dla każdej z czterech ocen zwraca { card, minutes, days }.
   * `minutes` jest ustawione, gdy karta wraca jeszcze tego samego dnia (kroki nauki),
   * `days` gdy przechodzi do zwykłych powtórek.
   */
  function schedule(card, now, options) {
    const cfg = Object.assign({}, DEFAULTS, options);
    const today = dayNumber(now, cfg.rolloverHour);
    const elapsed = card.last ? today - dayNumber(card.last, cfg.rolloverHour) : 0;

    const memory = {};
    const ivl = {};
    for (const g of [AGAIN, HARD, GOOD, EASY]) {
      memory[g] = memoryAfter(card, g, elapsed);
      ivl[g] = clamp(rawInterval(memory[g].s, cfg.retention), 1, cfg.maxInterval);
    }

    const days = { [HARD]: Math.round(ivl[HARD]), [GOOD]: Math.round(ivl[GOOD]), [EASY]: Math.round(ivl[EASY]) };

    // Twarde nie dłużej niż Dobrze, Dobrze krócej niż Łatwe. Rozrzut mógłby to zaburzyć,
    // więc kolejność jest pilnowana przed nim i po nim.
    const keepOrder = () => {
      days[HARD] = Math.min(days[HARD], days[GOOD]);
      days[GOOD] = Math.min(Math.max(days[GOOD], days[HARD] + 1), cfg.maxInterval);
      days[EASY] = Math.min(Math.max(days[EASY], days[GOOD] + 1), cfg.maxInterval);
    };
    keepOrder();
    for (const g of [HARD, GOOD, EASY]) days[g] = fuzz(days[g], card, cfg.maxInterval);
    keepOrder();

    const base = { reps: card.reps + 1, last: now };

    const toSteps = (g, state, step, minutes, lapses) => ({
      card: Object.assign({}, card, memory[g], base, { state, step, lapses, due: now + minutes * MINUTE }),
      minutes,
      days: null,
    });

    const toReview = (g, d, lapses) => ({
      card: Object.assign({}, card, memory[g], base, {
        state: State.REVIEW,
        step: 0,
        lapses,
        due: dayStart(today + d, cfg.rolloverHour),
      }),
      minutes: null,
      days: d,
    });

    const out = {};

    if (card.state === State.REVIEW) {
      const lapses = card.lapses + 1;
      out[AGAIN] = cfg.relearningSteps.length
        ? toSteps(AGAIN, State.RELEARNING, 0, cfg.relearningSteps[0], lapses)
        : toReview(AGAIN, 1, lapses);
      for (const g of [HARD, GOOD, EASY]) out[g] = toReview(g, days[g], card.lapses);
      return out;
    }

    const relearning = card.state === State.RELEARNING;
    const steps = relearning ? cfg.relearningSteps : cfg.learningSteps;
    const stepState = relearning ? State.RELEARNING : State.LEARNING;
    const step = card.state === State.NEW ? 0 : Math.min(card.step, Math.max(steps.length - 1, 0));

    if (!steps.length) {
      out[AGAIN] = toReview(AGAIN, 1, card.lapses);
      out[HARD] = toReview(HARD, days[HARD], card.lapses);
      out[GOOD] = toReview(GOOD, days[GOOD], card.lapses);
      out[EASY] = toReview(EASY, days[EASY], card.lapses);
      return out;
    }

    out[AGAIN] = toSteps(AGAIN, stepState, 0, steps[0], card.lapses);
    out[HARD] = toSteps(HARD, stepState, step, hardDelay(steps, step), card.lapses);
    out[GOOD] = step + 1 < steps.length
      ? toSteps(GOOD, stepState, step + 1, steps[step + 1], card.lapses)
      : toReview(GOOD, days[GOOD], card.lapses);
    out[EASY] = toReview(EASY, days[EASY], card.lapses);
    return out;
  }

  root.FSRS = {
    AGAIN, HARD, GOOD, EASY, State, DEFAULTS, W, DECAY, FACTOR,
    retrievability, rawInterval, initStability, initDifficulty, nextDifficulty,
    shortTermStability, recallStability, forgetStability,
    dayNumber, dayStart, hash, schedule,
  };
})(window);
