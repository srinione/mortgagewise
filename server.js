require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
const NodeCache = require("node-cache");

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 });

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  methods: ["GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json());

// ─────────────────────────────────────────────
// FRED CONFIG
// ─────────────────────────────────────────────
const FRED_API_KEY = process.env.FRED_API_KEY;
const FRED_BASE    = "https://api.stlouisfed.org/fred/series/observations";

if (!FRED_API_KEY) {
  console.warn("⚠  FRED_API_KEY not set — add it in Railway Variables tab");
}

const FRED_SERIES = {
  rate_30yr:  "MORTGAGE30US",
  rate_15yr:  "MORTGAGE15US",
  rate_arm51: "MORTGAGE5US",
  treasury10: "DGS10",
  fed_funds:  "FEDFUNDS",
  prime_rate: "DPRIME",
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
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  if (!FRED_API_KEY) throw new Error("FRED_API_KEY environment variable not set");

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

  const observations = data.observations.filter(o => o.value !== ".");
  if (!observations.length) throw new Error(`No data returned for series ${seriesId}`);

  const latest = observations[0];
  const prev   = observations[1] || latest;

  const result = {
    seriesId,
    value:     parseFloat(latest.value),
    prevValue: parseFloat(prev.value),
    change:    parseFloat((latest.value - prev.value).toFixed(3)),
    date:      latest.date,
    history:   observations.slice(0, 8).map(o => ({
      date:  o.date,
      value: parseFloat(o.value),
    })),
  };

  cache.set(cacheKey, result);
  return result;
}

function deriveRates(base30) {
  return {
    rate_20yr:    +(base30 - 0.25).toFixed(2),
    rate_10yr:    +(base30 - 0.50).toFixed(2),
    rate_fha30:   +(base30 - 0.25).toFixed(2),
    rate_va30:    +(base30 - 0.50).toFixed(2),
    rate_usda30:  +(base30 - 0.30).toFixed(2),
    rate_jumbo30: +(base30 + 0.25).toFixed(2),
    rate_arm71:   +(base30 - 0.40).toFixed(2),
    rate_arm101:  +(base30 - 0.20).toFixed(2),
    rate_cashout: +(base30 + 0.30).toFixed(2),
  };
}

// ─────────────────────────────────────────────
// REQUEST LOGGER
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
    service: "MortgageWise Rates API",
    version: "1.0.0",
    endpoints: [
      "GET /api/rates",
      "GET /api/rates/summary",
      "GET /api/rates/:type  (30yr | 15yr | arm51 | treasury10 | fedfunds | prime)",
      "GET /api/calculate",
      "GET /api/affordability",
      "GET /api/refinance",
      "GET /api/health",
    ],
  });
});

// ── /api/rates — Full rate payload
app.get("/api/rates", async (req, res) => {
  try {
    const cached = cache.get("all_rates");
    if (cached) return res.json(cached);

    const [r30, r15, rArm, t10, fedFunds, prime] = await Promise.all([
      fetchFredSeries(FRED_SERIES.rate_30yr),
      fetchFredSeries(FRED_SERIES.rate_15yr),
      fetchFredSeries(FRED_SERIES.rate_arm51),
      fetchFredSeries(FRED_SERIES.treasury10),
      fetchFredSeries(FRED_SERIES.fed_funds),
      fetchFredSeries(FRED_SERIES.prime_rate),
    ]);

    const d = deriveRates(r30.value);

    const response = {
      source:    "Federal Reserve Economic Data (FRED) / Freddie Mac",
      updatedAt: new Date().toISOString(),
      asOf:      r30.date,
      note:      "Mortgage rates update weekly (Thursdays). Treasury & Fed rates update daily.",
      mortgage: {
        rate_30yr:   { value: r30.value,    change: r30.change,   date: r30.date   },
        rate_15yr:   { value: r15.value,    change: r15.change,   date: r15.date   },
        rate_20yr:   { value: d.rate_20yr,  change: null, note: "derived" },
        rate_arm51:  { value: rArm.value,   change: rArm.change,  date: rArm.date  },
        rate_arm71:  { value: d.rate_arm71, change: null, note: "derived" },
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
        rate_30yr:  r30.history,
        rate_15yr:  r15.history,
        rate_arm51: rArm.history,
      },
    };

    cache.set("all_rates", response, 3600);
    res.json(response);
  } catch (err) {
    console.error("GET /api/rates:", err.message);
    res.status(500).json({ error: "Failed to fetch rates", detail: err.message });
  }
});

