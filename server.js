require("dotenv").config();
const express   = require("express");
const axios     = require("axios");
const cors      = require("cors");
const NodeCache = require("node-cache");

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// FRED CONFIG
// Free key: https://fred.stlouisfed.org/docs/api/api_key.html
// ─────────────────────────────────────────────
const FRED_API_KEY = process.env.FRED_API_KEY;
const FRED_BASE    = "https://api.stlouisfed.org/fred/series/observations";
const HAS_KEY      = !!FRED_API_KEY;

console.log(`\n🔑 FRED API Key: ${HAS_KEY ? "✓ loaded" : "✗ missing — using built-in fallback rates"}`);

const FRED_SERIES = {
  rate_30yr:  "MORTGAGE30US",
  rate_15yr:  "MORTGAGE15US",
  treasury10: "DGS10",
  fed_funds:  "FEDFUNDS",
  prime_rate: "DPRIME",
};

// ─────────────────────────────────────────────
// FALLBACK RATES (used when no FRED key set)
// Update these manually each week if needed
// ─────────────────────────────────────────────
const FALLBACK = {
  rate_30yr:  { value: 6.76, change: -0.04, date: "2026-02-20" },
  rate_15yr:  { value: 6.03, change: -0.03, date: "2026-02-20" },
  rate_arm51: { value: 6.15, change: -0.06, date: "2026-02-20" },
  treasury10: { value: 4.28, change:  0.05, date: "2026-02-27" },
  fed_funds:  { value: 5.33, change:  0.00, date: "2026-02-01" },
  prime_rate: { value: 8.50, change:  0.00, date: "2026-02-01" },
};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function getDateNWeeksAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n * 7);
  return d.toISOString().split("T")[0];
}

async function fetchFredSeries(seriesId) {
  const cacheKey = `fred_${seriesId}`;
  const cached   = cache.get(cacheKey);
  if (cached) return cached;

  // No key → return fallback immediately
  if (!HAS_KEY) {
    const key = Object.keys(FRED_SERIES).find(k => FRED_SERIES[k] === seriesId);
    const fb  = FALLBACK[key] || { value: 6.75, change: 0, date: "2026-02-20" };
    const result = { seriesId, ...fb, history: [{ date: fb.date, value: fb.value }] };
    cache.set(cacheKey, result);
    return result;
  }

  const { data } = await axios.get(FRED_BASE, {
    params: {
      series_id:         seriesId,
      api_key:           FRED_API_KEY,
      file_type:         "json",
      sort_order:        "desc",
      observation_start: getDateNWeeksAgo(8),
      limit:             10,
    },
    timeout: 10000,
  });

  const obs = data.observations.filter(o => o.value !== ".");
  if (!obs.length) throw new Error(`No data for ${seriesId}`);

  const latest = obs[0];
  const prev   = obs[1] || latest;

  const result = {
    seriesId,
    value:  parseFloat(latest.value),
    change: parseFloat((latest.value - prev.value).toFixed(3)),
    date:   latest.date,
    history: obs.slice(0, 8).map(o => ({ date: o.date, value: parseFloat(o.value) })),
  };

  cache.set(cacheKey, result);
  return result;
}

function deriveRates(base30) {
  return {
    rate_20yr:    +(base30 - 0.25).toFixed(2),
    rate_fha30:   +(base30 - 0.25).toFixed(2),
    rate_va30:    +(base30 - 0.50).toFixed(2),
    rate_usda30:  +(base30 - 0.30).toFixed(2),
    rate_jumbo30: +(base30 + 0.25).toFixed(2),
    rate_arm71:   +(base30 - 0.40).toFixed(2),
    rate_cashout: +(base30 + 0.30).toFixed(2),
  };
}

