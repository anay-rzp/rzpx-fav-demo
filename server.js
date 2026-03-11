require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_ACCOUNT_NUMBER,
  PORT = 3000,
} = process.env;

const isLiveMode = !!(
  RAZORPAY_KEY_ID &&
  RAZORPAY_KEY_SECRET &&
  RAZORPAY_ACCOUNT_NUMBER
);

const rzpx = isLiveMode
  ? axios.create({
      baseURL: "https://api.razorpay.com/v1",
      auth: { username: RAZORPAY_KEY_ID, password: RAZORPAY_KEY_SECRET },
      headers: { "Content-Type": "application/json" },
    })
  : null;

// ─── VPA handle → Bank metadata ────────────────────────────────────────────
const VPA_BANK_MAP = [
  {
    handles: ["okhdfcbank"],
    name: "HDFC Bank",
    ifscPrefix: "HDFC",
    color: "#004C8F",
  },
  {
    handles: ["okicici"],
    name: "ICICI Bank",
    ifscPrefix: "ICIC",
    color: "#B02A30",
  },
  {
    handles: ["oksbi"],
    name: "State Bank of India",
    ifscPrefix: "SBIN",
    color: "#22277A",
  },
  {
    handles: ["okaxis"],
    name: "Axis Bank",
    ifscPrefix: "UTIB",
    color: "#97144D",
  },
  {
    handles: ["ybl", "ibl", "axl"],
    name: "PhonePe (Yes Bank)",
    ifscPrefix: "YESB",
    color: "#5F259F",
  },
  {
    handles: ["paytm"],
    name: "Paytm Payments Bank",
    ifscPrefix: "PYTM",
    color: "#00BAF2",
  },
  {
    handles: ["kotak"],
    name: "Kotak Mahindra Bank",
    ifscPrefix: "KKBK",
    color: "#EE3224",
  },
  {
    handles: ["indus"],
    name: "IndusInd Bank",
    ifscPrefix: "INDB",
    color: "#006DB7",
  },
  { handles: ["rbl"], name: "RBL Bank", ifscPrefix: "RATN", color: "#E31837" },
  {
    handles: ["pnb"],
    name: "Punjab National Bank",
    ifscPrefix: "PUNB",
    color: "#FF6600",
  },
  {
    handles: ["federal"],
    name: "Federal Bank",
    ifscPrefix: "FDRL",
    color: "#003087",
  },
  {
    handles: ["idbi"],
    name: "IDBI Bank",
    ifscPrefix: "IBKL",
    color: "#00A651",
  },
  {
    handles: ["aubank"],
    name: "AU Small Finance Bank",
    ifscPrefix: "AUBL",
    color: "#E4002B",
  },
  {
    handles: ["icici"],
    name: "ICICI Bank",
    ifscPrefix: "ICIC",
    color: "#B02A30",
  },
  {
    handles: ["hdfc"],
    name: "HDFC Bank",
    ifscPrefix: "HDFC",
    color: "#004C8F",
  },
  {
    handles: ["sbi"],
    name: "State Bank of India",
    ifscPrefix: "SBIN",
    color: "#22277A",
  },
  {
    handles: ["axis"],
    name: "Axis Bank",
    ifscPrefix: "UTIB",
    color: "#97144D",
  },
  {
    handles: ["upi"],
    name: "BHIM UPI (SBI)",
    ifscPrefix: "SBIN",
    color: "#22277A",
  },
];

function getBankInfo(vpa) {
  const handle = (vpa.split("@")[1] || "").toLowerCase();
  for (const bank of VPA_BANK_MAP) {
    if (bank.handles.some((h) => handle.includes(h))) {
      return { ...bank, handle };
    }
  }
  return {
    name: handle ? `${handle.toUpperCase()} Bank` : "Unknown Bank",
    ifscPrefix: "UNKN",
    color: "#6B7280",
    handle,
  };
}