// ── /api/rates/summary — Lightweight ticker
app.get("/api/rates/summary", async (req, res) => {
  try {
    const cached = cache.get("summary");
    if (cached) return res.json(cached);

    const [r30, r15, rArm, t10] = await Promise.all([
      fetchFredSeries(FRED_SERIES.rate_30yr),
      fetchFredSeries(FRED_SERIES.rate_15yr),
      fetchFredSeries(FRED_SERIES.rate_arm51),
      fetchFredSeries(FRED_SERIES.treasury10),
    ]);
    const d = deriveRates(r30.value);

    const response = {
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
    console.error("GET /api/rates/summary:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/rates/:type — Single series
app.get("/api/rates/:type", async (req, res) => {
  const typeMap = {
    "30yr":       FRED_SERIES.rate_30yr,
    "15yr":       FRED_SERIES.rate_15yr,
    "arm51":      FRED_SERIES.rate_arm51,
    "treasury10": FRED_SERIES.treasury10,
    "fedfunds":   FRED_SERIES.fed_funds,
    "prime":      FRED_SERIES.prime_rate,
  };
  const seriesId = typeMap[req.params.type];
  if (!seriesId) {
    return res.status(400).json({ error: "Unknown type", valid: Object.keys(typeMap) });
  }
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
  const pi    = r > 0 ? principal * (r * Math.pow(1+r,n)) / (Math.pow(1+r,n) - 1) : principal / n;
  const taxMo = parseFloat(property_tax) / 12;
  const insMo = parseFloat(insurance) / 12;
  const hoaMo = parseFloat(hoa);
  const ltv   = (principal / parseFloat(price)) * 100;
  const pmi   = ltv > 80 ? +(principal * 0.01 / 12).toFixed(2) : 0;

  let balance = principal;
  const schedule = [];
  for (let i = 1; i <= n; i++) {
    const interest      = balance * r;
    const principalPaid = pi - interest;
    balance -= principalPaid;
    if (i <= 24 || i % 12 === 0) {
      schedule.push({ month: i, payment: +pi.toFixed(2), principal: +principalPaid.toFixed(2), interest: +interest.toFixed(2), balance: +Math.max(0,balance).toFixed(2) });
    }
  }

  res.json({
    inputs:  { price:+price, down:+down, rate:+rate, term:+term },
    monthly: { principal_interest:+pi.toFixed(2), property_tax:+taxMo.toFixed(2), insurance:+insMo.toFixed(2), hoa:+hoaMo.toFixed(2), pmi, total:+(pi+taxMo+insMo+hoaMo+pmi).toFixed(2) },
    loan:    { amount:+principal.toFixed(2), ltv:+ltv.toFixed(1), pmi_required:ltv>80, total_payments:+(pi*n).toFixed(2), total_interest:+(pi*n-principal).toFixed(2) },
    amortization: schedule,
  });
});

// ── /api/affordability
app.get("/api/affordability", (req, res) => {
  const { annual_income=100000, monthly_debts=500, down_payment=60000, rate=6.75, term=30, dti_limit=43 } = req.query;

  const monthlyIncome    = parseFloat(annual_income) / 12;
  const availableHousing = monthlyIncome * (parseFloat(dti_limit)/100) - parseFloat(monthly_debts);
  const r = parseFloat(rate)/100/12, n = parseFloat(term)*12;
  const factor = r > 0 ? r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1) : 1/n;
  const maxLoan  = availableHousing / factor;
  const maxPrice = maxLoan + parseFloat(down_payment);
  const consvH   = monthlyIncome * 0.28;
  const consvL   = consvH / factor;

  res.json({
    inputs:       { annual_income:+annual_income, monthly_debts:+monthly_debts, down_payment:+down_payment, rate:+rate, dti_limit:+dti_limit },
    recommended:  { max_home_price:+Math.round(maxPrice), max_loan:+Math.round(maxLoan), monthly_payment:+availableHousing.toFixed(2), dti:+dti_limit },
    conservative: { max_home_price:+Math.round(consvL+parseFloat(down_payment)), max_loan:+Math.round(consvL), monthly_payment:+consvH.toFixed(2), dti:28 },
    monthly_income: +monthlyIncome.toFixed(2),
  });
});

// ── /api/refinance
app.get("/api/refinance", (req, res) => {
  const { current_balance=320000, current_rate=7.5, new_rate=6.75, remaining_term=25, new_term=30, closing_costs=6000 } = req.query;

  const pmt = (bal, rate, yrs) => {
    const r=rate/100/12, n=yrs*12;
    return r>0 ? bal*(r*Math.pow(1+r,n))/(Math.pow(1+r,n)-1) : bal/n;
  };
  const bal       = parseFloat(current_balance);
  const currPI    = pmt(bal, parseFloat(current_rate), parseFloat(remaining_term));
  const newPI     = pmt(bal, parseFloat(new_rate), parseFloat(new_term));
  const savings   = currPI - newPI;
  const beMo      = savings>0 ? Math.ceil(parseFloat(closing_costs)/savings) : null;
  const intCurr   = currPI*parseFloat(remaining_term)*12 - bal;
  const intNew    = newPI*parseFloat(new_term)*12 - bal;

  res.json({
    inputs:    { current_balance:+current_balance, current_rate:+current_rate, new_rate:+new_rate, closing_costs:+closing_costs },
    monthly:   { current_payment:+currPI.toFixed(2), new_payment:+newPI.toFixed(2), monthly_savings:+savings.toFixed(2) },
    breakeven: { months:beMo, years:beMo?+(beMo/12).toFixed(1):null, worth_it:beMo?beMo<parseFloat(new_term)*12:false },
    lifetime:  { interest_savings:+(intCurr-intNew).toFixed(2), net_savings_after_costs:+(intCurr-intNew-parseFloat(closing_costs)).toFixed(2) },
  });
});

// ── /api/health
app.get("/api/health", (req, res) => {
  res.json({
    status:      "ok",
    service:     "MortgageWise Rates API",
    version:     "1.0.0",
    environment: process.env.NODE_ENV || "development",
    fred_key:    FRED_API_KEY ? "✓ set" : "✗ missing",
    cache_keys:  cache.keys().length,
    uptime_sec:  Math.floor(process.uptime()),
    timestamp:   new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// START — Railway injects PORT automatically
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🏠 MortgageWise API  →  http://0.0.0.0:${PORT}`);
  console.log(`📡 FRED key: ${FRED_API_KEY ? "✓ loaded" : "✗ missing — add FRED_API_KEY in Railway Variables"}`);
  console.log(`\n  /api/rates  /api/rates/summary  /api/calculate  /api/health\n`);
});