function buildRatesResponse(r30, r15, rArm, t10, fedFunds, prime) {
  const d = deriveRates(r30.value);
  return {
    source:    HAS_KEY ? "Federal Reserve Economic Data (FRED) / Freddie Mac" : "Built-in fallback rates (set FRED_API_KEY for live data)",
    live:      HAS_KEY,
    updatedAt: new Date().toISOString(),
    asOf:      r30.date,
    mortgage: {
      rate_30yr:  { value: r30.value,    change: r30.change,   date: r30.date   },
      rate_15yr:  { value: r15.value,    change: r15.change,   date: r15.date   },
      rate_20yr:  { value: d.rate_20yr,  change: null },
      rate_arm51: { value: rArm.value,   change: rArm.change,  date: rArm.date  },
      rate_arm71: { value: d.rate_arm71, change: null },
    },
    byLoanType: {
      conventional: { rate30: r30.value,      rate15: r15.value },
      fha:          { rate30: d.rate_fha30,   apr30: +(d.rate_fha30  + 0.15).toFixed(2) },
      va:           { rate30: d.rate_va30,    apr30: +(d.rate_va30   + 0.10).toFixed(2) },
      usda:         { rate30: d.rate_usda30,  apr30: +(d.rate_usda30 + 0.12).toFixed(2) },
      jumbo:        { rate30: d.rate_jumbo30, apr30: +(d.rate_jumbo30 + 0.15).toFixed(2) },
      cashout_refi: { rate30: d.rate_cashout, apr30: +(d.rate_cashout + 0.15).toFixed(2) },
    },
    benchmarks: {
      treasury_10yr: { value: t10.value,      change: t10.change,      date: t10.date      },
      fed_funds:     { value: fedFunds.value, change: fedFunds.change, date: fedFunds.date },
      prime_rate:    { value: prime.value,    change: prime.change,    date: prime.date    },
    },
    history: {
      rate_30yr:  r30.history  || [],
      rate_15yr:  r15.history  || [],
      rate_arm51: rArm.history || [],
    },
  };
}

// ─────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    service:  "MortgageWise Rates API",
    version:  "1.0.0",
    live:     HAS_KEY,
    fred_key: HAS_KEY ? "✓ set" : "✗ missing — using fallback rates",
    endpoints: [
      "GET /api/rates",
      "GET /api/rates/summary",
      "GET /api/rates/30yr | 15yr | arm51 | treasury10 | fedfunds | prime",
      "GET /api/calculate",
      "GET /api/affordability",
      "GET /api/refinance",
      "GET /api/health",
    ],
  });
});