// ─── Poll composite FAV until terminal status ────────────────────────────────
async function pollValidation(validationId, maxAttempts = 12, delayMs = 2500) {
  for (let i = 0; i < maxAttempts; i++) {
    const { data } = await rzpx.get(
      `/fund_accounts/validations/${validationId}`,
    );
    if (data.status === "completed" || data.status === "failed") {
      return data;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Validation polling timed out — please try again.");
}

// ─── POST /api/validate ──────────────────────────────────────────────────────
app.post("/api/validate", async (req, res) => {
  const { type, value, name, email, phone } = req.body;

  if (!type || !value) {
    return res.status(400).json({ error: "type and value are required" });
  }
  if (type !== "upi" && type !== "phone") {
    return res.status(400).json({ error: "type must be 'upi' or 'phone'" });
  }

  const vpaAddress =
    type === "upi" ? value.trim().toLowerCase() : `${value.trim()}@upi`;

  // ── DEMO MODE ──
  if (!isLiveMode) {
    return serveDemoResponse(vpaAddress, name, res);
  }

  // ── LIVE MODE — Composite FAV (single API call) ──
  try {
    const { data: initialValidation } = await rzpx.post(
      "/fund_accounts/validations",
      {
        source_account_number: RAZORPAY_ACCOUNT_NUMBER,
        reference_id: `loan_${Date.now()}`,
        notes: { purpose: "Bank Account Verification" },
        validation_type: "pennydrop",
        fund_account: {
          account_type: "vpa",
          vpa: { address: vpaAddress },
          contact: {
            name: name || "Loan Applicant",
            email: email || "applicant@lendbridge.in",
            contact: phone || value,
            type: "employee",
            reference_id: `ref_${Date.now()}`,
            notes: { purpose: "Loan Application — Bank Verification" },
          },
        },
      },
    );

    const validation =
      initialValidation.status === "completed" ||
      initialValidation.status === "failed"
        ? initialValidation
        : await pollValidation(initialValidation.id);

    const results = validation.validation_results || {};
    const bankAccount = results.bank_account || {};
    const bankInfo = getBankInfo(vpaAddress);
    const accountStatus = results.account_status || "unknown";

    return res.json({
      success: true,
      demo: false,
      data: {
        vpa: vpaAddress,
        bankName: bankAccount.bank_name || bankInfo.name,
        bankColor: bankInfo.color,
        registeredName: results.registered_name || name || "Account Holder",
        accountNumber: bankAccount.account_number || null,
        accountType: bankAccount.account_type || null,
        upiInstrument: results.validated_account_type || null,
        ifscCode: bankAccount.bank_routing_code || null,
        accountStatus,
        accountVerified: accountStatus === "active",
        fundAccountId: validation.fund_account?.id || null,
        validationId: validation.id,
        utr: validation.utr || null,
      },
    });
  } catch (err) {
    console.error("RazorpayX API error:", err.response?.data || err.message);

    const apiError = err.response?.data?.error;
    const message =
      apiError?.description ||
      err.message ||
      "Validation failed — please check the UPI ID / phone and retry.";

    return res.status(err.response?.status || 500).json({
      error: message,
      code: apiError?.code,
    });
  }
});

// ─── POST /api/validate-rpd — initiate reverse penny drop ────────────────────
app.post("/api/validate-rpd", async (req, res) => {
  if (!isLiveMode) {
    return res.json({
      success: true,
      demo: true,
      favId: "fav_demo_" + Math.random().toString(36).slice(2, 11),
      intentUrl: null,
      phonepeUrl: null,
      gpayUrl: null,
      paytmUrl: null,
      bhimUrl: null,
      qrCode: null,
    });
  }

  try {
    const { data } = await rzpx.post("/fund_accounts/validations", {
      source_account_number: RAZORPAY_ACCOUNT_NUMBER,
      validation_type: "upi_intent",
      reference_id: `rpd_${Date.now()}`,
      notes: { purpose: "Reverse Penny Drop — Bank Verification" },
    });

    const intent = data.upi_intent || {};
    return res.json({
      success: true,
      demo: false,
      favId: data.id,
      intentUrl: intent.intent_url || null,
      phonepeUrl: intent.phonepe_url || null,
      gpayUrl: intent.gpay_url || null,
      paytmUrl: intent.paytm_url || null,
      bhimUrl: intent.bhim_url || null,
      qrCode: intent.encoded_qr_code || null,
    });
  } catch (err) {
    console.error("RPD initiation error:", err.response?.data || err.message);
    const apiError = err.response?.data?.error;
    return res.status(err.response?.status || 500).json({
      error:
        apiError?.description ||
        err.message ||
        "Failed to initiate verification.",
      code: apiError?.code,
    });
  }
});

// ─── GET /api/validate-rpd/:id — poll RPD status ─────────────────────────────
app.get("/api/validate-rpd/:id", async (req, res) => {
  if (!isLiveMode) {
    return res.json({ success: true, demo: true, status: "created" });
  }

  try {
    const { data } = await rzpx.get(
      `/fund_accounts/validations/${req.params.id}`,
    );

    if (data.status !== "completed" && data.status !== "failed") {
      return res.json({ success: true, status: data.status });
    }

    const results = data.validation_results || {};
    const bankAccount = results.bank_account || {};
    const upiVpa = results.upi_intent?.vpa || null;
    const bankInfo = upiVpa
      ? getBankInfo(upiVpa)
      : { name: bankAccount.bank_name || "Unknown Bank", color: "#6B7280" };
    const accountStatus = results.account_status || "unknown";

    return res.json({
      success: true,
      status: data.status,
      data: {
        vpa: upiVpa,
        bankName: bankAccount.bank_name || bankInfo.name,
        bankColor: bankInfo.color,
        registeredName: results.registered_name || "Account Holder",
        accountNumber: bankAccount.account_number || null,
        accountType: bankAccount.account_type || null,
        upiInstrument: results.validated_account_type || null,
        ifscCode: bankAccount.bank_routing_code || null,
        accountStatus,
        accountVerified: accountStatus === "active",
        validationId: data.id,
        utr: data.utr || null,
      },
    });
  } catch (err) {
    console.error("RPD poll error:", err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || "Failed to check verification status.",
    });
  }
});

// ─── GET /api/config ─────────────────────────────────────────────────────────
app.get("/api/config", (_req, res) => {
  res.json({ demo: !isLiveMode });
});

// ─── Demo mode response with realistic mock data ─────────────────────────────
function serveDemoResponse(vpaAddress, name, res) {
  const bankInfo = getBankInfo(vpaAddress);
  const handle = (vpaAddress.split("@")[1] || "upi").toLowerCase();

  const MOCK_ACCOUNTS = {
    okhdfcbank: {
      accountNo: "50100123456789",
      ifsc: "HDFC0001234",
      branch: "Connaught Place, Delhi",
    },
    okicici: {
      accountNo: "123456789012",
      ifsc: "ICIC0002345",
      branch: "MG Road, Bangalore",
    },
    oksbi: {
      accountNo: "30987654321",
      ifsc: "SBIN0003456",
      branch: "Bandra, Mumbai",
    },
    okaxis: {
      accountNo: "917010234567",
      ifsc: "UTIB0004567",
      branch: "Anna Nagar, Chennai",
    },
    ybl: {
      accountNo: "100012345678",
      ifsc: "YESB0000001",
      branch: "Koregaon Park, Pune",
    },
    ibl: {
      accountNo: "456789012345",
      ifsc: "ICIC0005678",
      branch: "Baner, Pune",
    },
    paytm: {
      accountNo: "9123456789",
      ifsc: "PYTM0123456",
      branch: "Sector 62, Noida",
    },
    kotak: {
      accountNo: "7312345678",
      ifsc: "KKBK0006789",
      branch: "Jubilee Hills, Hyderabad",
    },
    upi: {
      accountNo: "9876543210",
      ifsc: "SBIN0007890",
      branch: "Sector 17, Chandigarh",
    },
  };

  let mockAccount = null;
  for (const [key, data] of Object.entries(MOCK_ACCOUNTS)) {
    if (handle.includes(key)) {
      mockAccount = data;
      break;
    }
  }
  if (!mockAccount) {
    const rand = Math.floor(Math.random() * 9000) + 1000;
    mockAccount = {
      accountNo: `7800${rand}${rand}`,
      ifsc: `${bankInfo.ifscPrefix}0001234`,
      branch: "Main Branch",
    };
  }

  const raw = mockAccount.accountNo;
  const masked =
    raw.slice(0, 2) + "X".repeat(Math.max(0, raw.length - 6)) + raw.slice(-4);

  setTimeout(() => {
    res.json({
      success: true,
      demo: true,
      data: {
        vpa: vpaAddress,
        bankName: bankInfo.name,
        bankColor: bankInfo.color,
        registeredName: name || "Rahul Kumar",
        accountNumber: masked,
        ifscCode: mockAccount.ifsc,
        branchName: mockAccount.branch,
        accountType: "saving",
        upiInstrument: "bank account",
        accountStatus: "active",
        accountVerified: true,
        fundAccountId: "fa_demo_" + Math.random().toString(36).slice(2, 11),
        validationId: "fav_demo_" + Math.random().toString(36).slice(2, 11),
      },
    });
  }, 2200);
}

// ─── Start (local dev only) ───────────────────────────────────────────────────
if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`\n  RazorpayX FAV Demo  →  http://localhost:${PORT}`);
    console.log(
      `  Mode: ${isLiveMode ? "Live (RazorpayX APIs active)" : "Demo (mock data — configure .env for live)"}\n`,
    );
  });
}

// ─── Export for Vercel ────────────────────────────────────────────────────────
module.exports = app;
