require("dotenv").config();
const express    = require("express");
const axios      = require("axios");
const cors       = require("cors");
const NodeCache  = require("node-cache");
const nodemailer = require("nodemailer");
const fs         = require("fs");
const path       = require("path");

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// EMAIL / ALERTS CONFIG
// Set SMTP_USER and SMTP_PASS in Railway Variables
// Uses Gmail by default — or any SMTP provider
// ─────────────────────────────────────────────
const SMTP_USER  = process.env.SMTP_USER  || "";
const SMTP_PASS  = process.env.SMTP_PASS  || "";
const ALERTS_FILE = path.join(__dirname, "alerts.json");
const HAS_SMTP   = !!(SMTP_USER && SMTP_PASS);

const mailer = HAS_SMTP ? nodemailer.createTransport({
  service: "gmail",
  auth: { user: SMTP_USER, pass: SMTP_PASS },
}) : null;

// Load/save alerts to JSON file (persists across restarts)
function loadAlerts() {
  try { return JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8")); }
  catch { return []; }
}
function saveAlerts(alerts) {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
}
console.log(`📧 SMTP: ${HAS_SMTP ? "✓ configured" : "✗ not set (alerts will be stored but not emailed)"}`);

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
    service:  "RateCroft Rates API",
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
    service:     "RateCroft Rates API",
    version:     "1.0.0",
    live:        HAS_KEY,
    fred_key:    HAS_KEY ? "✓ set" : "✗ missing — using fallback rates",
    cache_keys:  cache.keys().length,
    uptime_sec:  Math.floor(process.uptime()),
    timestamp:   new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// FEATURE 1: LENDER RATE QUOTES BY STATE
// GET /api/lender-quotes?state=CA&loanType=30yr&creditScore=780&price=500000&down=100000
// Returns 8 realistic lender quotes with slight rate variations per state
// ─────────────────────────────────────────────

// National lenders database — affiliate links ready (replace # with your affiliate URL)
const LENDERS = [
  { id:"rocket",     name:"Rocket Mortgage",  logo:"🚀", type:"online",  nmls:"3030",   minCredit:580, affilUrl:"https://www.rocketmortgage.com/?qls=rc_ratecroft" },
  { id:"uwm",        name:"United Wholesale",  logo:"🏛️", type:"broker",  nmls:"3038",   minCredit:620, affilUrl:"https://www.uwm.com/" },
  { id:"loanDepot",  name:"loanDepot",         logo:"💚", type:"online",  nmls:"174457", minCredit:620, affilUrl:"https://www.loandepot.com/" },
  { id:"newrez",     name:"NewRez",            logo:"🔵", type:"online",  nmls:"3013",   minCredit:620, affilUrl:"https://www.newrez.com/" },
  { id:"penfed",     name:"PenFed CU",         logo:"🦅", type:"credit",  nmls:"401822", minCredit:650, affilUrl:"https://www.penfed.org/mortgage" },
  { id:"bof a",      name:"Bank of America",   logo:"🏦", type:"bank",    nmls:"399802", minCredit:620, affilUrl:"https://www.bankofamerica.com/mortgage/" },
  { id:"chase",      name:"Chase",             logo:"🏦", type:"bank",    nmls:"399798", minCredit:620, affilUrl:"https://www.chase.com/personal/mortgage" },
  { id:"wells",      name:"Wells Fargo",       logo:"🏦", type:"bank",    nmls:"399801", minCredit:620, affilUrl:"https://www.wellsfargo.com/mortgage/" },
  { id:"better",     name:"Better.com",        logo:"⚡", type:"online",  nmls:"330511", minCredit:620, affilUrl:"https://better.com/" },
  { id:"guaranteed", name:"Guaranteed Rate",   logo:"✅", type:"online",  nmls:"2611",   minCredit:580, affilUrl:"https://www.rate.com/" },
  { id:"ally",       name:"Ally Bank",         logo:"🟣", type:"online",  nmls:"196733", minCredit:620, affilUrl:"https://www.ally.com/home-loans/" },
  { id:"flagstar",   name:"Flagstar Bank",     logo:"🔴", type:"bank",    nmls:"417490", minCredit:580, affilUrl:"https://www.flagstar.com/loans/mortgage.html" },
];

// State-level rate adjustments (some states have higher costs/taxes → slightly higher rates)
const STATE_RATE_ADJ = {
  CA:-0.03, NY:-0.04, MA:-0.03, WA:-0.02, CO:-0.02, OR:-0.02,
  TX: 0.02, FL: 0.01, GA: 0.01, AZ: 0.00, NC: 0.00, VA:-0.01,
  OH: 0.02, MI: 0.02, PA: 0.01, IL: 0.01, NJ:-0.01, MD:-0.01,
  // Default for unlisted states: +0.01
};

// Credit score → rate adjustment
function creditAdj(score) {
  if (score >= 780) return 0;
  if (score >= 760) return 0.05;
  if (score >= 740) return 0.10;
  if (score >= 720) return 0.18;
  if (score >= 700) return 0.25;
  if (score >= 680) return 0.35;
  if (score >= 660) return 0.45;
  if (score >= 640) return 0.60;
  if (score >= 620) return 0.75;
  return 1.00;
}

// LTV → rate adjustment
function ltvAdj(price, down) {
  const ltv = ((price - down) / price) * 100;
  if (ltv <= 60)  return -0.15;
  if (ltv <= 70)  return -0.10;
  if (ltv <= 75)  return -0.05;
  if (ltv <= 80)  return  0.00;
  if (ltv <= 85)  return  0.10;
  if (ltv <= 90)  return  0.20;
  if (ltv <= 95)  return  0.30;
  return 0.40;
}

app.get("/api/lender-quotes", async (req, res) => {
  try {
    let { state="CA", loanType="30yr", creditScore=760, price=500000, down=100000, purpose="purchase" } = req.query;
    state       = String(state).toUpperCase().slice(0,2);
    creditScore = parseInt(creditScore);
    price       = parseFloat(price);
    down        = parseFloat(down);
    const loan  = price - down;

    // Get base rate from FRED (or fallback)
    const r30 = await fetchFredSeries(FRED_SERIES.rate_30yr);
    const r15 = await fetchFredSeries(FRED_SERIES.rate_15yr);

    // Determine base rate for requested loan type
    const loanBaseRates = {
      "30yr":    r30.value,
      "15yr":    r15.value,
      "arm51":   +(r30.value - 0.55).toFixed(2),
      "fha30":   +(r30.value - 0.25).toFixed(2),
      "va30":    +(r30.value - 0.50).toFixed(2),
      "jumbo30": +(r30.value + 0.25).toFixed(2),
    };
    const baseRate = loanBaseRates[loanType] || r30.value;
    const stateAdj = STATE_RATE_ADJ[state] ?? 0.01;
    const crAdj    = creditAdj(creditScore);
    const ltvA     = ltvAdj(price, down);

    // Refi adds ~0.10%
    const purposeAdj = purpose === "refinance" ? 0.10 : purpose === "cashout" ? 0.30 : 0;

    // Generate quotes — each lender has a small random spread simulating real competition
    const loanTermMap = { "30yr":30,"15yr":15,"arm51":30,"fha30":30,"va30":30,"jumbo30":30 };
    const term = loanTermMap[loanType] || 30;

    const pmt = (p, r, y) => {
      const mr = r/100/12, n = y*12;
      return mr > 0 ? +(p*(mr*Math.pow(1+mr,n))/(Math.pow(1+mr,n)-1)).toFixed(2) : +(p/n).toFixed(2);
    };

    // Filter lenders by min credit, then pick 8 and generate quotes
    const eligible = LENDERS.filter(l => creditScore >= l.minCredit);
    // Shuffle deterministically based on state so results look consistent
    const seed     = state.charCodeAt(0) + state.charCodeAt(1);
    const sorted   = [...eligible].sort((a,b) => (a.id.charCodeAt(0)+seed)%7 - (b.id.charCodeAt(0)+seed)%7);
    const selected = sorted.slice(0, 8);

    const quotes = selected.map((lender, i) => {
      // Each lender gets a slight competitive variation: -0.15 to +0.20
      const lenderVar = parseFloat(((i * 0.04 - 0.08) + (Math.sin(seed + i) * 0.05)).toFixed(3));
      const rate      = parseFloat((baseRate + stateAdj + crAdj + ltvA + purposeAdj + lenderVar).toFixed(3));
      const points    = parseFloat((0.5 + i * 0.08 - lenderVar * 2).toFixed(2));
      const fees      = Math.round(2800 + i * 200 - lenderVar * 500);
      const apr       = parseFloat((rate + 0.08 + points * 0.06 + fees/loan*0.04).toFixed(3));
      const monthly   = pmt(loan, rate, term);

      return {
        lender:      lender.name,
        lenderLogo:  lender.logo,
        lenderType:  lender.type,
        nmls:        lender.nmls,
        affilUrl:    lender.affilUrl,
        rate:        rate,
        apr:         apr,
        points:      Math.max(0, points),
        fees:        Math.max(1500, fees),
        monthlyPmt:  monthly,
        loanAmount:  loan,
        term:        term,
        loanType:    loanType,
        badge:       i === 0 ? "Lowest Rate" : i === 1 ? "Best Value" : i === 2 ? "Lowest Fees" : null,
      };
    });

    // Sort by rate (lowest first)
    quotes.sort((a,b) => a.rate - b.rate);
    quotes[0].badge = "Lowest Rate";
    // Best value = lowest APR
    const bestVal = [...quotes].sort((a,b) => a.apr - b.apr)[1];
    if (bestVal) bestVal.badge = "Best Value";
    // Lowest fees
    const lowFee = [...quotes].sort((a,b) => a.fees - b.fees)[2];
    if (lowFee && !lowFee.badge) lowFee.badge = "Lowest Fees";

    res.json({
      state, loanType, creditScore, price, down, loan,
      purpose, term,
      baseRate, adjustments: { state:stateAdj, credit:crAdj, ltv:ltvA, purpose:purposeAdj },
      updatedAt: new Date().toISOString(),
      quotes,
    });
  } catch(err) {
    console.error("lender-quotes error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// FEATURE 2: RATE HISTORY — 1yr / 3yr / 5yr
// GET /api/rate-history?period=1yr&series=30yr
// Fetches real FRED historical data for trend charts
// ─────────────────────────────────────────────
app.get("/api/rate-history", async (req, res) => {
  try {
    let { period="1yr", series="30yr" } = req.query;

    const seriesMap = {
      "30yr": FRED_SERIES.rate_30yr,
      "15yr": FRED_SERIES.rate_15yr,
      "arm":  FRED_SERIES.rate_30yr,  // derive ARM from 30yr
    };
    const fredId = seriesMap[series] || FRED_SERIES.rate_30yr;

    const periodDays = { "1yr":365, "3yr":1095, "5yr":1825, "10yr":3650 };
    const days       = periodDays[period] || 365;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr  = startDate.toISOString().split("T")[0];

    // Limit for each period (avoid huge payloads)
    const limitMap  = { "1yr":55, "3yr":160, "5yr":265, "10yr":530 };
    const limit     = limitMap[period] || 55;

    if (!HAS_KEY) {
      // Generate synthetic history from fallback
      const fb = FALLBACK.rate_30yr.value;
      const points = [];
      const pointCount = { "1yr":12,"3yr":36,"5yr":60,"10yr":120 }[period] || 12;
      for (let i = pointCount; i >= 0; i--) {
        const d = new Date(); d.setMonth(d.getMonth()-i);
        const val = +(fb + Math.sin(i*0.4)*0.8 + (i > 20 ? 1.2 : 0)).toFixed(2);
        points.push({ date: d.toISOString().split("T")[0], value: val });
      }
      return res.json({ series, period, live:false, data: points,
        min: Math.min(...points.map(p=>p.value)),
        max: Math.max(...points.map(p=>p.value)),
        current: points[points.length-1]?.value,
        start:   points[0]?.value,
      });
    }

    const { data } = await axios.get(FRED_BASE, {
      params: {
        series_id:         fredId,
        api_key:           FRED_API_KEY,
        file_type:         "json",
        sort_order:        "asc",
        observation_start: startStr,
        limit,
      },
      timeout: 15000,
    });

    const obs = data.observations
      .filter(o => o.value !== ".")
      .map(o => ({ date: o.date, value: parseFloat(o.value) }));

    // If ARM series, subtract spread
    const points = series === "arm"
      ? obs.map(o => ({ date: o.date, value: +(o.value - 0.55).toFixed(2) }))
      : obs;

    const values = points.map(p => p.value);
    res.json({
      series, period,
      live:    true,
      data:    points,
      min:     Math.min(...values),
      max:     Math.max(...values),
      current: values[values.length-1],
      start:   values[0],
      change:  +((values[values.length-1] - values[0]).toFixed(3)),
    });
  } catch(err) {
    console.error("rate-history error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// FEATURE 3: EMAIL RATE ALERTS
// POST /api/alerts/subscribe   — add alert
// DELETE /api/alerts/unsubscribe?email=x&token=y — remove
// POST /api/alerts/trigger     — internal: check and send (called by cron)
// GET  /api/alerts/verify?token=x — one-click unsubscribe link
// ─────────────────────────────────────────────

function makeToken(email) {
  // Simple deterministic token (not crypto — just for unsubscribe links)
  return Buffer.from(email + "ratecroft2026").toString("base64").replace(/[^a-zA-Z0-9]/g,"").slice(0,24);
}

app.post("/api/alerts/subscribe", async (req, res) => {
  try {
    const { email, targetRate, loanType="30yr", state="national", name="" } = req.body;
    if (!email || !email.includes("@")) return res.status(400).json({ error:"Valid email required" });
    if (!targetRate || isNaN(parseFloat(targetRate))) return res.status(400).json({ error:"Target rate required (e.g. 6.5)" });

    const alerts  = loadAlerts();
    const exists  = alerts.find(a => a.email === email && a.loanType === loanType);
    if (exists) {
      exists.targetRate = parseFloat(targetRate);
      exists.updatedAt  = new Date().toISOString();
      saveAlerts(alerts);
      return res.json({ success:true, message:"Alert updated", email, targetRate:parseFloat(targetRate) });
    }

    const token = makeToken(email);
    const alert = {
      id:         Date.now(),
      email,
      name:       name || email.split("@")[0],
      targetRate: parseFloat(targetRate),
      loanType,
      state,
      token,
      triggered:  false,
      createdAt:  new Date().toISOString(),
      updatedAt:  new Date().toISOString(),
    };
    alerts.push(alert);
    saveAlerts(alerts);

    // Send confirmation email
    if (HAS_SMTP) {
      const unsubUrl = `https://mortgagewise-production.up.railway.app/api/alerts/verify?token=${token}&action=unsubscribe`;
      await mailer.sendMail({
        from:    `"RateCroft Alerts" <${SMTP_USER}>`,
        to:      email,
        subject: `✅ Rate Alert Set — Notify me when ${loanType} hits ${targetRate}%`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
            <h2 style="color:#0a2540">🏠 RateCroft Rate Alert Confirmed</h2>
            <p>Hi ${alert.name},</p>
            <p>We'll email you when the <strong>${loanType} fixed mortgage rate</strong> drops to <strong>${targetRate}%</strong> or below.</p>
            <div style="background:#f1f5f9;border-radius:10px;padding:18px;margin:20px 0">
              <strong>Your Alert:</strong><br>
              📊 Loan Type: ${loanType}<br>
              🎯 Target Rate: ${targetRate}%<br>
              📍 Market: ${state === "national" ? "National Average" : state}
            </div>
            <p style="font-size:12px;color:#64748b">
              <a href="${unsubUrl}" style="color:#64748b">Unsubscribe</a> · RateCroft.com · Data: Federal Reserve
            </p>
          </div>`,
      });
    }

    res.json({ success:true, message:"Alert created! You'll be notified when rates hit your target.", email, targetRate:parseFloat(targetRate), token });
  } catch(err) {
    console.error("subscribe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/alerts/verify", (req, res) => {
  const { token, action } = req.query;
  if (action === "unsubscribe") {
    const alerts  = loadAlerts();
    const before  = alerts.length;
    const updated = alerts.filter(a => a.token !== token);
    saveAlerts(updated);
    const removed = before - updated.length;
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>✅ Unsubscribed</h2>
      <p>${removed > 0 ? "You've been removed from RateCroft rate alerts." : "Alert not found — may already be removed."}</p>
      <a href="https://ratecroft.com">← Back to RateCroft</a>
    </body></html>`);
  } else {
    res.status(400).send("Unknown action");
  }
});

app.delete("/api/alerts/unsubscribe", (req, res) => {
  const { email, token } = req.query;
  const alerts  = loadAlerts();
  const updated = alerts.filter(a => !(a.email === email && a.token === token));
  saveAlerts(updated);
  res.json({ success:true, removed: alerts.length - updated.length });
});

// Internal endpoint — call this from a daily cron job or scheduler
// POST /api/alerts/trigger  (no auth needed — Railway can call it via cron)
app.post("/api/alerts/trigger", async (req, res) => {
  try {
    const r30  = await fetchFredSeries(FRED_SERIES.rate_30yr);
    const r15  = await fetchFredSeries(FRED_SERIES.rate_15yr);
    const rArm = { value: +(r30.value - 0.55).toFixed(2) };

    const currentRates = { "30yr": r30.value, "15yr": r15.value, "arm51": rArm.value };
    const alerts    = loadAlerts();
    const triggered = [];
    let   emailsSent = 0;

    for (const alert of alerts) {
      const current = currentRates[alert.loanType] || r30.value;
      if (current <= alert.targetRate && !alert.triggered) {
        alert.triggered    = true;
        alert.triggeredAt  = new Date().toISOString();
        alert.triggeredRate = current;
        triggered.push(alert);

        if (HAS_SMTP) {
          const unsubUrl = `https://mortgagewise-production.up.railway.app/api/alerts/verify?token=${alert.token}&action=unsubscribe`;
          try {
            await mailer.sendMail({
              from:    `"RateCroft Alerts" <${SMTP_USER}>`,
              to:      alert.email,
              subject: `🔔 Rate Alert: ${alert.loanType} is now ${current}% — Your target reached!`,
              html: `
                <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
                  <h2 style="color:#0a2540">🎉 Your Rate Target Was Hit!</h2>
                  <p>Hi ${alert.name},</p>
                  <p>The <strong>${alert.loanType} mortgage rate</strong> has dropped to <strong>${current}%</strong> — below your target of <strong>${alert.targetRate}%</strong>.</p>
                  <div style="background:#e6f9f7;border-radius:10px;padding:18px;margin:20px 0;border-left:4px solid #00b8a0">
                    <strong>🎯 Rate Alert Triggered</strong><br><br>
                    Current Rate: <strong style="font-size:24px;color:#0a2540">${current}%</strong><br>
                    Your Target: ${alert.targetRate}%<br>
                    Loan Type: ${alert.loanType}
                  </div>
                  <p><strong>Act quickly</strong> — rates can change week to week. Lock your rate now by comparing lenders:</p>
                  <a href="https://ratecroft.com/todays-rates.html" style="display:inline-block;background:#00b8a0;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Compare Lenders Now →</a>
                  <p style="font-size:12px;color:#64748b;margin-top:24px">
                    <a href="${unsubUrl}" style="color:#64748b">Unsubscribe</a> · RateCroft.com
                  </p>
                </div>`,
            });
            emailsSent++;
          } catch(mailErr) {
            console.error("mail send failed:", mailErr.message);
          }
        }
      }
    }

    saveAlerts(alerts);
    res.json({
      success: true,
      currentRates,
      totalAlerts:     alerts.length,
      triggered:       triggered.length,
      emailsSent,
      timestamp:       new Date().toISOString(),
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alerts/count — show how many alerts are active (public, for social proof)
app.get("/api/alerts/count", (req, res) => {
  const alerts = loadAlerts();
  res.json({ count: alerts.length, active: alerts.filter(a=>!a.triggered).length });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🏠 RateCroft API  →  http://0.0.0.0:${PORT}`);
  console.log(`📡 Mode: ${HAS_KEY ? "LIVE (FRED API)" : "FALLBACK (no FRED key)"}\n`);
});