// ── /api/rates
app.get("/api/rates", async (req, res) => {
  try {
    const cached = cache.get("all_rates");
    if (cached) return res.json(cached);

    const [r30, r15, t10, fedFunds, prime] = await Promise.all([
      fetchFredSeries(FRED_SERIES.rate_30yr),
      fetchFredSeries(FRED_SERIES.rate_15yr),
      fetchFredSeries(FRED_SERIES.treasury10),
      fetchFredSeries(FRED_SERIES.fed_funds),
      fetchFredSeries(FRED_SERIES.prime_rate),
    ]);
    // Derive 5/1 ARM from 30yr (MORTGAGE5US discontinued Nov 2022)
    const rArm = { seriesId:'derived', value:+(r30.value-0.55).toFixed(2), change:r30.change, date:r30.date, history:[] };

    const response = buildRatesResponse(r30, r15, rArm, t10, fedFunds, prime);
    cache.set("all_rates", response, 3600);
    res.json(response);
  } catch (err) {
    console.error("GET /api/rates error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/rates/summary
app.get("/api/rates/summary", async (req, res) => {
  try {
    const cached = cache.get("summary");
    if (cached) return res.json(cached);

    const [r30, r15, t10] = await Promise.all([
      fetchFredSeries(FRED_SERIES.rate_30yr),
      fetchFredSeries(FRED_SERIES.rate_15yr),
      fetchFredSeries(FRED_SERIES.treasury10),
    ]);
    const rArm = { value:+(r30.value-0.55).toFixed(2), change:r30.change };
    const d = deriveRates(r30.value);

    const response = {
      live:      HAS_KEY,
      updatedAt: new Date().toISOString(),
      asOf:      r30.date,
      rates: [
        { label: "30-Yr Fixed",    value: r30.value,      change: r30.change,  unit: "%" },
        { label: "15-Yr Fixed",    value: r15.value,      change: r15.change,  unit: "%" },
        { label: "20-Yr Fixed",    value: d.rate_20yr,    change: null,        unit: "%" },
        { label: "5/1 ARM",        value: rArm.value,     change: rArm.change, unit: "%" },
        { label: "FHA 30-Yr",      value: d.rate_fha30,   change: null,        unit: "%" },
        { label: "VA 30-Yr",       value: d.rate_va30,    change: null,        unit: "%" },
        { label: "Jumbo 30-Yr",    value: d.rate_jumbo30, change: null,        unit: "%" },
        { label: "10-Yr Treasury", value: t10.value,      change: t10.change,  unit: "%" },
      ],
    };

    cache.set("summary", response, 3600);
    res.json(response);
  } catch (err) {
    console.error("GET /api/rates/summary error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/rates/today — Bankrate-style full daily rates table
app.get("/api/today-rates", async (req, res) => {
  try {
    const cached = cache.get("today_rates");
    if (cached) return res.json(cached);

    const [r30, r15, t10, fedFunds, prime] = await Promise.all([
      fetchFredSeries(FRED_SERIES.rate_30yr),
      fetchFredSeries(FRED_SERIES.rate_15yr),
      fetchFredSeries(FRED_SERIES.treasury10),
      fetchFredSeries(FRED_SERIES.fed_funds),
      fetchFredSeries(FRED_SERIES.prime_rate),
    ]);
    // Derive 5/1 ARM from 30yr (MORTGAGE5US discontinued Nov 2022)
    const rArm = { seriesId:'derived', value:+(r30.value-0.55).toFixed(2), change:r30.change, date:r30.date, history:[] };

    const b = r30.value;
    const pmt = (principal, rate, years) => {
      const r = rate/100/12, n = years*12;
      return r > 0 ? principal*(r*Math.pow(1+r,n))/(Math.pow(1+r,n)-1) : principal/n;
    };
    const loan = 320000; // $400k home, 20% down

    const rows = [
      { type:"30-Year Fixed",      rate: b,                         term:30, apr:+(b+0.14).toFixed(2),              points:0.7, category:"fixed", minDown:"3%",   minCredit:620 },
      { type:"20-Year Fixed",      rate:+(b-0.25).toFixed(2),       term:20, apr:+(b-0.25+0.12).toFixed(2),         points:0.6, category:"fixed", minDown:"5%",   minCredit:620 },
      { type:"15-Year Fixed",      rate: r15.value,                 term:15, apr:+(r15.value+0.11).toFixed(2),      points:0.6, category:"fixed", minDown:"3%",   minCredit:620 },
      { type:"10-Year Fixed",      rate:+(b-0.50).toFixed(2),       term:10, apr:+(b-0.50+0.10).toFixed(2),         points:0.5, category:"fixed", minDown:"5%",   minCredit:620 },
      { type:"5/1 ARM",            rate: rArm.value,                term:30, apr:+(rArm.value+0.12).toFixed(2),     points:0.5, category:"arm",   minDown:"5%",   minCredit:640 },
      { type:"7/1 ARM",            rate:+(b-0.40).toFixed(2),       term:30, apr:+(b-0.40+0.11).toFixed(2),         points:0.5, category:"arm",   minDown:"5%",   minCredit:640 },
      { type:"10/1 ARM",           rate:+(b-0.20).toFixed(2),       term:30, apr:+(b-0.20+0.10).toFixed(2),         points:0.4, category:"arm",   minDown:"5%",   minCredit:640 },
      { type:"30-Year FHA",        rate:+(b-0.25).toFixed(2),       term:30, apr:+(b-0.25+0.15).toFixed(2),         points:0.5, category:"fha",   minDown:"3.5%", minCredit:580 },
      { type:"15-Year FHA",        rate:+(r15.value-0.20).toFixed(2),term:15,apr:+(r15.value-0.20+0.14).toFixed(2),points:0.4, category:"fha",   minDown:"3.5%", minCredit:580 },
      { type:"30-Year VA",         rate:+(b-0.50).toFixed(2),       term:30, apr:+(b-0.50+0.10).toFixed(2),         points:0.3, category:"va",    minDown:"0%",   minCredit:580 },
      { type:"15-Year VA",         rate:+(r15.value-0.40).toFixed(2),term:15,apr:+(r15.value-0.40+0.09).toFixed(2),points:0.3, category:"va",    minDown:"0%",   minCredit:580 },
      { type:"30-Year USDA",       rate:+(b-0.30).toFixed(2),       term:30, apr:+(b-0.30+0.12).toFixed(2),         points:0.4, category:"usda",  minDown:"0%",   minCredit:580 },
      { type:"30-Year Jumbo",      rate:+(b+0.25).toFixed(2),       term:30, apr:+(b+0.25+0.15).toFixed(2),         points:0.8, category:"jumbo", minDown:"10%",  minCredit:700 },
      { type:"15-Year Jumbo",      rate:+(r15.value+0.15).toFixed(2),term:15,apr:+(r15.value+0.15+0.13).toFixed(2),points:0.7, category:"jumbo", minDown:"10%",  minCredit:700 },
      { type:"30-Year Fixed Refi", rate:+(b+0.10).toFixed(2),       term:30, apr:+(b+0.10+0.14).toFixed(2),         points:0.6, category:"refi",  minDown:"—",    minCredit:620 },
      { type:"15-Year Fixed Refi", rate:+(r15.value+0.10).toFixed(2),term:15,apr:+(r15.value+0.10+0.12).toFixed(2),points:0.5, category:"refi",  minDown:"—",    minCredit:620 },
      { type:"Cash-Out Refi",      rate:+(b+0.30).toFixed(2),       term:30, apr:+(b+0.30+0.16).toFixed(2),         points:0.7, category:"refi",  minDown:"—",    minCredit:640 },
    ];

    const enriched = rows.map(r => ({
      ...r,
      monthlyPayment: +pmt(loan, r.rate, r.term).toFixed(2),
      weekChange: r.type.includes("30-Year Fixed") && !r.type.includes("Refi") && !r.type.includes("FHA") && !r.type.includes("VA") && !r.type.includes("USDA") && !r.type.includes("Jumbo") ? (r30.change||0) : r.type.includes("15-Year Fixed") && !r.type.includes("Jumbo") && !r.type.includes("FHA") && !r.type.includes("VA") ? (r15.change||0) : r.type.includes("ARM") ? (rArm.change||0) : null,
    }));

    const history7 = (r30.history || []).slice(0, 8).map(h => ({ date: h.date, value: h.value })).reverse();

    const response = {
      source:    HAS_KEY ? "Federal Reserve (FRED) / Freddie Mac" : "Built-in rates",
      live:      HAS_KEY,
      updatedAt: new Date().toISOString(),
      asOf:      r30.date,
      summary: {
        rate30yr:  { value: b,              change: r30.change    },
        rate15yr:  { value: r15.value,      change: r15.change    },
        rateArm:   { value: rArm.value,     change: rArm.change   },
        treasury:  { value: t10.value,      change: t10.change    },
        fedFunds:  { value: fedFunds.value, change: fedFunds.change },
      },
      rates: enriched,
      history7,
    };

    cache.set("today_rates", response, 3600);
    res.json(response);
  } catch (err) {
    console.error("GET /api/rates/today error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/rates/:type
app.get("/api/rates/:type", async (req, res) => {
  const typeMap = {
    "30yr":       FRED_SERIES.rate_30yr,
    "15yr":       FRED_SERIES.rate_15yr,
    "treasury10": FRED_SERIES.treasury10,
    "fedfunds":   FRED_SERIES.fed_funds,
    "prime":      FRED_SERIES.prime_rate,
  };
  const seriesId = typeMap[req.params.type];
  if (!seriesId) return res.status(400).json({ error: "Unknown type", valid: Object.keys(typeMap) });
  try {
    res.json(await fetchFredSeries(seriesId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /api/calculate
app.get("/api/calculate", (req, res) => {
  const { price=400000, down=80000, rate=6.75, term=30, property_tax=0, insurance=0, hoa=0 } = req.query;
  const principal = parseFloat(price) - parseFloat(down);
  if (principal <= 0) return res.status(400).json({ error: "Down payment cannot exceed price" });

  const r = parseFloat(rate) / 100 / 12;
  const n = parseFloat(term) * 12;
  const pi    = r > 0 ? principal * (r * Math.pow(1+r,n)) / (Math.pow(1+r,n)-1) : principal/n;
  const taxMo = parseFloat(property_tax) / 12;
  const insMo = parseFloat(insurance) / 12;
  const ltv   = (principal / parseFloat(price)) * 100;
  const pmi   = ltv > 80 ? +(principal * 0.01 / 12).toFixed(2) : 0;

  let balance = principal, schedule = [];
  for (let i = 1; i <= n; i++) {
    const interest = balance * r, prn = pi - interest;
    balance -= prn;
    if (i <= 24 || i % 12 === 0)
      schedule.push({ month:i, payment:+pi.toFixed(2), principal:+prn.toFixed(2), interest:+interest.toFixed(2), balance:+Math.max(0,balance).toFixed(2) });
  }

  res.json({
    inputs:  { price:+price, down:+down, rate:+rate, term:+term },
    monthly: { principal_interest:+pi.toFixed(2), property_tax:+taxMo.toFixed(2), insurance:+insMo.toFixed(2), hoa:+parseFloat(hoa).toFixed(2), pmi, total:+(pi+taxMo+insMo+parseFloat(hoa)+pmi).toFixed(2) },
    loan:    { amount:+principal.toFixed(2), ltv:+ltv.toFixed(1), pmi_required:ltv>80, total_payments:+(pi*n).toFixed(2), total_interest:+(pi*n-principal).toFixed(2) },
    amortization: schedule,
  });
});

// ── /api/affordability
app.get("/api/affordability", (req, res) => {
  const { annual_income=100000, monthly_debts=500, down_payment=60000, rate=6.75, term=30, dti_limit=43 } = req.query;
  const mo = parseFloat(annual_income)/12;
  const r  = parseFloat(rate)/100/12, n = parseFloat(term)*12;
  const f  = r > 0 ? r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1) : 1/n;
  const avail43 = mo*(parseFloat(dti_limit)/100)-parseFloat(monthly_debts);
  const avail28 = mo*0.28;
  res.json({
    inputs:       { annual_income:+annual_income, monthly_debts:+monthly_debts, down_payment:+down_payment, rate:+rate },
    recommended:  { max_home_price:+Math.round(avail43/f+parseFloat(down_payment)), max_loan:+Math.round(avail43/f), monthly_payment:+avail43.toFixed(2), dti:+dti_limit },
    conservative: { max_home_price:+Math.round(avail28/f+parseFloat(down_payment)), max_loan:+Math.round(avail28/f), monthly_payment:+avail28.toFixed(2), dti:28 },
    monthly_income: +mo.toFixed(2),
  });
});

// ── /api/refinance
app.get("/api/refinance", (req, res) => {
  const { current_balance=320000, current_rate=7.5, new_rate=6.75, remaining_term=25, new_term=30, closing_costs=6000 } = req.query;
  const pmt = (bal, rt, yrs) => { const r=rt/100/12, n=yrs*12; return r>0?bal*(r*Math.pow(1+r,n))/(Math.pow(1+r,n)-1):bal/n; };
  const bal     = parseFloat(current_balance);
  const currPmt = pmt(bal, parseFloat(current_rate), parseFloat(remaining_term));
  const newPmt  = pmt(bal, parseFloat(new_rate), parseFloat(new_term));
  const savings = currPmt - newPmt;
  const beMo    = savings > 0 ? Math.ceil(parseFloat(closing_costs)/savings) : null;
  const intSave = (currPmt*parseFloat(remaining_term)*12-bal) - (newPmt*parseFloat(new_term)*12-bal);
  res.json({
    inputs:    { current_balance:+current_balance, current_rate:+current_rate, new_rate:+new_rate, closing_costs:+closing_costs },
    monthly:   { current_payment:+currPmt.toFixed(2), new_payment:+newPmt.toFixed(2), monthly_savings:+savings.toFixed(2) },
    breakeven: { months:beMo, years:beMo?+(beMo/12).toFixed(1):null, worth_it:beMo?beMo<parseFloat(new_term)*12:false },
    lifetime:  { interest_savings:+intSave.toFixed(2), net_savings_after_costs:+(intSave-parseFloat(closing_costs)).toFixed(2) },
  });
});

// ── /api/health
app.get("/api/health", (req, res) => {
  res.json({
    status:      "ok",
    service:     "MortgageWise Rates API",
    version:     "1.0.0",
    live:        HAS_KEY,
    fred_key:    HAS_KEY ? "✓ set" : "✗ missing — using fallback rates",
    cache_keys:  cache.keys().length,
    uptime_sec:  Math.floor(process.uptime()),
    timestamp:   new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🏠 MortgageWise API  →  http://0.0.0.0:${PORT}`);
  console.log(`📡 Mode: ${HAS_KEY ? "LIVE (FRED API)" : "FALLBACK (no FRED key)"}\n`);
});
